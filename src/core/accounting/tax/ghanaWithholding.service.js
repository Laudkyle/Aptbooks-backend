const { pool } = require('../../../db/pool');
const { withTransaction } = require('../../../db/tx');
const { AppError } = require('../../../shared/errors/AppError');
const journalIF = require('../../../interfaces/journalPosting.interface');
const periodIF = require('../../../interfaces/periodManagement.interface');
const {
  parseDecimalToBigInt,
  bigIntToDecimalString,
  divideAndRoundHalfUp,
} = require('../../../shared/utils/money');
const {
  calculateIncomeWithholding,
  calculateVatWithholding,
  withholdingDueDate,
  taxYearFor,
} = require('../../../shared/tax/ghanaWithholding');

function money(value) {
  return bigIntToDecimalString(parseDecimalToBigInt(value ?? '0', 2), 2);
}

function proportionalAmount(amount, numerator, denominator) {
  const a = parseDecimalToBigInt(amount ?? '0', 2);
  const n = parseDecimalToBigInt(numerator ?? '0', 2);
  const d = parseDecimalToBigInt(denominator ?? '0', 2);
  if (a === 0n || n === 0n || d <= 0n) return '0.00';
  return bigIntToDecimalString(divideAndRoundHalfUp(a * n, d), 2);
}

async function getSettings({ orgId, client = null }) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT ts.*, o.base_currency_code
       FROM tax_settings ts
       JOIN organizations o ON o.id=ts.organization_id
      WHERE ts.organization_id=$1`,
    [orgId],
  );
  if (!rows.length) throw new AppError(404, 'Tax settings not found');
  return rows[0];
}

async function getPartnerProfile({ orgId, partnerId, client = null }) {
  if (!partnerId) return null;
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT p.id,p.name,p.tax_id,
            tp.tax_registration_no,tp.is_tax_registered,tp.is_tax_exempt,
            tp.withholding_applicable,tp.withholding_tax_code_id,tp.withholding_rate_override,
            tp.residency_status,tp.withholding_exempt,tp.withholding_exemption_reference,
            tp.withholding_exemption_expiry,tp.default_withholding_category,tp.vat_withholding_eligible
       FROM business_partners p
       LEFT JOIN tax_partner_profiles tp ON tp.organization_id=p.organization_id AND tp.partner_id=p.id
      WHERE p.organization_id=$1 AND p.id=$2`,
    [orgId, partnerId],
  );
  return rows[0] || null;
}

async function getTaxCode({ orgId, taxCodeId = null, code = null, client = null }) {
  const db = client || pool;
  const params = [orgId];
  let where = 'organization_id=$1';
  if (taxCodeId) { params.push(taxCodeId); where += ` AND id=$${params.length}`; }
  if (code) { params.push(code); where += ` AND code=$${params.length}`; }
  const { rows } = await db.query(`SELECT * FROM tax_codes WHERE ${where} LIMIT 1`, params);
  return rows[0] || null;
}

async function getDashboard({ orgId, fromDate = null, toDate = null }) {
  const params = [orgId];
  const filters = [];
  if (fromDate) { params.push(fromDate); filters.push(`event_date >= $${params.length}::date`); }
  if (toDate) { params.push(toDate); filters.push(`event_date <= $${params.length}::date`); }
  const extra = filters.length ? ` AND ${filters.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT regime,direction,status,
            COUNT(*)::int AS event_count,
            COALESCE(SUM(taxable_basis),0)::numeric(18,2) AS taxable_basis,
            COALESCE(SUM(withheld_amount),0)::numeric(18,2) AS withheld_amount
       FROM ghana_withholding_events
      WHERE organization_id=$1 AND status<>'voided' ${extra}
      GROUP BY regime,direction,status ORDER BY regime,direction,status`,
    params,
  );
  const { rows: returnRows } = await pool.query(
    `SELECT regime,status,COUNT(*)::int AS return_count,MIN(due_date) FILTER (WHERE status IN ('draft','finalized')) AS next_due_date
       FROM ghana_withholding_returns WHERE organization_id=$1 AND status<>'voided' GROUP BY regime,status ORDER BY regime,status`,
    [orgId],
  );
  const { rows: thresholdRows } = await pool.query(
    `SELECT COUNT(*)::int AS vendors_over_threshold
       FROM (
         SELECT partner_id,tax_year,category_code,SUM(gross_amount) AS total
           FROM ghana_withholding_events
          WHERE organization_id=$1 AND regime='income_wht' AND status<>'voided'
          GROUP BY partner_id,tax_year,category_code
         HAVING SUM(gross_amount) > COALESCE(MAX(threshold_amount),2000)
       ) x`,
    [orgId],
  );
  return { eventSummary: rows, returnSummary: returnRows, vendorsOverThreshold: thresholdRows[0]?.vendors_over_threshold || 0 };
}

async function getReconciliation({ orgId, toDate = null }) {
  const settings = await getSettings({ orgId });
  const effectiveTo = toDate || new Date().toISOString().slice(0,10);
  const regimes = [
    ['income_wht', settings.withholding_tax_payable_account_id],
    ['vat_withholding', settings.vat_withholding_payable_account_id],
  ];
  const results = [];
  for (const [regime, accountId] of regimes) {
    const { rows: eventRows } = await pool.query(
      `SELECT COALESCE(SUM(withheld_amount),0)::numeric(18,2) AS open_amount
         FROM ghana_withholding_events
        WHERE organization_id=$1 AND regime=$2 AND direction='payable' AND status='open' AND event_date <= $3::date`,
      [orgId,regime,effectiveTo],
    );
    let glBalance = '0.00';
    if (accountId) {
      const { rows: glRows } = await pool.query(
        `SELECT COALESCE(SUM(jel.credit-jel.debit),0)::numeric(18,2) AS balance
           FROM journal_entries je
           JOIN journal_entry_lines jel ON jel.journal_entry_id=je.id
          WHERE je.organization_id=$1 AND jel.account_id=$2 AND je.status IN ('posted','voided') AND je.entry_date <= $3::date`,
        [orgId,accountId,effectiveTo],
      );
      glBalance = glRows[0]?.balance || '0.00';
    }
    const eventCents = parseDecimalToBigInt(eventRows[0]?.open_amount || '0',2);
    const glCents = parseDecimalToBigInt(glBalance || '0',2);
    results.push({
      regime,
      payableAccountId: accountId || null,
      openWithholdingEvents: bigIntToDecimalString(eventCents,2),
      glControlBalance: bigIntToDecimalString(glCents,2),
      variance: bigIntToDecimalString(glCents-eventCents,2),
      reconciled: glCents === eventCents,
      note: regime === 'income_wht' ? 'Legacy bill-level withholding can create timing differences until all affected payments are captured.' : null,
    });
  }
  return { asOf: effectiveTo, regimes: results };
}

async function listRateCatalog({ orgId }) {
  const { rows } = await pool.query(
    `SELECT id,code,name,rate,reporting_group,metadata,withholding_regime,withholding_treatment,
            threshold_basis,threshold_amount,effective_from,effective_to,status
       FROM tax_codes
      WHERE organization_id=$1 AND withholding_regime IN ('income_wht','vat_withholding')
      ORDER BY withholding_regime,reporting_group,rate,code`,
    [orgId],
  );
  return rows;
}

async function priorQualifyingPayments({ orgId, partnerId, taxYear, categoryCode, excludeEventKey = null, client = null }) {
  const db = client || pool;
  const params = [orgId, partnerId, taxYear, categoryCode || ''];
  let extra = '';
  if (excludeEventKey) { params.push(excludeEventKey); extra = ` AND event_key<>$${params.length}`; }
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(gross_amount),0)::numeric(18,2) AS amount
       FROM ghana_withholding_events
      WHERE organization_id=$1 AND partner_id=$2 AND tax_year=$3
        AND regime='income_wht' AND status<>'voided'
        AND COALESCE(category_code,'')=$4 ${extra}`,
    params,
  );
  return rows[0]?.amount || '0.00';
}

async function getThresholdPosition({ orgId, partnerId, categoryCode, date }) {
  const year = taxYearFor(date || new Date().toISOString().slice(0, 10));
  const settings = await getSettings({ orgId });
  const amount = await priorQualifyingPayments({ orgId, partnerId, taxYear: year, categoryCode });
  const threshold = settings.gh_wht_annual_threshold || '2000.00';
  const amountCents = parseDecimalToBigInt(amount, 2);
  const thresholdCents = parseDecimalToBigInt(threshold, 2);
  return {
    partnerId,
    categoryCode: categoryCode || null,
    taxYear: year,
    qualifyingPayments: money(amount),
    thresholdAmount: money(threshold),
    remainingAmount: bigIntToDecimalString(thresholdCents > amountCents ? thresholdCents - amountCents : 0n, 2),
    thresholdMet: amountCents > thresholdCents,
  };
}

async function preview({ orgId, payload }) {
  const settings = await getSettings({ orgId });
  const partner = await getPartnerProfile({ orgId, partnerId: payload.partnerId });
  if (!partner) throw new AppError(404, 'Business partner not found');

  if (payload.regime === 'vat_withholding') {
    const result = calculateVatWithholding({
      taxableValue: payload.taxableValue,
      rate: settings.gh_vat_withholding_rate || '7.000000',
      isWithholdingAgent: settings.gh_vat_withholding_agent_enabled,
      supplierVatRegistered: partner.is_tax_registered !== false,
      standardRatedSupply: payload.standardRatedSupply !== false,
      exempt: partner.is_tax_exempt === true || partner.vat_withholding_eligible === false,
    });
    return { regime: 'vat_withholding', partner, ...result };
  }

  let taxCode = null;
  if (payload.taxCodeId) taxCode = await getTaxCode({ orgId, taxCodeId: payload.taxCodeId });
  if (!taxCode && partner.withholding_tax_code_id) taxCode = await getTaxCode({ orgId, taxCodeId: partner.withholding_tax_code_id });
  if (!taxCode) throw new AppError(400, 'An income withholding tax code is required');
  if (taxCode.withholding_regime && taxCode.withholding_regime !== 'income_wht') throw new AppError(400, 'Selected tax code is not an income withholding code');

  const eventDate = payload.eventDate || new Date().toISOString().slice(0, 10);
  const year = taxYearFor(eventDate);
  const category = payload.categoryCode || partner.default_withholding_category || taxCode.reporting_group || taxCode.code;
  const prior = await priorQualifyingPayments({ orgId, partnerId: payload.partnerId, taxYear: year, categoryCode: category });
  const exempt = partner.withholding_exempt === true && (!partner.withholding_exemption_expiry || String(partner.withholding_exemption_expiry) >= eventDate);
  const result = calculateIncomeWithholding({
    paymentAmount: payload.paymentAmount,
    rate: partner.withholding_rate_override || taxCode.rate,
    priorQualifyingPayments: prior,
    thresholdAmount: taxCode.threshold_amount ?? settings.gh_wht_annual_threshold,
    thresholdBasis: taxCode.threshold_basis || 'none',
    exempt,
    treatment: taxCode.withholding_treatment || 'creditable',
  });
  return { regime: 'income_wht', partner, taxCode, categoryCode: category, taxYear: year, ...result };
}

async function nextCertificateNo(client, orgId, regime, eventDate) {
  const y = taxYearFor(eventDate);
  const prefix = regime === 'vat_withholding' ? 'WHVAT' : 'WHT';
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM ghana_withholding_certificates
      WHERE organization_id=$1 AND regime=$2 AND EXTRACT(YEAR FROM certificate_date)=$3`,
    [orgId, regime, y],
  );
  return `${prefix}-${y}-${String((rows[0]?.n || 0) + 1).padStart(6, '0')}`;
}

async function recordEvent({ orgId, actorUserId, payload, client = null }) {
  const run = async (db) => {
    const previewResult = await previewWithClient({ orgId, payload, client: db });
    const eventKey = payload.eventKey || `${payload.sourceType || 'manual'}:${payload.sourceId || 'manual'}:${payload.sourceLineId || payload.partnerId}:${payload.regime}:${payload.categoryCode || previewResult.categoryCode || 'default'}`;
    const rate = previewResult.rate || previewResult.taxCode?.rate || '0';
    const grossAmount = payload.regime === 'vat_withholding' ? previewResult.taxableValue : previewResult.paymentAmount;
    const taxableBasis = previewResult.taxableBasis || previewResult.taxableValue || '0.00';
    const withheldAmount = previewResult.withheldAmount || '0.00';

    const { rows } = await db.query(
      `INSERT INTO ghana_withholding_events(
         organization_id,event_key,regime,direction,partner_id,source_type,source_id,source_line_id,source_document_no,event_date,tax_year,
         category_code,tax_code_id,gross_amount,prior_cumulative_amount,cumulative_amount,threshold_amount,threshold_basis,
         taxable_basis,tax_rate,withheld_amount,withholding_treatment,status,metadata,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'open',$23::jsonb,$24)
       ON CONFLICT (organization_id,event_key) DO UPDATE SET updated_at=NOW()
       RETURNING *`,
      [
        orgId,eventKey,payload.regime,payload.direction || 'payable',payload.partnerId,payload.sourceType || 'manual',payload.sourceId || null,payload.sourceLineId || null,
        payload.sourceDocumentNo || null,payload.eventDate,previewResult.taxYear || taxYearFor(payload.eventDate),payload.categoryCode || previewResult.categoryCode || null,
        previewResult.taxCode?.id || payload.taxCodeId || null,money(grossAmount),previewResult.priorQualifyingPayments || '0.00',previewResult.cumulativeQualifyingPayments || money(grossAmount),
        previewResult.thresholdAmount || null,previewResult.thresholdBasis || 'none',money(taxableBasis),String(rate),money(withheldAmount),
        previewResult.treatment || 'creditable',JSON.stringify({ preview: previewResult.reason || previewResult.thresholdStatus || null, ...(payload.metadata || {}) }),actorUserId || null,
      ],
    );
    const event = rows[0];

    if (parseDecimalToBigInt(event.withheld_amount, 2) > 0n && (payload.direction || 'payable') === 'payable') {
      const certNo = await nextCertificateNo(db, orgId, payload.regime, payload.eventDate);
      await db.query(
        `INSERT INTO ghana_withholding_certificates(
           organization_id,event_id,regime,certificate_role,certificate_no,certificate_date,partner_id,taxable_basis,withheld_amount,status,metadata,created_by
         ) VALUES ($1,$2,$3,'issued',$4,$5,$6,$7,$8,'issued',$9::jsonb,$10)
         ON CONFLICT (organization_id,event_id,certificate_role) DO NOTHING`,
        [orgId,event.id,payload.regime,certNo,payload.eventDate,payload.partnerId,event.taxable_basis,event.withheld_amount,JSON.stringify({ autoIssued: true }),actorUserId || null],
      );
      const { rows: certRows } = await db.query(
        `SELECT certificate_no,certificate_date FROM ghana_withholding_certificates WHERE organization_id=$1 AND event_id=$2 AND certificate_role='issued'`,
        [orgId,event.id],
      );
      if (certRows[0]) {
        await db.query(`UPDATE ghana_withholding_events SET certificate_no=$3,certificate_date=$4,updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId,event.id,certRows[0].certificate_no,certRows[0].certificate_date]);
        event.certificate_no = certRows[0].certificate_no;
        event.certificate_date = certRows[0].certificate_date;
      }
    }
    return event;
  };
  return client ? run(client) : withTransaction(run);
}

async function previewWithClient({ orgId, payload, client }) {
  const settings = await getSettings({ orgId, client });
  const partner = await getPartnerProfile({ orgId, partnerId: payload.partnerId, client });
  if (!partner) throw new AppError(404, 'Business partner not found');
  if (payload.regime === 'vat_withholding') {
    const result = calculateVatWithholding({
      taxableValue: payload.taxableValue,
      rate: settings.gh_vat_withholding_rate || '7.000000',
      isWithholdingAgent: settings.gh_vat_withholding_agent_enabled,
      supplierVatRegistered: partner.is_tax_registered !== false,
      standardRatedSupply: payload.standardRatedSupply !== false,
      exempt: partner.is_tax_exempt === true || partner.vat_withholding_eligible === false,
    });
    return { regime: 'vat_withholding', partner, taxYear: taxYearFor(payload.eventDate), ...result };
  }
  let taxCode = payload.taxCodeId ? await getTaxCode({ orgId, taxCodeId: payload.taxCodeId, client }) : null;
  if (!taxCode && partner.withholding_tax_code_id) taxCode = await getTaxCode({ orgId, taxCodeId: partner.withholding_tax_code_id, client });
  if (!taxCode) throw new AppError(400, 'An income withholding tax code is required');
  const year = taxYearFor(payload.eventDate);
  const category = payload.categoryCode || partner.default_withholding_category || taxCode.reporting_group || taxCode.code;
  const eventKey = payload.eventKey || null;
  const prior = await priorQualifyingPayments({ orgId, partnerId: payload.partnerId, taxYear: year, categoryCode: category, excludeEventKey: eventKey, client });
  const exempt = partner.withholding_exempt === true && (!partner.withholding_exemption_expiry || String(partner.withholding_exemption_expiry) >= payload.eventDate);
  return {
    regime: 'income_wht', partner, taxCode, categoryCode: category, taxYear: year,
    ...calculateIncomeWithholding({
      paymentAmount: payload.paymentAmount,
      rate: partner.withholding_rate_override || taxCode.rate,
      priorQualifyingPayments: prior,
      thresholdAmount: taxCode.threshold_amount ?? settings.gh_wht_annual_threshold,
      thresholdBasis: taxCode.threshold_basis || 'none',
      exempt,
      treatment: taxCode.withholding_treatment || 'creditable',
    }),
  };
}

async function listEvents({ orgId, query = {} }) {
  const params = [orgId];
  const where = ['e.organization_id=$1'];
  for (const [key, col] of [['regime','e.regime'],['direction','e.direction'],['partnerId','e.partner_id'],['status','e.status']]) {
    if (query[key]) { params.push(query[key]); where.push(`${col}=$${params.length}`); }
  }
  if (query.fromDate) { params.push(query.fromDate); where.push(`e.event_date >= $${params.length}::date`); }
  if (query.toDate) { params.push(query.toDate); where.push(`e.event_date <= $${params.length}::date`); }
  const { rows } = await pool.query(
    `SELECT e.*,bp.name AS partner_name,tc.code AS tax_code,tc.name AS tax_code_name
       FROM ghana_withholding_events e
       LEFT JOIN business_partners bp ON bp.id=e.partner_id
       LEFT JOIN tax_codes tc ON tc.id=e.tax_code_id
      WHERE ${where.join(' AND ')} ORDER BY e.event_date DESC,e.created_at DESC LIMIT 1000`,
    params,
  );
  return rows;
}

async function recordReceivedCertificate({ orgId, actorUserId, payload }) {
  return withTransaction(async (client) => {
    const partner = await getPartnerProfile({ orgId, partnerId: payload.partnerId, client });
    if (!partner) throw new AppError(404, 'Business partner not found');

    const eventDate = payload.eventDate || payload.certificateDate;
    const eventKey = `received_certificate:${payload.regime}:${String(payload.certificateNo).trim().toUpperCase()}`;
    const taxCode = payload.taxCodeId ? await getTaxCode({ orgId, taxCodeId: payload.taxCodeId, client }) :
      (payload.regime === 'vat_withholding' ? await getTaxCode({ orgId, code: 'GH_WHVAT_7', client }) : null);

    if (payload.regime === 'vat_withholding' && taxCode && taxCode.withholding_regime !== 'vat_withholding') {
      throw new AppError(400, 'Selected tax code is not a VAT withholding code');
    }
    if (payload.regime === 'income_wht' && taxCode && taxCode.withholding_regime && taxCode.withholding_regime !== 'income_wht') {
      throw new AppError(400, 'Selected tax code is not an income withholding code');
    }

    const taxableBasis = money(payload.taxableBasis);
    const withheldAmount = money(payload.withheldAmount);
    const { rows: eventRows } = await client.query(
      `INSERT INTO ghana_withholding_events(
         organization_id,event_key,regime,direction,partner_id,source_type,source_id,source_document_no,event_date,tax_year,
         category_code,tax_code_id,gross_amount,prior_cumulative_amount,cumulative_amount,threshold_amount,threshold_basis,
         taxable_basis,tax_rate,withheld_amount,withholding_treatment,status,certificate_no,certificate_date,metadata,created_by
       ) VALUES ($1,$2,$3,'receivable',$4,$5,$6,$7,$8,$9,$10,$11,$12,0,$12,NULL,'none',$12,$13,$14,'creditable','open',$15,$16,$17::jsonb,$18)
       ON CONFLICT (organization_id,event_key) DO UPDATE SET updated_at=NOW()
       RETURNING *`,
      [
        orgId,eventKey,payload.regime,payload.partnerId,payload.sourceType || 'withholding_certificate',payload.sourceId || null,
        payload.sourceDocumentNo || null,eventDate,taxYearFor(eventDate),payload.categoryCode || taxCode?.reporting_group || taxCode?.code || null,
        taxCode?.id || null,taxableBasis,String(payload.taxRate),withheldAmount,payload.certificateNo,payload.certificateDate,
        JSON.stringify({ graReference: payload.graReference || null, ...(payload.metadata || {}) }),actorUserId || null,
      ],
    );
    const event = eventRows[0];

    const { rows: certRows } = await client.query(
      `INSERT INTO ghana_withholding_certificates(
         organization_id,event_id,regime,certificate_role,certificate_no,certificate_date,partner_id,taxable_basis,withheld_amount,status,gra_reference,metadata,created_by
       ) VALUES ($1,$2,$3,'received',$4,$5,$6,$7,$8,'issued',$9,$10::jsonb,$11)
       ON CONFLICT (organization_id,event_id,certificate_role) DO UPDATE SET
         certificate_no=EXCLUDED.certificate_no,certificate_date=EXCLUDED.certificate_date,gra_reference=EXCLUDED.gra_reference,metadata=EXCLUDED.metadata,updated_at=NOW()
       RETURNING *`,
      [orgId,event.id,payload.regime,payload.certificateNo,payload.certificateDate,payload.partnerId,taxableBasis,withheldAmount,payload.graReference || null,JSON.stringify(payload.metadata || {}),actorUserId || null],
    );

    return { event, certificate: certRows[0] };
  });
}

async function listCertificates({ orgId, query = {} }) {
  const params = [orgId];
  const where = ['c.organization_id=$1'];
  if (query.regime) { params.push(query.regime); where.push(`c.regime=$${params.length}`); }
  if (query.partnerId) { params.push(query.partnerId); where.push(`c.partner_id=$${params.length}`); }
  const { rows } = await pool.query(
    `SELECT c.*,bp.name AS partner_name,e.source_document_no,e.event_date
       FROM ghana_withholding_certificates c
       LEFT JOIN business_partners bp ON bp.id=c.partner_id
       JOIN ghana_withholding_events e ON e.id=c.event_id
      WHERE ${where.join(' AND ')} ORDER BY c.certificate_date DESC,c.created_at DESC`,
    params,
  );
  return rows;
}

async function prepareReturn({ orgId, actorUserId, payload }) {
  return withTransaction(async (client) => {
    const formCode = payload.regime === 'vat_withholding' ? 'WHVAT' : 'DT110';
    const dueDate = withholdingDueDate(payload.periodEnd);
    const { rows: versionRows } = await client.query(
      `SELECT COALESCE(MAX(version_no),0)::int+1 AS version_no FROM ghana_withholding_returns
        WHERE organization_id=$1 AND regime=$2 AND period_start=$3 AND period_end=$4`,
      [orgId,payload.regime,payload.periodStart,payload.periodEnd],
    );
    const versionNo = versionRows[0].version_no;
    const { rows: retRows } = await client.query(
      `INSERT INTO ghana_withholding_returns(organization_id,regime,form_code,period_start,period_end,due_date,status,version_no,amends_return_id,created_by,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10::jsonb) RETURNING *`,
      [orgId,payload.regime,formCode,payload.periodStart,payload.periodEnd,dueDate,versionNo,payload.amendsReturnId || null,actorUserId || null,JSON.stringify(payload.metadata || {})],
    );
    const ret = retRows[0];
    await client.query(
      `INSERT INTO ghana_withholding_return_lines(
         organization_id,return_id,event_id,partner_id,partner_tax_identifier,source_document_no,event_date,category_code,taxable_basis,tax_rate,withheld_amount,certificate_no,metadata
       )
       SELECT e.organization_id,$2,e.id,e.partner_id,COALESCE(tp.tax_registration_no,bp.tax_id),e.source_document_no,e.event_date,e.category_code,e.taxable_basis,e.tax_rate,e.withheld_amount,e.certificate_no,e.metadata
         FROM ghana_withholding_events e
         LEFT JOIN business_partners bp ON bp.id=e.partner_id
         LEFT JOIN tax_partner_profiles tp ON tp.organization_id=e.organization_id AND tp.partner_id=e.partner_id
        WHERE e.organization_id=$1 AND e.regime=$3 AND e.direction='payable' AND e.status<>'voided'
          AND e.withheld_amount>0 AND e.event_date BETWEEN $4 AND $5
          AND ($6::uuid IS NOT NULL OR e.return_id IS NULL)`,
      [orgId,ret.id,payload.regime,payload.periodStart,payload.periodEnd,payload.amendsReturnId || null],
    );
    const { rows: totals } = await client.query(
      `SELECT COALESCE(SUM(taxable_basis),0)::numeric(18,2) AS base,COALESCE(SUM(withheld_amount),0)::numeric(18,2) AS withheld
         FROM ghana_withholding_return_lines WHERE return_id=$1`,
      [ret.id],
    );
    const { rows: updated } = await client.query(
      `UPDATE ghana_withholding_returns SET total_taxable_basis=$3,total_withheld=$4,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId,ret.id,totals[0].base,totals[0].withheld],
    );
    return updated[0];
  });
}

async function listReturns({ orgId, query = {} }) {
  const params = [orgId];
  const where = ['organization_id=$1'];
  if (query.regime) { params.push(query.regime); where.push(`regime=$${params.length}`); }
  const { rows } = await pool.query(`SELECT * FROM ghana_withholding_returns WHERE ${where.join(' AND ')} ORDER BY period_end DESC,version_no DESC`, params);
  return rows;
}

async function getReturn({ orgId, returnId }) {
  const { rows } = await pool.query(`SELECT * FROM ghana_withholding_returns WHERE organization_id=$1 AND id=$2`, [orgId,returnId]);
  if (!rows.length) throw new AppError(404, 'Withholding return not found');
  const { rows: lines } = await pool.query(`SELECT * FROM ghana_withholding_return_lines WHERE organization_id=$1 AND return_id=$2 ORDER BY event_date,source_document_no`, [orgId,returnId]);
  return { ...rows[0], lines };
}

async function finalizeReturn({ orgId, returnId, actorUserId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM ghana_withholding_returns WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId,returnId]);
    if (!rows.length) throw new AppError(404, 'Withholding return not found');
    if (rows[0].status !== 'draft') throw new AppError(409, 'Only draft withholding returns can be finalized');
    const { rows: identifierIssues } = await client.query(
      `SELECT COUNT(*)::int AS missing_count
         FROM ghana_withholding_return_lines
        WHERE organization_id=$1 AND return_id=$2
          AND NULLIF(BTRIM(COALESCE(partner_tax_identifier,'')),'') IS NULL`,
      [orgId,returnId],
    );
    if ((identifierIssues[0]?.missing_count || 0) > 0) {
      throw new AppError(409, 'Withholding return has one or more lines without a partner TIN/GUIN. Complete the partner tax profile before finalizing.');
    }
    await client.query(
      `UPDATE ghana_withholding_events e SET return_id=$3,updated_at=NOW()
        WHERE e.organization_id=$1 AND e.id IN (SELECT event_id FROM ghana_withholding_return_lines WHERE return_id=$2)`,
      [orgId,returnId,returnId],
    );
    const { rows: updated } = await client.query(
      `UPDATE ghana_withholding_returns SET status='finalized',finalized_at=NOW(),finalized_by=$3,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId,returnId,actorUserId || null],
    );
    return updated[0];
  });
}

async function markReturnFiled({ orgId, returnId, actorUserId, graReference }) {
  const { rows } = await pool.query(
    `UPDATE ghana_withholding_returns SET status='filed',gra_reference=$3,filed_at=NOW(),filed_by=$4,updated_at=NOW()
      WHERE organization_id=$1 AND id=$2 AND status IN ('finalized','amended') RETURNING *`,
    [orgId,returnId,graReference || null,actorUserId || null],
  );
  if (!rows.length) throw new AppError(409, 'Return must be finalized before it can be marked filed');
  return rows[0];
}

async function createRemittanceFromEvents({ orgId, actorUserId, payload }) {
  return withTransaction(async (client) => {
    const settings = await getSettings({ orgId, client });
    const eventIds = payload.eventIds || [];
    if (!eventIds.length) throw new AppError(400, 'At least one withholding event is required');
    const { rows: events } = await client.query(
      `SELECT * FROM ghana_withholding_events WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND regime=$3 AND direction='payable' AND status='open' FOR UPDATE`,
      [orgId,eventIds,payload.regime],
    );
    if (events.length !== eventIds.length) throw new AppError(409, 'One or more withholding events are not open/remittable');
    let total = 0n;
    for (const e of events) total += parseDecimalToBigInt(e.withheld_amount, 2);
    if (total <= 0n) throw new AppError(400, 'Selected events have no withholding amount to remit');
    const totalAmount = bigIntToDecimalString(total, 2);
    const { rows: countRows } = await client.query(`SELECT COUNT(*)::int AS n FROM withholding_remittances WHERE organization_id=$1`, [orgId]);
    const remittanceNo = `${payload.regime === 'vat_withholding' ? 'WHVR' : 'WTR'}-${String((countRows[0]?.n || 0)+1).padStart(6,'0')}`;
    const dueDate = withholdingDueDate(payload.periodEnd);
    const { rows: remRows } = await client.query(
      `INSERT INTO withholding_remittances(organization_id,remittance_no,direction,status,period_start,period_end,remittance_date,currency_code,settlement_account_id,reference,memo,total_amount,created_by,updated_by,withholding_regime,due_date)
       VALUES ($1,$2,'payable','draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13) RETURNING *`,
      [orgId,remittanceNo,payload.periodStart,payload.periodEnd,payload.remittanceDate,settings.base_currency_code,payload.settlementAccountId || null,payload.reference || null,payload.memo || null,totalAmount,actorUserId || null,payload.regime,dueDate],
    );
    for (const e of events) {
      await client.query(`INSERT INTO ghana_withholding_remittance_events(organization_id,remittance_id,event_id,applied_amount) VALUES ($1,$2,$3,$4)`, [orgId,remRows[0].id,e.id,e.withheld_amount]);
    }
    return remRows[0];
  });
}

async function postRemittance({ orgId, remittanceId, actorUserId, payload = {} }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM withholding_remittances WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId,remittanceId]);
    if (!rows.length) throw new AppError(404, 'Withholding remittance not found');
    const rem = rows[0];
    if (!['draft','approved'].includes(rem.status)) throw new AppError(409, 'Only draft/approved remittances can be posted');
    const settings = await getSettings({ orgId, client });
    const payableAccountId = rem.withholding_regime === 'vat_withholding' ? settings.vat_withholding_payable_account_id : settings.withholding_tax_payable_account_id;
    const settlementAccountId = payload.settlementAccountId || rem.settlement_account_id;
    if (!payableAccountId) throw new AppError(409, `${rem.withholding_regime === 'vat_withholding' ? 'VAT withholding' : 'Income withholding'} payable account is not configured`);
    if (!settlementAccountId) throw new AppError(409, 'Settlement account is required');
    const period = await periodIF.findOpenPeriodForDate({ orgId, date: payload.remittanceDate || rem.remittance_date, client });
    const draft = await journalIF.createDraftJournal({
      orgId,actorUserId,client,payload:{
        periodId:period.id,entryDate:payload.remittanceDate || rem.remittance_date,typeCode:'GENERAL',memo:`GRA withholding remittance ${rem.remittance_no}`,
        idempotencyKey:`ghana_withholding_remittance:${remittanceId}:post`,
        lines:[
          { accountId:payableAccountId,debit:money(rem.total_amount),credit:'0.00',description:`Clear ${rem.withholding_regime} payable ${rem.remittance_no}` },
          { accountId:settlementAccountId,debit:'0.00',credit:money(rem.total_amount),description:`GRA payment ${rem.remittance_no}` },
        ],
      },
    });
    const posted = await journalIF.postDraftJournal({ orgId,journalId:draft.journalId,actorUserId,client });
    await client.query(`UPDATE withholding_remittances SET status='posted',settlement_account_id=$3,journal_entry_id=$4,posted_at=NOW(),posted_by=$5,updated_by=$5,updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId,remittanceId,settlementAccountId,posted.journalId,actorUserId || null]);
    await client.query(`UPDATE ghana_withholding_events e SET status='remitted',remittance_id=$3,updated_at=NOW() WHERE e.organization_id=$1 AND e.id IN (SELECT event_id FROM ghana_withholding_remittance_events WHERE remittance_id=$2)`, [orgId,remittanceId,remittanceId]);
    return { remittanceId,journalId:posted.journalId,status:'posted' };
  });
}

async function voidRemittance({ orgId, remittanceId, actorUserId, reason }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM withholding_remittances WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId,remittanceId]);
    if (!rows.length) throw new AppError(404, 'Withholding remittance not found');
    const rem = rows[0];
    if (rem.status !== 'posted' || !rem.journal_entry_id) throw new AppError(409, 'Only posted withholding remittances can be voided');
    const out = await journalIF.voidPostedJournal({ orgId,journalId:rem.journal_entry_id,actorUserId,reason,client });
    await client.query(
      `UPDATE withholding_remittances SET status='voided',reversal_journal_entry_id=$3,voided_at=NOW(),voided_by=$4,updated_by=$4,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2`,
      [orgId,remittanceId,out.reversalJournalId || null,actorUserId || null],
    );
    await client.query(
      `UPDATE ghana_withholding_events e SET status='open',remittance_id=NULL,updated_at=NOW()
        WHERE e.organization_id=$1 AND e.remittance_id=$2 AND e.status='remitted'`,
      [orgId,remittanceId],
    );
    return { remittanceId,status:'voided',reversalJournalId:out.reversalJournalId || null };
  });
}

async function computeVendorBillVatWithholding({ orgId, partnerId, billId, cashAmount, client = null }) {
  const db = client || pool;
  const settings = await getSettings({ orgId, client: db });
  const partner = await getPartnerProfile({ orgId, partnerId, client: db });
  if (!settings.gh_vat_withholding_agent_enabled || !partner || partner.vat_withholding_eligible === false || partner.is_tax_registered === false) {
    return { applies:false,taxableBasis:'0.00',withheldAmount:'0.00',cashDueBeforeWithholding:null,settlementAmount:money(cashAmount || '0') };
  }

  const { rows: billRows } = await db.query(
    `SELECT id,net_settlement_total,total FROM bills WHERE organization_id=$1 AND id=$2 AND vendor_id=$3`,
    [orgId,billId,partnerId],
  );
  if (!billRows.length) throw new AppError(404, 'Bill not found for VAT withholding calculation');
  const bill = billRows[0];

  const { rows: vatRows } = await db.query(
    `SELECT COALESCE(SUM(x.taxable_amount),0)::numeric(18,2) AS taxable_amount
       FROM (
         SELECT DISTINCT ON (tle.source_line_id) tle.source_line_id,tle.taxable_amount
           FROM tax_ledger_entries tle
          WHERE tle.organization_id=$1 AND tle.source_type='bill' AND tle.source_id=$2
            AND tle.tax_type='VAT' AND tle.tax_scope='taxable' AND tle.sign_factor=1
          ORDER BY tle.source_line_id,tle.created_at
       ) x`,
    [orgId,billId],
  );
  const fullBase = money(vatRows[0]?.taxable_amount || '0');
  if (parseDecimalToBigInt(fullBase,2) <= 0n) {
    return { applies:false,taxableBasis:'0.00',withheldAmount:'0.00',cashDueBeforeWithholding:money(bill.net_settlement_total || bill.total),settlementAmount:money(cashAmount || '0') };
  }

  const { rows: priorRows } = await db.query(
    `SELECT COALESCE(SUM(vpa.vat_withholding_basis),0)::numeric(18,2) AS prior_basis,
            COALESCE(SUM(vpa.vat_withholding_applied),0)::numeric(18,2) AS prior_withheld
       FROM vendor_payment_allocations vpa
       JOIN vendor_payments vp ON vp.id=vpa.vendor_payment_id
      WHERE vpa.bill_id=$1 AND vp.organization_id=$2 AND vp.status='posted'`,
    [billId,orgId],
  );
  const priorBaseCents = parseDecimalToBigInt(priorRows[0]?.prior_basis || '0',2);
  const fullBaseCents = parseDecimalToBigInt(fullBase,2);
  const remainingBase = bigIntToDecimalString(fullBaseCents > priorBaseCents ? fullBaseCents-priorBaseCents : 0n,2);
  const outstandingRows = await db.query(`SELECT outstanding FROM reporting_ap_open_items WHERE organization_id=$1 AND bill_id=$2`,[orgId,billId]);
  const outstanding = money(outstandingRows.rows[0]?.outstanding ?? bill.net_settlement_total ?? bill.total);
  const fullRemaining = calculateVatWithholding({
    taxableValue:remainingBase,
    rate:settings.gh_vat_withholding_rate || '7.000000',
    isWithholdingAgent:true,
    supplierVatRegistered:true,
    standardRatedSupply:true,
    exempt:partner.is_tax_exempt === true || partner.vat_withholding_eligible === false,
  });
  const outstandingCents = parseDecimalToBigInt(outstanding,2);
  const remainingWhvatCents = parseDecimalToBigInt(fullRemaining.withheldAmount || '0',2);
  const maxCashCents = outstandingCents > remainingWhvatCents ? outstandingCents-remainingWhvatCents : 0n;
  const cashCents = parseDecimalToBigInt(cashAmount || '0',2);
  if (cashCents > maxCashCents) {
    throw new AppError(409, `Cash allocation exceeds supplier cash due after VAT withholding. Maximum cash allocation is ${bigIntToDecimalString(maxCashCents,2)}.`);
  }
  if (cashCents <= 0n || maxCashCents <= 0n) {
    return { applies:false,taxableBasis:'0.00',withheldAmount:'0.00',cashDueBeforeWithholding:bigIntToDecimalString(maxCashCents,2),settlementAmount:money(cashAmount || '0') };
  }

  const remainingBaseCents = parseDecimalToBigInt(remainingBase,2);
  const basisCents = cashCents === maxCashCents ? remainingBaseCents : divideAndRoundHalfUp(remainingBaseCents * cashCents, maxCashCents);
  const taxableBasis = bigIntToDecimalString(basisCents,2);
  const whvat = calculateVatWithholding({
    taxableValue:taxableBasis,
    rate:settings.gh_vat_withholding_rate || '7.000000',
    isWithholdingAgent:true,
    supplierVatRegistered:true,
    standardRatedSupply:true,
    exempt:partner.is_tax_exempt === true || partner.vat_withholding_eligible === false,
  });
  const withheldCents = parseDecimalToBigInt(whvat.withheldAmount || '0',2);
  return {
    applies:whvat.applies,
    taxableBasis,
    withheldAmount:bigIntToDecimalString(withheldCents,2),
    cashDueBeforeWithholding:bigIntToDecimalString(maxCashCents,2),
    settlementAmount:bigIntToDecimalString(cashCents+withheldCents,2),
    rate:whvat.rate,
  };
}

async function captureVendorPaymentWithholding({ orgId, actorUserId, vendorPaymentId, client = null }) {
  const run = async (db) => {
    const { rows: vpRows } = await db.query(`SELECT * FROM vendor_payments WHERE organization_id=$1 AND id=$2`, [orgId,vendorPaymentId]);
    if (!vpRows.length) throw new AppError(404, 'Vendor payment not found');
    const vp = vpRows[0];
    const settings = await getSettings({ orgId, client: db });
    const partner = await getPartnerProfile({ orgId, partnerId: vp.vendor_id, client: db });
    const { rows: allocations } = await db.query(
      `SELECT a.bill_id,a.amount_applied,a.vat_withholding_basis,a.vat_withholding_applied,b.bill_no,b.bill_date,b.total,b.net_settlement_total
         FROM vendor_payment_allocations a JOIN bills b ON b.id=a.bill_id
        WHERE a.vendor_payment_id=$1 ORDER BY b.bill_date,b.bill_no`,
      [vendorPaymentId],
    );
    const captured = [];
    for (const a of allocations) {
      const { rows: whtRows } = await db.query(
        `SELECT d.tax_code_id,tc.code,tc.rate,tc.reporting_group,tc.withholding_treatment,tc.threshold_basis,tc.threshold_amount,
                COALESCE(SUM(d.taxable_amount),0)::numeric(18,2) AS taxable_amount
           FROM bill_line_tax_details d
           JOIN bill_lines bl ON bl.id=d.line_id
           JOIN tax_codes tc ON tc.id=d.tax_code_id
          WHERE bl.bill_id=$1 AND COALESCE(tc.withholding_regime,'income_wht')='income_wht' AND tc.tax_type='WITHHOLDING'
          GROUP BY d.tax_code_id,tc.code,tc.rate,tc.reporting_group,tc.withholding_treatment,tc.threshold_basis,tc.threshold_amount`,
        [a.bill_id],
      );
      for (const wht of (settings.gh_income_wht_agent_enabled ? whtRows : [])) {
        const qualifying = proportionalAmount(wht.taxable_amount, a.amount_applied, a.net_settlement_total || a.total);
        const event = await recordEvent({ orgId,actorUserId,client:db,payload:{
          regime:'income_wht',direction:'payable',partnerId:vp.vendor_id,taxCodeId:wht.tax_code_id,categoryCode:wht.reporting_group || wht.code,
          paymentAmount:qualifying,eventDate:vp.payment_date,sourceType:'vendor_payment',sourceId:vendorPaymentId,sourceLineId:a.bill_id,sourceDocumentNo:vp.payment_no,
          eventKey:`vendor_payment:${vendorPaymentId}:bill:${a.bill_id}:income:${wht.tax_code_id}`,
          metadata:{ billId:a.bill_id,billNo:a.bill_no,allocationAmount:a.amount_applied },
        }});
        captured.push(event);
      }

      if (settings.gh_vat_withholding_agent_enabled && partner && partner.vat_withholding_eligible !== false && partner.is_tax_registered !== false) {
        const vatBase = money(a.vat_withholding_basis || '0');
        const whvatApplied = money(a.vat_withholding_applied || '0');
        if (parseDecimalToBigInt(vatBase,2) > 0n && parseDecimalToBigInt(whvatApplied,2) > 0n) {
          const event = await recordEvent({ orgId,actorUserId,client:db,payload:{
            regime:'vat_withholding',direction:'payable',partnerId:vp.vendor_id,taxableValue:vatBase,standardRatedSupply:true,
            eventDate:vp.payment_date,sourceType:'vendor_payment',sourceId:vendorPaymentId,sourceLineId:a.bill_id,sourceDocumentNo:vp.payment_no,
            eventKey:`vendor_payment:${vendorPaymentId}:bill:${a.bill_id}:whvat`,metadata:{ billId:a.bill_id,billNo:a.bill_no,allocationCashAmount:a.amount_applied,vatWithholdingApplied:whvatApplied },
          }});
          if (money(event.withheld_amount) !== whvatApplied) throw new AppError(409, 'VAT withholding event does not match the amount applied to the vendor payment');
          captured.push(event);
        }
      }
    }
    return captured;
  };
  return client ? run(client) : withTransaction(run);
}

async function voidVendorPaymentWithholding({ orgId, vendorPaymentId, client = null }) {
  const run = async (db) => {
    const { rows: eventRows } = await db.query(
      `SELECT id FROM ghana_withholding_events
        WHERE organization_id=$1 AND source_type='vendor_payment' AND source_id=$2 AND status<>'voided'
        FOR UPDATE`,
      [orgId, vendorPaymentId],
    );
    if (!eventRows.length) return { voidedEvents: 0 };
    const eventIds = eventRows.map((r) => r.id);

    const { rows: frozenReturns } = await db.query(
      `SELECT DISTINCT r.id,r.form_code,r.period_start,r.period_end,r.status
         FROM ghana_withholding_return_lines l
         JOIN ghana_withholding_returns r ON r.id=l.return_id AND r.organization_id=l.organization_id
        WHERE l.organization_id=$1 AND l.event_id=ANY($2::uuid[])
          AND r.status IN ('finalized','filed','amended')
        LIMIT 1`,
      [orgId, eventIds],
    );
    if (frozenReturns.length) {
      const ret = frozenReturns[0];
      throw new AppError(
        409,
        `This payment withholding is included in ${ret.status} return ${ret.form_code} (${ret.period_start} to ${ret.period_end}). Void/correct it through the withholding-return amendment workflow instead of rewriting the filed/finalized history.`,
      );
    }

    const { rows: draftReturns } = await db.query(
      `SELECT DISTINCT r.id
         FROM ghana_withholding_return_lines l
         JOIN ghana_withholding_returns r ON r.id=l.return_id AND r.organization_id=l.organization_id
        WHERE l.organization_id=$1 AND l.event_id=ANY($2::uuid[]) AND r.status='draft'`,
      [orgId, eventIds],
    );
    const draftIds = draftReturns.map((r) => r.id);
    if (draftIds.length) {
      await db.query(
        `DELETE FROM ghana_withholding_return_lines
          WHERE organization_id=$1 AND return_id=ANY($2::uuid[]) AND event_id=ANY($3::uuid[])`,
        [orgId, draftIds, eventIds],
      );
      await db.query(
        `UPDATE ghana_withholding_returns r
            SET total_taxable_basis=COALESCE((SELECT SUM(l.taxable_basis) FROM ghana_withholding_return_lines l WHERE l.return_id=r.id),0),
                total_withheld=COALESCE((SELECT SUM(l.withheld_amount) FROM ghana_withholding_return_lines l WHERE l.return_id=r.id),0),
                updated_at=NOW()
          WHERE r.organization_id=$1 AND r.id=ANY($2::uuid[])`,
        [orgId, draftIds],
      );
    }

    const { rows } = await db.query(
      `UPDATE ghana_withholding_events
          SET status='voided',return_id=NULL,updated_at=NOW()
        WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND status<>'voided'
        RETURNING id`,
      [orgId, eventIds],
    );
    if (rows.length) {
      await db.query(
        `UPDATE ghana_withholding_certificates SET status='voided',updated_at=NOW()
          WHERE organization_id=$1 AND event_id=ANY($2::uuid[]) AND status<>'voided'`,
        [orgId,rows.map((r)=>r.id)],
      );
    }
    return { voidedEvents: rows.length };
  };
  return client ? run(client) : withTransaction(run);
}

module.exports = {
  getSettings,
  getDashboard,
  getReconciliation,
  listRateCatalog,
  getThresholdPosition,
  preview,
  recordEvent,
  listEvents,
  listCertificates,
  recordReceivedCertificate,
  prepareReturn,
  listReturns,
  getReturn,
  finalizeReturn,
  markReturnFiled,
  createRemittanceFromEvents,
  postRemittance,
  voidRemittance,
  computeVendorBillVatWithholding,
  captureVendorPaymentWithholding,
  voidVendorPaymentWithholding,
};
