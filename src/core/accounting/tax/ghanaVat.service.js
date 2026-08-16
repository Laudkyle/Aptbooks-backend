const { pool } = require('../../../db/pool');
const { withTransaction } = require('../../../db/tx');
const { AppError } = require('../../../shared/errors/AppError');
const journalIF = require('../../../interfaces/journalPosting.interface');
const periodIF = require('../../../interfaces/periodManagement.interface');
const {
  computeComponentTaxBreakdown,
  applyRecoverablePercent,
  moneyToMinorUnits,
  minorUnitsToMoney,
} = require('../../../shared/tax/taxMath');
const {
  calculateInputTaxApportionment,
  calculateVatRegistrationMonitor,
  applyRecoveryRatio,
} = require('../../../shared/tax/ghanaVat');
const {
  syncImportedServiceTaxDetailToLedger,
  removeTaxLedgerSource,
} = require('../../../shared/tax/taxLedger');

const REPORTABLE_SOURCE_SQL = `(
  (tle.source_type='invoice' AND EXISTS (SELECT 1 FROM invoices x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.status IN ('issued','paid'))) OR
  (tle.source_type='bill' AND EXISTS (SELECT 1 FROM bills x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.status IN ('issued','paid'))) OR
  (tle.source_type='credit_note' AND EXISTS (SELECT 1 FROM credit_notes x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.status='issued')) OR
  (tle.source_type='debit_note' AND EXISTS (SELECT 1 FROM debit_notes x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.status='issued')) OR
  (tle.source_type='pos_sale' AND EXISTS (SELECT 1 FROM pos_sales x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.status IN ('completed','posted','partially_returned','returned','partially_refunded','refunded'))) OR
  (tle.source_type='pos_return' AND EXISTS (SELECT 1 FROM pos_return_authorizations x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.status='received')) OR
  (tle.source_type IN ('expense','petty_cash','return') AND EXISTS (SELECT 1 FROM operational_documents x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.module_code=tle.source_type AND x.status='posted')) OR
  (tle.source_type='tax_adjustment' AND EXISTS (SELECT 1 FROM tax_adjustments x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.status='posted')) OR
  (tle.source_type='imported_service' AND EXISTS (SELECT 1 FROM imported_service_transactions x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.status='posted'))
)`;

function assertDate(value, fieldName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw new AppError(400, `${fieldName} must be YYYY-MM-DD`);
}

function monthBounds(dateValue) {
  assertDate(dateValue, 'serviceDate');
  const [year, month] = String(dateValue).split('-').map(Number);
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  const end = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2, '0')}-${String(endDate.getUTCDate()).padStart(2, '0')}`;
  return { start, end };
}

async function getSettings({ client = pool, orgId }) {
  await client.query(`INSERT INTO tax_settings(organization_id) VALUES($1) ON CONFLICT DO NOTHING`, [orgId]);
  const { rows } = await client.query(`SELECT * FROM tax_settings WHERE organization_id=$1`, [orgId]);
  return rows[0];
}

async function getVatRegistrationMonitor({ orgId, asOfDate }) {
  const asOf = asOfDate || new Date().toISOString().slice(0, 10);
  assertDate(asOf, 'asOfDate');
  const settings = await getSettings({ orgId });
  if (settings.gh_vat_monitor_enabled === false) {
    return { enabled: false, asOfDate: asOf, status: 'manual_review', message: 'Ghana VAT registration monitoring is disabled for this organization.' };
  }

  const { rows: registrationRows } = await pool.query(
    `SELECT id, registration_no AS registration_number, effective_from, effective_to
       FROM tax_registrations
      WHERE organization_id=$1 AND registration_type='VAT'
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY is_primary DESC, effective_from DESC LIMIT 1`,
    [orgId, asOf]
  );

  let turnoverRow;
  if (settings.gh_vat_turnover_basis === 'manual') {
    turnoverRow = {
      taxable_goods_turnover: String(settings.gh_vat_manual_goods_turnover || '0.00'),
      window_start: null,
      window_end: asOf,
      unclassified_sales_count: '0',
    };
  } else {
    const { rows } = await pool.query(
      `WITH invoice_goods AS (
         SELECT il.taxable_amount AS amount, 1::numeric AS sign_factor
           FROM invoices i
           JOIN invoice_lines il ON il.invoice_id=i.id
          WHERE i.organization_id=$1 AND i.status IN ('issued','paid')
            AND i.invoice_date BETWEEN ($2::date - INTERVAL '1 year' + INTERVAL '1 day')::date AND $2::date
            AND COALESCE(
              NULLIF(il.tax_snapshot_json->'context'->>'supplyType',''),
              NULLIF(il.tax_snapshot_json->'components'->0->'metadata'->>'supplyType','')
            )='goods'
            AND COALESCE(
              NULLIF(il.tax_snapshot_json->'classification'->>'taxCategory',''),
              NULLIF(il.tax_snapshot_json->'components'->0->>'taxScope',''),
              'taxable'
            ) NOT IN ('exempt','out_of_scope','relieved')
       ), pos_goods AS (
         SELECT sl.taxable_amount AS amount, 1::numeric AS sign_factor
           FROM pos_sales ps
           JOIN pos_sale_lines sl ON sl.sale_id=ps.id
           JOIN inventory_items ii ON ii.id=sl.item_id AND ii.organization_id=ps.organization_id
           LEFT JOIN tax_catalog_profiles tcp ON tcp.id=ii.tax_profile_id AND tcp.organization_id=ps.organization_id
          WHERE ps.organization_id=$1
            AND ps.status IN ('completed','posted','partially_returned','returned','partially_refunded','refunded')
            AND ps.sale_date BETWEEN ($2::date - INTERVAL '1 year' + INTERVAL '1 day')::date AND $2::date
            AND COALESCE(tcp.supply_type,'goods')='goods'
            AND COALESCE(tcp.sales_tax_scope,'taxable') IN ('taxable','zero_rated','export')
       ), pos_returns AS (
         SELECT ROUND(sl.taxable_amount * (rl.quantity / NULLIF(sl.quantity,0)),2) AS amount, -1::numeric AS sign_factor
           FROM pos_return_authorizations r
           JOIN pos_return_lines rl ON rl.return_id=r.id
           JOIN pos_sale_lines sl ON sl.id=rl.sale_line_id
           JOIN inventory_items ii ON ii.id=rl.item_id AND ii.organization_id=r.organization_id
           LEFT JOIN tax_catalog_profiles tcp ON tcp.id=ii.tax_profile_id AND tcp.organization_id=r.organization_id
          WHERE r.organization_id=$1 AND r.status='received'
            AND COALESCE(r.received_at::date,CURRENT_DATE) BETWEEN ($2::date - INTERVAL '1 year' + INTERVAL '1 day')::date AND $2::date
            AND COALESCE(tcp.supply_type,'goods')='goods'
            AND COALESCE(tcp.sales_tax_scope,'taxable') IN ('taxable','zero_rated','export')
       ), credit_goods AS (
         SELECT MAX(tle.taxable_amount) AS amount, tle.sign_factor
           FROM tax_ledger_entries tle
          WHERE tle.organization_id=$1 AND tle.source_type='credit_note'
            AND tle.document_date BETWEEN ($2::date - INTERVAL '1 year' + INTERVAL '1 day')::date AND $2::date
            AND COALESCE(NULLIF(tle.metadata->>'supplyType',''),'')='goods'
            AND tle.tax_scope IN ('taxable','zero_rated','export')
            AND ${REPORTABLE_SOURCE_SQL}
          GROUP BY tle.source_id,COALESCE(tle.source_line_id,tle.source_id),tle.sign_factor
       ), activity AS (
         SELECT * FROM invoice_goods
         UNION ALL SELECT * FROM pos_goods
         UNION ALL SELECT * FROM pos_returns
         UNION ALL SELECT * FROM credit_goods
       ), unclassified_invoice AS (
         SELECT COUNT(*)::int AS count
           FROM invoices i JOIN invoice_lines il ON il.invoice_id=i.id
          WHERE i.organization_id=$1 AND i.status IN ('issued','paid')
            AND i.invoice_date BETWEEN ($2::date - INTERVAL '1 year' + INTERVAL '1 day')::date AND $2::date
            AND COALESCE(
              NULLIF(il.tax_snapshot_json->'context'->>'supplyType',''),
              NULLIF(il.tax_snapshot_json->'components'->0->'metadata'->>'supplyType','')
            ) IS NULL
       ), unclassified_pos AS (
         SELECT COUNT(*)::int AS count
           FROM pos_sales ps JOIN pos_sale_lines sl ON sl.sale_id=ps.id
           JOIN inventory_items ii ON ii.id=sl.item_id AND ii.organization_id=ps.organization_id
          WHERE ps.organization_id=$1 AND ps.status IN ('completed','posted','partially_returned','returned','partially_refunded','refunded')
            AND ps.sale_date BETWEEN ($2::date - INTERVAL '1 year' + INTERVAL '1 day')::date AND $2::date
            AND ii.tax_profile_id IS NULL
       )
       SELECT COALESCE(SUM(amount*sign_factor),0)::numeric(18,2)::text AS taxable_goods_turnover,
              ($2::date - INTERVAL '1 year' + INTERVAL '1 day')::date::text AS window_start,
              $2::date::text AS window_end,
              ((SELECT count FROM unclassified_invoice)+(SELECT count FROM unclassified_pos))::text AS unclassified_sales_count
         FROM activity`,
      [orgId, asOf]
    );
    turnoverRow = rows[0];
  }

  const threshold = String(settings.gh_vat_goods_registration_threshold || '750000.00');
  const result = calculateVatRegistrationMonitor({
    taxableGoodsTurnover: turnoverRow?.taxable_goods_turnover || '0.00',
    threshold,
    isRegistered: Boolean(registrationRows[0]),
  });

  await pool.query(
    `INSERT INTO tax_vat_registration_monitor_snapshots(
       organization_id, as_of_date, window_start, window_end, turnover_basis,
       taxable_goods_turnover, threshold_amount, threshold_progress, status,
       registration_required_by_monitor, details
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT(organization_id, as_of_date, turnover_basis)
     DO UPDATE SET taxable_goods_turnover=EXCLUDED.taxable_goods_turnover,
                   threshold_amount=EXCLUDED.threshold_amount,
                   threshold_progress=EXCLUDED.threshold_progress,
                   status=EXCLUDED.status,
                   registration_required_by_monitor=EXCLUDED.registration_required_by_monitor,
                   details=EXCLUDED.details,
                   window_start=EXCLUDED.window_start,
                   window_end=EXCLUDED.window_end`,
    [
      orgId, asOf, turnoverRow.window_start || asOf, turnoverRow.window_end,
      settings.gh_vat_turnover_basis || 'taxable_goods_rolling_12m',
      result.taxableGoodsTurnover, result.threshold, result.thresholdProgress,
      result.status, result.registrationRequiredByMonitor,
      JSON.stringify({ registration: registrationRows[0] || null, remaining: result.remaining, scope: 'businesses_dealing_in_goods', unclassifiedSalesCount: Number(turnoverRow.unclassified_sales_count || 0) }),
    ]
  );

  return {
    enabled: true,
    asOfDate: asOf,
    windowStart: turnoverRow.window_start,
    windowEnd: turnoverRow.window_end,
    turnoverBasis: settings.gh_vat_turnover_basis || 'taxable_goods_rolling_12m',
    ...result,
    registration: registrationRows[0] || null,
    unclassifiedSalesCount: Number(turnoverRow.unclassified_sales_count || 0),
    manualReviewRequired: Number(turnoverRow.unclassified_sales_count || 0) > 0,
    scope: 'businesses_dealing_in_goods',
  };
}

async function getSupplyAndInputSnapshot({ client = pool, orgId, periodStart, periodEnd }) {
  const { rows: supplyRows } = await client.query(
    `WITH source_lines AS (
       SELECT tle.source_type, tle.source_id, COALESCE(tle.source_line_id,tle.source_id) AS source_line_key,
              tle.sign_factor, tle.tax_scope, MAX(tle.taxable_amount) AS taxable_amount
         FROM tax_ledger_entries tle
        WHERE tle.organization_id=$1
          AND tle.document_date BETWEEN $2::date AND $3::date
          AND tle.direction='output'
          AND tle.tax_scope IN ('taxable','zero_rated','export','exempt')
          AND ${REPORTABLE_SOURCE_SQL}
        GROUP BY tle.source_type,tle.source_id,COALESCE(tle.source_line_id,tle.source_id),tle.sign_factor,tle.tax_scope
     )
     SELECT COALESCE(SUM(CASE WHEN tax_scope IN ('taxable','zero_rated','export') THEN taxable_amount*sign_factor ELSE 0 END),0)::numeric(18,2)::text AS taxable_supplies,
            COALESCE(SUM(CASE WHEN tax_scope='exempt' THEN taxable_amount*sign_factor ELSE 0 END),0)::numeric(18,2)::text AS exempt_supplies
       FROM source_lines`,
    [orgId, periodStart, periodEnd]
  );

  const { rows: inputRows } = await client.query(
    `SELECT
       COALESCE(SUM(CASE WHEN tle.recovery_basis='direct_taxable' THEN tle.tax_amount*tle.sign_factor ELSE 0 END),0)::numeric(18,2)::text AS direct_taxable_input_tax,
       COALESCE(SUM(CASE WHEN tle.recovery_basis IN ('direct_exempt','not_applicable') THEN tle.tax_amount*tle.sign_factor ELSE 0 END),0)::numeric(18,2)::text AS direct_exempt_input_tax,
       COALESCE(SUM(CASE WHEN tle.recovery_basis='mixed' THEN tle.tax_amount*tle.sign_factor ELSE 0 END),0)::numeric(18,2)::text AS mixed_input_tax,
       COALESCE(SUM(CASE WHEN tle.recovery_basis='mixed' THEN tle.recoverable_amount*tle.sign_factor ELSE 0 END),0)::numeric(18,2)::text AS prior_mixed_recoverable_amount
      FROM tax_ledger_entries tle
      LEFT JOIN tax_codes itc ON itc.id=tle.tax_code_id
     WHERE tle.organization_id=$1
       AND tle.document_date BETWEEN $2::date AND $3::date
       AND tle.direction IN ('input','reverse_charge')
       AND (tle.tax_type='VAT' OR UPPER(COALESCE(itc.code,'')) LIKE '%NHIL%' OR UPPER(COALESCE(itc.code,'')) LIKE '%GETFUND%' OR tle.source_type='imported_service')
       AND ${REPORTABLE_SOURCE_SQL}`,
    [orgId, periodStart, periodEnd]
  );
  return { ...supplyRows[0], ...inputRows[0] };
}

async function calculateInputApportionment({ orgId, actorUserId, payload, client = pool }) {
  assertDate(payload.periodStart, 'periodStart');
  assertDate(payload.periodEnd, 'periodEnd');
  const existing = await client.query(`SELECT id,status FROM tax_input_apportionment_periods WHERE organization_id=$1 AND period_start=$2::date AND period_end=$3::date`, [orgId,payload.periodStart,payload.periodEnd]);
  if (existing.rows[0] && ['posted','voided'].includes(existing.rows[0].status)) throw new AppError(409, 'A posted/voided apportionment period cannot be recalculated; create an adjustment in a later period instead');
  const snapshot = await getSupplyAndInputSnapshot({ client, orgId, periodStart: payload.periodStart, periodEnd: payload.periodEnd });
  const taxable = payload.taxableSupplies != null ? String(payload.taxableSupplies) : snapshot.taxable_supplies;
  const exempt = payload.exemptSupplies != null ? String(payload.exemptSupplies) : snapshot.exempt_supplies;
  let calc = calculateInputTaxApportionment({
    taxableSupplies: taxable,
    exemptSupplies: exempt,
    mixedInputTax: snapshot.mixed_input_tax,
    directTaxableInputTax: snapshot.direct_taxable_input_tax,
    directExemptInputTax: snapshot.direct_exempt_input_tax,
  });
  if (payload.method === 'manual_approved') {
    const mixed = applyRecoveryRatio(snapshot.mixed_input_tax, String(payload.approvedRecoveryRatio));
    calc = {
      ...calc,
      allowedRecoveryRatio: String(payload.approvedRecoveryRatio),
      thresholdApplied: 'manual_approved',
      recoverableMixedInputTax: mixed.recoverableAmount,
      nonRecoverableMixedInputTax: mixed.nonRecoverableAmount,
      totalRecoverableInputTax: minorUnitsToMoney(moneyToMinorUnits(snapshot.direct_taxable_input_tax) + moneyToMinorUnits(mixed.recoverableAmount)),
      totalNonRecoverableInputTax: minorUnitsToMoney(moneyToMinorUnits(snapshot.direct_exempt_input_tax) + moneyToMinorUnits(mixed.nonRecoverableAmount)),
    };
  }
  const adjustmentAmount = minorUnitsToMoney(moneyToMinorUnits(calc.recoverableMixedInputTax) - moneyToMinorUnits(snapshot.prior_mixed_recoverable_amount));
  const method = payload.method || 'ghana_act1151_turnover';
  const details = { ...calc, priorMixedRecoverableAmount: snapshot.prior_mixed_recoverable_amount, adjustmentAmount };
  const { rows } = await client.query(
    `INSERT INTO tax_input_apportionment_periods(
       organization_id,period_start,period_end,method,status,taxable_supplies,exempt_supplies,total_supplies,
       raw_recovery_ratio,allowed_recovery_ratio,threshold_applied,direct_taxable_input_tax,direct_exempt_input_tax,
       mixed_input_tax,recoverable_mixed_input_tax,nonrecoverable_mixed_input_tax,total_recoverable_input_tax,
       total_nonrecoverable_input_tax,prior_mixed_recoverable_amount,adjustment_amount,calculation_snapshot,calculated_at,calculated_by
     ) VALUES($1,$2,$3,$4,'calculated',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,NOW(),$21)
     ON CONFLICT(organization_id,period_start,period_end)
     DO UPDATE SET method=EXCLUDED.method,status='calculated',taxable_supplies=EXCLUDED.taxable_supplies,
       exempt_supplies=EXCLUDED.exempt_supplies,total_supplies=EXCLUDED.total_supplies,raw_recovery_ratio=EXCLUDED.raw_recovery_ratio,
       allowed_recovery_ratio=EXCLUDED.allowed_recovery_ratio,threshold_applied=EXCLUDED.threshold_applied,
       direct_taxable_input_tax=EXCLUDED.direct_taxable_input_tax,direct_exempt_input_tax=EXCLUDED.direct_exempt_input_tax,
       mixed_input_tax=EXCLUDED.mixed_input_tax,recoverable_mixed_input_tax=EXCLUDED.recoverable_mixed_input_tax,
       nonrecoverable_mixed_input_tax=EXCLUDED.nonrecoverable_mixed_input_tax,total_recoverable_input_tax=EXCLUDED.total_recoverable_input_tax,
       total_nonrecoverable_input_tax=EXCLUDED.total_nonrecoverable_input_tax,prior_mixed_recoverable_amount=EXCLUDED.prior_mixed_recoverable_amount,
       adjustment_amount=EXCLUDED.adjustment_amount,calculation_snapshot=EXCLUDED.calculation_snapshot,calculated_at=NOW(),calculated_by=EXCLUDED.calculated_by,updated_at=NOW()
     RETURNING *`,
    [orgId,payload.periodStart,payload.periodEnd,method,calc.taxableSupplies,calc.exemptSupplies,calc.totalSupplies,calc.rawRecoveryRatio,calc.allowedRecoveryRatio,
      calc.thresholdApplied,calc.directTaxableInputTax,calc.directExemptInputTax,calc.mixedInputTax,calc.recoverableMixedInputTax,calc.nonRecoverableMixedInputTax,
      calc.totalRecoverableInputTax,calc.totalNonRecoverableInputTax,snapshot.prior_mixed_recoverable_amount,adjustmentAmount,JSON.stringify(details),actorUserId || null]
  );
  return rows[0];
}

async function listInputApportionments({ orgId, query = {} }) {
  const params=[orgId]; const where=['organization_id=$1']; let i=2;
  if(query.status){where.push(`status=$${i++}`);params.push(query.status);}
  if(query.fromDate){where.push(`period_end >= $${i++}::date`);params.push(query.fromDate);}
  if(query.toDate){where.push(`period_start <= $${i++}::date`);params.push(query.toDate);}
  const {rows}=await pool.query(`SELECT * FROM tax_input_apportionment_periods WHERE ${where.join(' AND ')} ORDER BY period_end DESC`,params);
  return rows;
}

async function postInputApportionment({ orgId, actorUserId, apportionmentId, payload = {} }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM tax_input_apportionment_periods WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[orgId,apportionmentId]);
    const periodRow=rows[0];
    if(!periodRow) throw new AppError(404,'Input-tax apportionment not found');
    if(periodRow.status==='posted') return periodRow;
    if(periodRow.status!=='calculated') throw new AppError(409,'Only calculated input-tax apportionments can be posted');
    const settings=await getSettings({client,orgId});
    if(!settings.input_tax_account_id) throw new AppError(409,'Input tax account is not configured');
    const adjustmentMinor=moneyToMinorUnits(periodRow.adjustment_amount || 0);
    if(adjustmentMinor !== 0n && !settings.non_recoverable_input_tax_account_id) throw new AppError(409,'Non-recoverable input tax account is not configured');

    let journalId=null;
    if(adjustmentMinor !== 0n){
      const amount=minorUnitsToMoney(adjustmentMinor < 0n ? -adjustmentMinor : adjustmentMinor);
      const period=await periodIF.findOpenPeriodForDate({orgId,date:periodRow.period_end,client});
      const positive=adjustmentMinor > 0n;
      const draft=await journalIF.createDraftJournal({orgId,actorUserId,client,payload:{
        periodId:period.id,entryDate:periodRow.period_end,typeCode:'GENERAL',
        memo:payload.memo || `Ghana input VAT apportionment ${periodRow.period_start} to ${periodRow.period_end}`,
        idempotencyKey:`tax-apportionment:${periodRow.id}:post`,
        lines:[
          {accountId: positive ? settings.input_tax_account_id : settings.non_recoverable_input_tax_account_id, debit: amount, credit:'0.00', description:'Input VAT apportionment adjustment'},
          {accountId: positive ? settings.non_recoverable_input_tax_account_id : settings.input_tax_account_id, debit:'0.00', credit:amount, description:'Input VAT apportionment adjustment'},
        ]
      }});
      const posted=await journalIF.postDraftJournal({orgId,journalId:draft.journalId,actorUserId,client});
      journalId=posted.journalId || posted.id || draft.journalId;
    }

    const ratio=String(periodRow.allowed_recovery_ratio);
    await client.query(
      `UPDATE tax_ledger_entries tle
          SET recoverable_percent=$4,
              recoverable_amount=ROUND(tax_amount*$4::numeric,2),
              nonrecoverable_amount=tax_amount-ROUND(tax_amount*$4::numeric,2),
              apportionment_period_id=$5,
              recovery_reason='Ghana Act 1151 mixed-supply apportionment',
              metadata=metadata || jsonb_build_object(
                'preApportionmentRecoverablePercent',recoverable_percent::text,
                'preApportionmentRecoverableAmount',recoverable_amount::text,
                'preApportionmentNonrecoverableAmount',nonrecoverable_amount::text,
                'apportionmentPeriodId',$5::text,
                'apportionmentRatio',$4::text
              ),
              updated_at=NOW()
        WHERE tle.organization_id=$1 AND tle.document_date BETWEEN $2::date AND $3::date
          AND tle.direction IN ('input','reverse_charge') AND tle.recovery_basis='mixed' AND ${REPORTABLE_SOURCE_SQL}`,
      [orgId,periodRow.period_start,periodRow.period_end,ratio,periodRow.id]
    );
    const {rows:updated}=await client.query(`UPDATE tax_input_apportionment_periods SET status='posted',journal_entry_id=$3,posted_at=NOW(),posted_by=$4,updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,[orgId,apportionmentId,journalId,actorUserId||null]);
    return updated[0];
  });
}

async function voidInputApportionment({ orgId, actorUserId, apportionmentId, reason }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM tax_input_apportionment_periods WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, apportionmentId]);
    const row = rows[0];
    if (!row) throw new AppError(404, 'Input-tax apportionment not found');
    if (row.status === 'voided') return row;
    if (row.status !== 'posted') throw new AppError(409, 'Only posted input-tax apportionments can be voided');
    let reversalJournalId = null;
    if (row.journal_entry_id) {
      const reversal = await journalIF.voidPostedJournal({ orgId, journalId: row.journal_entry_id, actorUserId, reason, client });
      reversalJournalId = reversal.journalId || reversal.reversalJournalId || null;
    }
    await client.query(
      `UPDATE tax_ledger_entries tle
          SET recoverable_percent=COALESCE(NULLIF(metadata->>'preApportionmentRecoverablePercent','')::numeric,recoverable_percent),
              recoverable_amount=COALESCE(NULLIF(metadata->>'preApportionmentRecoverableAmount','')::numeric,recoverable_amount),
              nonrecoverable_amount=COALESCE(NULLIF(metadata->>'preApportionmentNonrecoverableAmount','')::numeric,nonrecoverable_amount),
              apportionment_period_id=NULL,
              recovery_reason=NULL,
              metadata=(metadata - 'preApportionmentRecoverablePercent' - 'preApportionmentRecoverableAmount' - 'preApportionmentNonrecoverableAmount' - 'apportionmentPeriodId' - 'apportionmentRatio'),
              updated_at=NOW()
        WHERE organization_id=$1 AND apportionment_period_id=$2`,
      [orgId, apportionmentId]
    );
    const updated = await client.query(
      `UPDATE tax_input_apportionment_periods
          SET status='voided',reversal_journal_entry_id=$3,voided_at=NOW(),voided_by=$4,void_reason=$5,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId, apportionmentId, reversalJournalId, actorUserId || null, reason]
    );
    return updated.rows[0];
  });
}

async function getImportedService({ orgId, importedServiceId, client = pool }) {
  const {rows}=await client.query(
    `SELECT t.*,bp.name AS supplier_name,tc.code AS tax_code,tc.name AS tax_code_name
       FROM imported_service_transactions t
       LEFT JOIN business_partners bp ON bp.id=t.supplier_id
       LEFT JOIN tax_codes tc ON tc.id=t.tax_code_id
      WHERE t.organization_id=$1 AND t.id=$2`,[orgId,importedServiceId]);
  if(!rows[0]) throw new AppError(404,'Imported service transaction not found');
  const detail=await client.query(`SELECT * FROM imported_service_tax_details WHERE organization_id=$1 AND imported_service_id=$2 ORDER BY sequence_no`,[orgId,importedServiceId]);
  return {...rows[0],tax_details:detail.rows};
}

async function listImportedServices({orgId,query={}}){
  const params=[orgId]; const where=['t.organization_id=$1']; let i=2;
  if(query.status){where.push(`t.status=$${i++}`);params.push(query.status);}
  if(query.fromDate){where.push(`t.service_date >= $${i++}::date`);params.push(query.fromDate);}
  if(query.toDate){where.push(`t.service_date <= $${i++}::date`);params.push(query.toDate);}
  const {rows}=await pool.query(`SELECT t.*,bp.name AS supplier_name,tc.code AS tax_code FROM imported_service_transactions t LEFT JOIN business_partners bp ON bp.id=t.supplier_id LEFT JOIN tax_codes tc ON tc.id=t.tax_code_id WHERE ${where.join(' AND ')} ORDER BY t.service_date DESC,t.created_at DESC`,params);
  return rows;
}

async function resolveImportedServiceTaxCode({client,orgId,taxCodeId}){
  const {rows}=await client.query(`SELECT * FROM tax_codes WHERE organization_id=$1 AND ${taxCodeId ? 'id=$2' : "code='GH_IMPORTED_SERVICES_20'"} AND status='active' LIMIT 1`, taxCodeId ? [orgId,taxCodeId] : [orgId]);
  if(!rows[0]) throw new AppError(409,'Ghana imported-services tax code is not configured; install/update the Ghana tax pack');
  return rows[0];
}

async function rebuildImportedServiceDetails({client,orgId,transaction}){
  const taxCode=await resolveImportedServiceTaxCode({client,orgId,taxCodeId:transaction.tax_code_id});
  const {rows:componentRows}=await client.query(
    `SELECT tcc.sequence_no,tcc.rate_override,tc.id AS tax_code_id,tc.code,tc.name,tc.tax_type,tc.tax_scope,tc.box_code,COALESCE(tcc.rate_override,tc.rate) AS rate
       FROM tax_code_components tcc JOIN tax_codes tc ON tc.id=tcc.component_tax_code_id
      WHERE tcc.organization_id=$1 AND tcc.parent_tax_code_id=$2 ORDER BY tcc.sequence_no`,[orgId,taxCode.id]);
  const components=componentRows.length?componentRows:[{sequence_no:1,tax_code_id:taxCode.id,code:taxCode.code,name:taxCode.name,tax_type:taxCode.tax_type,tax_scope:'import',box_code:taxCode.box_code,rate:taxCode.rate}];
  const breakdown=computeComponentTaxBreakdown({amount:transaction.taxable_amount,components:components.map(c=>({rate:c.rate,...c})),inclusive:false});
  await client.query(`DELETE FROM imported_service_tax_details WHERE organization_id=$1 AND imported_service_id=$2`,[orgId,transaction.id]);
  let totalRec=0n,totalNonRec=0n;
  for(const component of breakdown.components){
    const recovery=applyRecoverablePercent(component.taxAmount,transaction.recoverable_percent);
    totalRec += moneyToMinorUnits(recovery.recoverableAmount); totalNonRec += moneyToMinorUnits(recovery.nonRecoverableAmount);
    await client.query(
      `INSERT INTO imported_service_tax_details(organization_id,imported_service_id,sequence_no,source_tax_code_id,tax_code_id,tax_code,tax_name,tax_type,tax_scope,direction,box_code,taxable_amount,tax_rate,tax_amount,recoverable_percent,recoverable_amount,nonrecoverable_amount,recovery_basis,reverse_charge,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'import','reverse_charge',$9,$10,$11,$12,$13,$14,$15,$16,TRUE,$17::jsonb)`,
      [orgId,transaction.id,component.sequence_no||1,taxCode.id,component.tax_code_id,component.code,component.name,component.tax_type,component.box_code||'IMPORTED_SERVICES',breakdown.taxableAmount,component.rate,component.taxAmount,transaction.recoverable_percent,recovery.recoverableAmount,recovery.nonRecoverableAmount,transaction.recovery_basis,JSON.stringify({source:'GRA2_IMPORTED_SERVICES'})]
    );
  }
  const totalTax=minorUnitsToMoney(totalRec+totalNonRec);
  const {rows}=await client.query(`UPDATE imported_service_transactions SET total_tax_amount=$3,recoverable_tax_amount=$4,nonrecoverable_tax_amount=$5,updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,[orgId,transaction.id,totalTax,minorUnitsToMoney(totalRec),minorUnitsToMoney(totalNonRec)]);
  return rows[0];
}

function recoveryPercentForBasis({basis,explicit,settings}){
  if(explicit!=null) return String(explicit);
  if(basis==='direct_taxable') return '1';
  if(basis==='direct_exempt'||basis==='not_applicable') return '0';
  return String(settings.mixed_input_provisional_percent ?? 0);
}

async function createImportedService({orgId,actorUserId,payload}){
  return withTransaction(async(client)=>{
    if(payload.supplierId){const q=await client.query(`SELECT 1 FROM business_partners WHERE organization_id=$1 AND id=$2`,[orgId,payload.supplierId]);if(!q.rowCount)throw new AppError(400,'supplierId does not belong to this organization');}
    const taxCode=await resolveImportedServiceTaxCode({client,orgId,taxCodeId:payload.taxCodeId||null});
    const settings=await getSettings({client,orgId}); const bounds=monthBounds(payload.serviceDate);
    const start=payload.taxPeriodStart||bounds.start,end=payload.taxPeriodEnd||bounds.end;
    const basis=payload.recoveryBasis||'direct_taxable'; const pct=recoveryPercentForBasis({basis,explicit:payload.recoverablePercent,settings});
    const {rows}=await client.query(
      `INSERT INTO imported_service_transactions(organization_id,supplier_id,document_no,service_date,tax_period_start,tax_period_end,description,supplier_country_code,currency_code,foreign_amount,exchange_rate,taxable_amount,tax_code_id,recovery_basis,recoverable_percent,declaration_due_date,reference,evidence,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'GHS'),$10,$11,$12,$13,$14,$15,($6::date+21),$16,$17::jsonb,$18) RETURNING *`,
      [orgId,payload.supplierId||null,payload.documentNo||null,payload.serviceDate,start,end,payload.description,payload.supplierCountryCode||null,payload.currencyCode||null,payload.foreignAmount??null,payload.exchangeRate??null,String(payload.taxableAmount),taxCode.id,basis,pct,payload.reference||null,JSON.stringify(payload.evidence||{}),actorUserId||null]);
    await rebuildImportedServiceDetails({client,orgId,transaction:rows[0]});
    return getImportedService({orgId,importedServiceId:rows[0].id,client});
  });
}

async function updateImportedService({orgId,importedServiceId,payload}){
  return withTransaction(async(client)=>{
    const current=await getImportedService({orgId,importedServiceId,client}); if(current.status!=='draft')throw new AppError(409,'Only draft imported services can be edited');
    if(payload.taxCodeId) await resolveImportedServiceTaxCode({client,orgId,taxCodeId:payload.taxCodeId});
    if(payload.supplierId){const q=await client.query(`SELECT 1 FROM business_partners WHERE organization_id=$1 AND id=$2`,[orgId,payload.supplierId]);if(!q.rowCount)throw new AppError(400,'supplierId does not belong to this organization');}
    const settings=await getSettings({client,orgId}); const basis=payload.recoveryBasis??current.recovery_basis;
    const pct=payload.recoverablePercent!==undefined
      ? recoveryPercentForBasis({basis,explicit:payload.recoverablePercent,settings})
      : payload.recoveryBasis!==undefined
        ? recoveryPercentForBasis({basis,explicit:null,settings})
        : String(current.recoverable_percent);
    const map={supplierId:'supplier_id',documentNo:'document_no',serviceDate:'service_date',taxPeriodStart:'tax_period_start',taxPeriodEnd:'tax_period_end',description:'description',supplierCountryCode:'supplier_country_code',currencyCode:'currency_code',foreignAmount:'foreign_amount',exchangeRate:'exchange_rate',taxableAmount:'taxable_amount',taxCodeId:'tax_code_id',reference:'reference'};
    const sets=[]; const params=[orgId,importedServiceId]; let i=3;
    for(const [k,col] of Object.entries(map)){if(payload[k]!==undefined){sets.push(`${col}=$${i++}`);params.push(payload[k]);}}
    sets.push(`recovery_basis=$${i++}`);params.push(basis);sets.push(`recoverable_percent=$${i++}`);params.push(pct);
    if(payload.evidence!==undefined){sets.push(`evidence=$${i++}::jsonb`);params.push(JSON.stringify(payload.evidence||{}));}
    sets.push(`updated_at=NOW()`);
    const {rows}=await client.query(`UPDATE imported_service_transactions SET ${sets.join(',')} WHERE organization_id=$1 AND id=$2 RETURNING *`,params);
    await client.query(`UPDATE imported_service_transactions SET declaration_due_date=(tax_period_end+21) WHERE organization_id=$1 AND id=$2`,[orgId,importedServiceId]);
    await rebuildImportedServiceDetails({client,orgId,transaction:rows[0]}); return getImportedService({orgId,importedServiceId,client});
  });
}

async function postImportedService({orgId,actorUserId,importedServiceId}){
  return withTransaction(async(client)=>{
    const lock=await client.query(`SELECT * FROM imported_service_transactions WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[orgId,importedServiceId]);
    let transaction=lock.rows[0]; if(!transaction)throw new AppError(404,'Imported service transaction not found'); if(transaction.status==='posted')return getImportedService({orgId,importedServiceId,client}); if(transaction.status!=='draft')throw new AppError(409,'Only draft imported services can be posted');
    transaction=await rebuildImportedServiceDetails({client,orgId,transaction});
    const details=(await client.query(`SELECT * FROM imported_service_tax_details WHERE organization_id=$1 AND imported_service_id=$2 ORDER BY sequence_no`,[orgId,importedServiceId])).rows;
    const settings=await getSettings({client,orgId}); const liability=settings.reverse_charge_tax_account_id||settings.output_tax_account_id;
    if(!liability)throw new AppError(409,'Reverse-charge/output tax account is not configured');
    if(moneyToMinorUnits(transaction.recoverable_tax_amount)>0n&&!settings.input_tax_account_id)throw new AppError(409,'Input tax account is not configured');
    if(moneyToMinorUnits(transaction.nonrecoverable_tax_amount)>0n&&!settings.non_recoverable_input_tax_account_id)throw new AppError(409,'Non-recoverable input tax account is not configured');
    const period=await periodIF.findOpenPeriodForDate({orgId,date:transaction.service_date,client}); const lines=[];
    if(moneyToMinorUnits(transaction.recoverable_tax_amount)>0n)lines.push({accountId:settings.input_tax_account_id,debit:transaction.recoverable_tax_amount,credit:'0.00',description:`Recoverable tax on imported service ${transaction.document_no||''}`.trim()});
    if(moneyToMinorUnits(transaction.nonrecoverable_tax_amount)>0n)lines.push({accountId:settings.non_recoverable_input_tax_account_id,debit:transaction.nonrecoverable_tax_amount,credit:'0.00',description:`Non-recoverable tax on imported service ${transaction.document_no||''}`.trim()});
    lines.push({accountId:liability,debit:'0.00',credit:transaction.total_tax_amount,description:`Imported-services VAT liability ${transaction.document_no||''}`.trim()});
    const draft=await journalIF.createDraftJournal({orgId,actorUserId,client,payload:{periodId:period.id,entryDate:transaction.service_date,typeCode:'GENERAL',memo:`Imported services tax — ${transaction.description}`,idempotencyKey:`imported-service:${transaction.id}:post`,lines}});
    const posted=await journalIF.postDraftJournal({orgId,journalId:draft.journalId,actorUserId,client}); const journalId=posted.journalId||posted.id||draft.journalId;
    const upd=await client.query(`UPDATE imported_service_transactions SET status='posted',journal_entry_id=$3,posted_at=NOW(),posted_by=$4,updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,[orgId,importedServiceId,journalId,actorUserId||null]);
    for(const detail of details) await syncImportedServiceTaxDetailToLedger({client,orgId,importedServiceId,detail});
    return getImportedService({orgId,importedServiceId,client});
  });
}

async function voidImportedService({orgId,actorUserId,importedServiceId,reason}){
  return withTransaction(async(client)=>{
    const current=await getImportedService({orgId,importedServiceId,client}); if(current.status!=='posted')throw new AppError(409,'Only posted imported services can be voided');
    const reversal=await journalIF.voidPostedJournal({orgId,journalId:current.journal_entry_id,actorUserId,reason,client});
    await client.query(`UPDATE imported_service_transactions SET status='voided',reversal_journal_entry_id=$3,voided_at=NOW(),voided_by=$4,void_reason=$5,updated_at=NOW() WHERE organization_id=$1 AND id=$2`,[orgId,importedServiceId,reversal.journalId||reversal.reversalJournalId||null,actorUserId||null,reason]);
    return getImportedService({orgId,importedServiceId,client});
  });
}

module.exports={
  getVatRegistrationMonitor,
  calculateInputApportionment,
  listInputApportionments,
  postInputApportionment,
  voidInputApportionment,
  listImportedServices,
  getImportedService,
  createImportedService,
  updateImportedService,
  postImportedService,
  voidImportedService,
};
