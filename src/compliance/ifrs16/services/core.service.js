const {
  pool, AppError, toDecimal, toISODate,
  recordLeaseEvent, assertPostableAccount, getValidCurrencyCode, getLeaseBase, getLeaseSnapshot,
} = require('./common');

async function getSettings({ orgId, client = pool }) {
  const { rows } = await client.query(
    `SELECT organization_id, default_term_months, default_payments_per_year, default_annual_discount_rate, default_payment_timing,
            rou_asset_account_id, lease_liability_account_id, interest_expense_account_id, depreciation_expense_account_id,
            accumulated_depreciation_account_id, cash_account_id, default_notes_template, created_at, updated_at
       FROM ifrs16_settings
      WHERE organization_id=$1`,
    [orgId]
  );
  return rows[0] || {
    organization_id: orgId,
    default_term_months: null,
    default_payments_per_year: null,
    default_annual_discount_rate: null,
    default_payment_timing: 'arrears',
    rou_asset_account_id: null,
    lease_liability_account_id: null,
    interest_expense_account_id: null,
    depreciation_expense_account_id: null,
    accumulated_depreciation_account_id: null,
    cash_account_id: null,
    default_notes_template: '',
    created_at: null,
    updated_at: null,
  };
}

async function upsertSettings({ orgId, actorUserId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const accountChecks = [
      ['rou_asset_account_id', 'ROU asset account'],
      ['lease_liability_account_id', 'Lease liability account'],
      ['interest_expense_account_id', 'Interest expense account'],
      ['depreciation_expense_account_id', 'Depreciation expense account'],
      ['accumulated_depreciation_account_id', 'Accumulated depreciation account'],
      ['cash_account_id', 'Cash account'],
    ];
    for (const [field, label] of accountChecks) if (payload[field]) await assertPostableAccount({ orgId, accountId: payload[field], label, client });
    const { rows } = await client.query(
      `INSERT INTO ifrs16_settings(
          organization_id, default_term_months, default_payments_per_year, default_annual_discount_rate, default_payment_timing,
          rou_asset_account_id, lease_liability_account_id, interest_expense_account_id, depreciation_expense_account_id,
          accumulated_depreciation_account_id, cash_account_id, default_notes_template, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,COALESCE($5,'arrears'),$6,$7,$8,$9,$10,$11,$12,$13,$13)
       ON CONFLICT (organization_id) DO UPDATE SET
          default_term_months = EXCLUDED.default_term_months,
          default_payments_per_year = EXCLUDED.default_payments_per_year,
          default_annual_discount_rate = EXCLUDED.default_annual_discount_rate,
          default_payment_timing = EXCLUDED.default_payment_timing,
          rou_asset_account_id = EXCLUDED.rou_asset_account_id,
          lease_liability_account_id = EXCLUDED.lease_liability_account_id,
          interest_expense_account_id = EXCLUDED.interest_expense_account_id,
          depreciation_expense_account_id = EXCLUDED.depreciation_expense_account_id,
          accumulated_depreciation_account_id = EXCLUDED.accumulated_depreciation_account_id,
          cash_account_id = EXCLUDED.cash_account_id,
          default_notes_template = EXCLUDED.default_notes_template,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
       RETURNING *`,
      [orgId, payload.default_term_months ?? null, payload.default_payments_per_year ?? null, payload.default_annual_discount_rate ?? null, payload.default_payment_timing ?? null,
        payload.rou_asset_account_id ?? null, payload.lease_liability_account_id ?? null, payload.interest_expense_account_id ?? null, payload.depreciation_expense_account_id ?? null,
        payload.accumulated_depreciation_account_id ?? null, payload.cash_account_id ?? null, payload.default_notes_template ?? '', actorUserId]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

async function listLeases({ orgId, query }) {
  const limit = Math.min(Number(query?.limit || 50), 200); const offset = Math.max(Number(query?.offset || 0), 0);
  const status = query?.status; const where = ['organization_id=$1']; const params = [orgId];
  if (status) { params.push(status); where.push(`status=$${params.length}`); }
  const { rows } = await pool.query(`SELECT l.id, l.code, l.name, l.status, l.commencement_date, l.term_months, l.payment_amount, l.payments_per_year, l.annual_discount_rate, l.payment_timing,
      l.workflow_document_id, l.submitted_at, l.approved_at, l.initial_recognition_date, l.initial_recognition_journal_id, l.created_at, l.updated_at,
      l.recognition_model, l.is_short_term_lease, l.is_low_value_lease,
      c.currency_code, c.contract_reference
    FROM leases l
    LEFT JOIN lease_contracts c ON c.lease_id = l.id AND c.organization_id = l.organization_id
    WHERE ${where.map((clause) => clause.replace(/\borganization_id\b/g, 'l.organization_id').replace(/\bstatus\b/g, 'l.status')).join(' AND ')}
    ORDER BY l.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
  [...params, limit, offset]);
  return { items: rows, limit, offset };
}

async function createLease({ orgId, actorUserId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const settings = await getSettings({ orgId, client });
    const generatedCode = payload.code || `LEASE-${Date.now()}`;
    const leasePayload = {
      ...payload,
      code: generatedCode,
      payment_timing: payload.payment_timing || settings.default_payment_timing || 'arrears',
      rou_asset_account_id: payload.rou_asset_account_id || settings.rou_asset_account_id,
      lease_liability_account_id: payload.lease_liability_account_id || settings.lease_liability_account_id,
      interest_expense_account_id: payload.interest_expense_account_id || settings.interest_expense_account_id,
      depreciation_expense_account_id: payload.depreciation_expense_account_id || settings.depreciation_expense_account_id,
      accumulated_depreciation_account_id: payload.accumulated_depreciation_account_id || settings.accumulated_depreciation_account_id,
      cash_account_id: payload.cash_account_id || settings.cash_account_id,
    };
    const currencyCode = await getValidCurrencyCode({ requestedCode: leasePayload.currency_code, client });
    const { rows: existing } = await client.query(`SELECT 1 FROM leases WHERE organization_id=$1 AND code=$2 LIMIT 1`, [orgId, leasePayload.code]);
    if (existing.length) throw new AppError(409, 'Lease code already exists');

    const recognitionModel = leasePayload.recognition_model || (leasePayload.is_short_term_lease ? 'short_term_exempt' : leasePayload.is_low_value_lease ? 'low_value_exempt' : 'on_balance_sheet');
    const requiredAccountFields = recognitionModel === 'on_balance_sheet'
      ? [
          ['rou_asset_account_id', 'ROU asset account'], ['lease_liability_account_id', 'Lease liability account'], ['interest_expense_account_id', 'Interest expense account'],
          ['depreciation_expense_account_id', 'Depreciation expense account'], ['accumulated_depreciation_account_id', 'Accumulated depreciation account'], ['cash_account_id', 'Cash account'],
        ]
      : [
          ['depreciation_expense_account_id', 'Lease expense account'], ['cash_account_id', 'Cash/bank account'],
        ];
    for (const [field, label] of requiredAccountFields) {
      if (!leasePayload[field]) throw new AppError(409, `${label} is required on the lease or in IFRS 16 settings`);
    }
    for (const [field, label] of [
      ['rou_asset_account_id', 'ROU asset account'], ['lease_liability_account_id', 'Lease liability account'], ['interest_expense_account_id', 'Interest expense account'],
      ['depreciation_expense_account_id', 'Depreciation/lease expense account'], ['accumulated_depreciation_account_id', 'Accumulated depreciation account'], ['cash_account_id', 'Cash/bank account'],
    ]) {
      if (leasePayload[field]) await assertPostableAccount({ orgId, accountId: leasePayload[field], label, client });
    }

    const { rows } = await client.query(`INSERT INTO leases(
      organization_id,code,name,status,commencement_date,term_months,payment_amount,payments_per_year,annual_discount_rate,payment_timing,
      rou_asset_account_id,lease_liability_account_id,interest_expense_account_id,depreciation_expense_account_id,accumulated_depreciation_account_id,cash_account_id,
      recognition_model,is_short_term_lease,is_low_value_lease,practical_expedient_non_lease_components,ownership_transfers,purchase_option_reasonably_certain,created_by)
      VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      RETURNING *`,
      [orgId, leasePayload.code, leasePayload.name, toISODate(leasePayload.commencement_date), Number(leasePayload.term_months), leasePayload.payment_amount, leasePayload.payments_per_year,
        leasePayload.annual_discount_rate, leasePayload.payment_timing, leasePayload.rou_asset_account_id, leasePayload.lease_liability_account_id,
        leasePayload.interest_expense_account_id, leasePayload.depreciation_expense_account_id, leasePayload.accumulated_depreciation_account_id, leasePayload.cash_account_id,
        recognitionModel, !!leasePayload.is_short_term_lease, !!leasePayload.is_low_value_lease, !!leasePayload.practical_expedient_non_lease_components,
        !!leasePayload.ownership_transfers, !!leasePayload.purchase_option_reasonably_certain, actorUserId]);
    const lease = rows[0];

    await client.query(`INSERT INTO lease_contracts(lease_id,organization_id,contract_reference,currency_code,payment_timing,indexation,initial_direct_costs,lease_incentives,restoration_provision,
      has_purchase_option,has_extension_option,has_termination_option,residual_value_guarantee,prepaid_lease_payments,accrued_lease_payments,purchase_option_amount)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (lease_id) DO UPDATE SET updated_at=NOW()`,
      [lease.id, orgId, leasePayload.contract_reference || leasePayload.code, currencyCode, leasePayload.payment_timing, leasePayload.indexation || null,
        leasePayload.initial_direct_costs || null, leasePayload.lease_incentives || null, leasePayload.restoration_provision || null,
        !!leasePayload.has_purchase_option, !!leasePayload.has_extension_option, !!leasePayload.has_termination_option,
        leasePayload.residual_value_guarantee || null, leasePayload.prepaid_lease_payments || null, leasePayload.accrued_lease_payments || null,
        leasePayload.purchase_option_amount || null]);
    await client.query(`INSERT INTO lease_assets(lease_id,organization_id,asset_code,description,asset_class,useful_life_months,rou_cost,is_primary)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)`,
      [lease.id, orgId, leasePayload.asset_code || leasePayload.code, leasePayload.asset_description || leasePayload.name, leasePayload.asset_class || null, leasePayload.useful_life_months || leasePayload.term_months, null]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId: lease.id, eventType: 'LEASE_CREATED', payload: { code: lease.code, commencement_date: lease.commencement_date, recognition_model: recognitionModel } });
    await client.query('COMMIT');
    return lease;
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

async function getLease({ orgId, leaseId }) { return getLeaseSnapshot({ orgId, leaseId, client: pool }); }

async function upsertContract({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await getLeaseBase({ orgId, leaseId, client });
    const currencyCode = await getValidCurrencyCode({ requestedCode: payload.currency_code, client });
    const { rows } = await client.query(`INSERT INTO lease_contracts(
        lease_id, organization_id, counterparty_partner_id, contract_reference, currency_code, payment_timing, indexation,
        has_purchase_option, has_extension_option, has_termination_option, residual_value_guarantee, initial_direct_costs, lease_incentives, restoration_provision,
        prepaid_lease_payments, accrued_lease_payments, purchase_option_amount)
      VALUES ($1,$2,$3,$4,COALESCE($5,'USD'),COALESCE($6,'arrears'),$7,COALESCE($8,FALSE),COALESCE($9,FALSE),COALESCE($10,FALSE),$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (lease_id) DO UPDATE SET
        counterparty_partner_id=EXCLUDED.counterparty_partner_id, contract_reference=EXCLUDED.contract_reference, currency_code=EXCLUDED.currency_code,
        payment_timing=EXCLUDED.payment_timing, indexation=EXCLUDED.indexation, has_purchase_option=EXCLUDED.has_purchase_option,
        has_extension_option=EXCLUDED.has_extension_option, has_termination_option=EXCLUDED.has_termination_option, residual_value_guarantee=EXCLUDED.residual_value_guarantee,
        initial_direct_costs=EXCLUDED.initial_direct_costs, lease_incentives=EXCLUDED.lease_incentives, restoration_provision=EXCLUDED.restoration_provision,
        prepaid_lease_payments=EXCLUDED.prepaid_lease_payments, accrued_lease_payments=EXCLUDED.accrued_lease_payments, purchase_option_amount=EXCLUDED.purchase_option_amount,
        updated_at=NOW() RETURNING *`,
      [leaseId, orgId, payload.counterparty_partner_id || null, payload.contract_reference || null, currencyCode, payload.payment_timing || 'arrears', payload.indexation || null,
       payload.has_purchase_option ?? false, payload.has_extension_option ?? false, payload.has_termination_option ?? false, payload.residual_value_guarantee || null,
       payload.initial_direct_costs || null, payload.lease_incentives || null, payload.restoration_provision || null, payload.prepaid_lease_payments || null,
       payload.accrued_lease_payments || null, payload.purchase_option_amount || null]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType: 'CONTRACT_UPSERTED', payload: rows[0] });
    await client.query('COMMIT');
    return rows[0];
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function listAssets({ orgId, leaseId }) { await getLeaseBase({ orgId, leaseId, client: pool }); const { rows } = await pool.query(`SELECT * FROM lease_assets WHERE organization_id=$1 AND lease_id=$2 ORDER BY is_primary DESC, created_at ASC`, [orgId, leaseId]); return { items: rows }; }
async function createAsset({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect(); try { await client.query('BEGIN'); await getLeaseBase({ orgId, leaseId, client });
    if (payload.is_primary) await client.query(`UPDATE lease_assets SET is_primary=FALSE, updated_at=NOW() WHERE organization_id=$1 AND lease_id=$2`, [orgId, leaseId]);
    const { rows } = await client.query(`INSERT INTO lease_assets(lease_id,organization_id,asset_code,description,asset_class,useful_life_months,rou_cost,is_primary)
      VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8,FALSE)) RETURNING *`, [leaseId,orgId,payload.asset_code || null,payload.description,payload.asset_class || null,payload.useful_life_months || null,payload.rou_cost ?? null,payload.is_primary ?? false]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'ASSET_CREATED', payload: rows[0] }); await client.query('COMMIT'); return rows[0];
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
async function updateAsset({ orgId, actorUserId, leaseId, assetId, payload }) {
  const client = await pool.connect(); try { await client.query('BEGIN'); await getLeaseBase({ orgId, leaseId, client }); if (payload.is_primary) await client.query(`UPDATE lease_assets SET is_primary=FALSE, updated_at=NOW() WHERE organization_id=$1 AND lease_id=$2`, [orgId, leaseId]);
    const { rows } = await client.query(`UPDATE lease_assets SET asset_code=COALESCE($4,asset_code), description=COALESCE($5,description), asset_class=COALESCE($6,asset_class), useful_life_months=COALESCE($7,useful_life_months), rou_cost=COALESCE($8,rou_cost), is_primary=COALESCE($9,is_primary), updated_at=NOW()
      WHERE organization_id=$1 AND lease_id=$2 AND id=$3 RETURNING *`, [orgId, leaseId, assetId, payload.asset_code ?? null, payload.description ?? null, payload.asset_class ?? null, payload.useful_life_months ?? null, payload.rou_cost ?? null, payload.is_primary ?? null]);
    if (!rows.length) throw new AppError(404,'Lease asset not found'); await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'ASSET_UPDATED', payload: rows[0] }); await client.query('COMMIT'); return rows[0];
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
async function deleteAsset({ orgId, actorUserId, leaseId, assetId }) { const client = await pool.connect(); try { await client.query('BEGIN'); const { rows } = await client.query(`DELETE FROM lease_assets WHERE organization_id=$1 AND lease_id=$2 AND id=$3 RETURNING *`, [orgId, leaseId, assetId]); if (!rows.length) throw new AppError(404,'Lease asset not found'); await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'ASSET_DELETED', payload:{ asset_id: assetId } }); await client.query('COMMIT'); return { deleted: true }; } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }

async function listPayments({ orgId, leaseId }) { await getLeaseBase({ orgId, leaseId, client: pool }); const { rows } = await pool.query(`SELECT * FROM lease_payments WHERE organization_id=$1 AND lease_id=$2 ORDER BY due_date ASC, created_at ASC`, [orgId, leaseId]); return { items: rows }; }
async function createPayment({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect(); try { await client.query('BEGIN'); await getLeaseBase({ orgId, leaseId, client });
    let scheduleLineId = payload.schedule_line_id || null;
    if (!scheduleLineId) {
      const { rows: sched } = await client.query(`SELECT id FROM lease_schedule_lines WHERE lease_id=$1 AND due_date=$2 ORDER BY line_no ASC LIMIT 1`, [leaseId, toISODate(payload.due_date)]);
      scheduleLineId = sched[0]?.id || null;
    }
    const amount = toDecimal(payload.amount);
    if (!amount.greaterThan(0)) throw new AppError(400, 'Payment amount must be greater than 0');
    const { rows } = await client.query(`INSERT INTO lease_payments(lease_id,organization_id,due_date,amount,payment_type,is_actual,paid_date,reference,schedule_line_id,created_by)
      VALUES($1,$2,$3,$4,$5,COALESCE($6,FALSE),$7,$8,$9,$10) RETURNING *`, [leaseId, orgId, toISODate(payload.due_date), amount.toFixed(6), payload.payment_type || 'fixed', payload.is_actual ?? false, payload.paid_date ? toISODate(payload.paid_date) : null, payload.reference || null, scheduleLineId, actorUserId]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'PAYMENT_RECORDED', payload: rows[0] }); await client.query('COMMIT'); return rows[0];
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }

function hasOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj || {}, key); }
function valueOrNull(payload, field) { return hasOwn(payload, field) ? (payload[field] ?? null) : undefined; }

async function assertLeaseEditable({ orgId, leaseId, client }) {
  const lease = await getLeaseBase({ orgId, leaseId, client });
  if (lease.status !== 'draft') throw new AppError(409, `Lease can only be edited while draft. Current status is '${lease.status}'`);
  if (lease.initial_recognition_journal_id || lease.initial_recognition_date) throw new AppError(409, 'Lease cannot be edited after initial recognition has been posted');
  return lease;
}

async function updateLease({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lease = await assertLeaseEditable({ orgId, leaseId, client });
    if (payload.code && payload.code !== lease.code) {
      const { rows: existing } = await client.query(`SELECT 1 FROM leases WHERE organization_id=$1 AND code=$2 AND id<>$3 LIMIT 1`, [orgId, payload.code, leaseId]);
      if (existing.length) throw new AppError(409, 'Lease code already exists');
    }
    const recognitionModel = payload.recognition_model || lease.recognition_model || (payload.is_short_term_lease ? 'short_term_exempt' : payload.is_low_value_lease ? 'low_value_exempt' : 'on_balance_sheet');
    const accountUpdates = ['rou_asset_account_id','lease_liability_account_id','interest_expense_account_id','depreciation_expense_account_id','accumulated_depreciation_account_id','cash_account_id'];
    for (const field of accountUpdates) if (payload[field]) await assertPostableAccount({ orgId, accountId: payload[field], label: field, client });
    const required = recognitionModel === 'on_balance_sheet'
      ? ['rou_asset_account_id','lease_liability_account_id','interest_expense_account_id','depreciation_expense_account_id','accumulated_depreciation_account_id','cash_account_id']
      : ['depreciation_expense_account_id','cash_account_id'];
    for (const field of required) {
      const next = hasOwn(payload, field) ? payload[field] : lease[field];
      if (!next) throw new AppError(409, `${field} is required for ${recognitionModel} leases`);
    }
    const fields = [
      ['code', payload.code], ['name', payload.name], ['commencement_date', payload.commencement_date ? toISODate(payload.commencement_date) : undefined],
      ['term_months', payload.term_months], ['payment_amount', payload.payment_amount], ['payments_per_year', payload.payments_per_year], ['annual_discount_rate', payload.annual_discount_rate],
      ['payment_timing', payload.payment_timing], ['recognition_model', recognitionModel], ['is_short_term_lease', payload.is_short_term_lease], ['is_low_value_lease', payload.is_low_value_lease],
      ['practical_expedient_non_lease_components', payload.practical_expedient_non_lease_components], ['ownership_transfers', payload.ownership_transfers],
      ['purchase_option_reasonably_certain', payload.purchase_option_reasonably_certain], ['rou_asset_account_id', payload.rou_asset_account_id], ['lease_liability_account_id', payload.lease_liability_account_id],
      ['interest_expense_account_id', payload.interest_expense_account_id], ['depreciation_expense_account_id', payload.depreciation_expense_account_id], ['accumulated_depreciation_account_id', payload.accumulated_depreciation_account_id], ['cash_account_id', payload.cash_account_id],
    ].filter(([, value]) => value !== undefined);
    if (fields.length) {
      const sets = fields.map(([field], idx) => `${field}=$${idx + 3}`);
      const values = fields.map(([, value]) => value);
      await client.query(`UPDATE leases SET ${sets.join(', ')}, updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, leaseId, ...values]);
    }
    const contractFields = ['contract_reference','currency_code','payment_timing','indexation','has_purchase_option','has_extension_option','has_termination_option','residual_value_guarantee','initial_direct_costs','lease_incentives','restoration_provision','prepaid_lease_payments','accrued_lease_payments','purchase_option_amount'];
    if (contractFields.some((field) => hasOwn(payload, field))) {
      const currencyCode = await getValidCurrencyCode({ requestedCode: payload.currency_code, client });
      await client.query(`INSERT INTO lease_contracts(
          lease_id,organization_id,contract_reference,currency_code,payment_timing,indexation,has_purchase_option,has_extension_option,has_termination_option,
          residual_value_guarantee,initial_direct_costs,lease_incentives,restoration_provision,prepaid_lease_payments,accrued_lease_payments,purchase_option_amount)
        VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,FALSE),COALESCE($8,FALSE),COALESCE($9,FALSE),$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (lease_id) DO UPDATE SET
          contract_reference=COALESCE(EXCLUDED.contract_reference, lease_contracts.contract_reference), currency_code=EXCLUDED.currency_code,
          payment_timing=COALESCE(EXCLUDED.payment_timing, lease_contracts.payment_timing), indexation=COALESCE(EXCLUDED.indexation, lease_contracts.indexation),
          has_purchase_option=EXCLUDED.has_purchase_option, has_extension_option=EXCLUDED.has_extension_option, has_termination_option=EXCLUDED.has_termination_option,
          residual_value_guarantee=EXCLUDED.residual_value_guarantee, initial_direct_costs=EXCLUDED.initial_direct_costs, lease_incentives=EXCLUDED.lease_incentives,
          restoration_provision=EXCLUDED.restoration_provision, prepaid_lease_payments=EXCLUDED.prepaid_lease_payments,
          accrued_lease_payments=EXCLUDED.accrued_lease_payments, purchase_option_amount=EXCLUDED.purchase_option_amount, updated_at=NOW()`,
        [leaseId, orgId, payload.contract_reference || payload.code || null, currencyCode, payload.payment_timing || lease.payment_timing || 'arrears', payload.indexation || null,
          payload.has_purchase_option ?? false, payload.has_extension_option ?? false, payload.has_termination_option ?? false,
          valueOrNull(payload,'residual_value_guarantee'), valueOrNull(payload,'initial_direct_costs'), valueOrNull(payload,'lease_incentives'), valueOrNull(payload,'restoration_provision'),
          valueOrNull(payload,'prepaid_lease_payments'), valueOrNull(payload,'accrued_lease_payments'), valueOrNull(payload,'purchase_option_amount')]);
    }
    await client.query(`DELETE FROM lease_schedule_lines WHERE lease_id=$1`, [leaseId]);
    await client.query(`UPDATE lease_payments SET schedule_line_id=NULL, updated_at=NOW() WHERE organization_id=$1 AND lease_id=$2 AND is_actual=FALSE`, [orgId, leaseId]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'LEASE_UPDATED', payload });
    await client.query('COMMIT');
    return getLeaseSnapshot({ orgId, leaseId, client: pool });
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function deleteLease({ orgId, actorUserId, leaseId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lease = await assertLeaseEditable({ orgId, leaseId, client });
    const { rows: posted } = await client.query(`SELECT 1 FROM lease_posting_ledger WHERE organization_id=$1 AND lease_id=$2 LIMIT 1`, [orgId, leaseId]);
    if (posted.length) throw new AppError(409, 'Lease cannot be deleted because it has posting ledger entries');
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'LEASE_DELETED', payload:{ code: lease.code } });
    await client.query(`DELETE FROM leases WHERE organization_id=$1 AND id=$2`, [orgId, leaseId]);
    await client.query('COMMIT');
    return { deleted: true };
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function updatePayment({ orgId, actorUserId, leaseId, paymentId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await getLeaseBase({ orgId, leaseId, client });
    const { rows: paymentRows } = await client.query(`SELECT p.*, sl.posted_interest_payment_journal_id, sl.posted_depreciation_journal_id FROM lease_payments p LEFT JOIN lease_schedule_lines sl ON sl.id=p.schedule_line_id WHERE p.organization_id=$1 AND p.lease_id=$2 AND p.id=$3 FOR UPDATE`, [orgId, leaseId, paymentId]);
    if (!paymentRows.length) throw new AppError(404, 'Lease payment not found');
    const existing = paymentRows[0];
    if (existing.posted_interest_payment_journal_id || existing.posted_depreciation_journal_id) throw new AppError(409, 'Payment cannot be edited because its schedule line has been posted');
    const fields = [
      ['due_date', payload.due_date ? toISODate(payload.due_date) : undefined], ['amount', payload.amount], ['payment_type', payload.payment_type],
      ['is_actual', payload.is_actual], ['paid_date', payload.paid_date ? toISODate(payload.paid_date) : undefined], ['reference', payload.reference], ['schedule_line_id', payload.schedule_line_id]
    ].filter(([, value]) => value !== undefined);
    if (!fields.length) throw new AppError(400, 'No payment fields supplied');
    const sets = fields.map(([field], idx) => `${field}=$${idx + 4}`);
    const values = fields.map(([, value]) => value);
    const { rows } = await client.query(`UPDATE lease_payments SET ${sets.join(', ')}, updated_at=NOW() WHERE organization_id=$1 AND lease_id=$2 AND id=$3 RETURNING *`, [orgId, leaseId, paymentId, ...values]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'PAYMENT_UPDATED', payload: rows[0] });
    await client.query('COMMIT');
    return rows[0];
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function deletePayment({ orgId, actorUserId, leaseId, paymentId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await getLeaseBase({ orgId, leaseId, client });
    const { rows: paymentRows } = await client.query(`SELECT p.*, sl.posted_interest_payment_journal_id, sl.posted_depreciation_journal_id FROM lease_payments p LEFT JOIN lease_schedule_lines sl ON sl.id=p.schedule_line_id WHERE p.organization_id=$1 AND p.lease_id=$2 AND p.id=$3 FOR UPDATE`, [orgId, leaseId, paymentId]);
    if (!paymentRows.length) throw new AppError(404, 'Lease payment not found');
    const existing = paymentRows[0];
    if (existing.reference && String(existing.reference).startsWith('schedule:')) throw new AppError(409, 'Scheduled lease payments cannot be deleted directly. Regenerate the schedule instead.');
    if (existing.posted_interest_payment_journal_id || existing.posted_depreciation_journal_id) throw new AppError(409, 'Payment cannot be deleted because its schedule line has been posted');
    await client.query(`DELETE FROM lease_payments WHERE organization_id=$1 AND lease_id=$2 AND id=$3`, [orgId, leaseId, paymentId]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'PAYMENT_DELETED', payload:{ payment_id: paymentId } });
    await client.query('COMMIT');
    return { deleted: true };
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}


module.exports = {
  getSettings, upsertSettings, listLeases, createLease, updateLease, deleteLease, getLease, upsertContract,
  listAssets, createAsset, updateAsset, deleteAsset, listPayments, createPayment, updatePayment, deletePayment,
};
