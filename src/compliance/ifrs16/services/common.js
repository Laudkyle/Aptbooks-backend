const { pool } = require('../../../db/pool');
const { AppError } = require('../../../shared/errors/AppError');
const Decimal = require('decimal.js');
const workflow = require('../ifrs16.helpers');

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -10, toExpPos: 20 });

function toDecimal(value, defaultValue = new Decimal(0)) {
  if (value instanceof Decimal) return value;
  if (value === null || value === undefined || value === '') return defaultValue;
  try { return new Decimal(value); } catch { return defaultValue; }
}
function roundCurrency(value, decimals = 2) { return toDecimal(value).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP); }
function toCurrencyNumber(value, decimals = 2) { return roundCurrency(value, decimals).toNumber(); }
function toCurrencyString(value, decimals = 2) { return toDecimal(value).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed(decimals); }
function toISODate(d) { return workflow.toISODate(d); }
function buildIfrs16IdempotencyKey(parts) { return workflow.buildIfrs16IdempotencyKey(parts); }
function addMonths(date, months) {
  const d = new Date(date); const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}
function assertLeaseStatusAllowed(lease, allowed, action) {
  if (!allowed.includes(lease.status)) throw new AppError(409, `${action} is not allowed when lease status is '${lease.status}'`);
}

async function recordLeasePostingLedger({ client, orgId, actorUserId, leaseId, scheduleLineId, modificationId, action, idempotencyKey, journalEntryId }) {
  await client.query(`INSERT INTO lease_posting_ledger(organization_id,lease_id,schedule_line_id,modification_id,action,idempotency_key,journal_entry_id,created_by)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                      ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
    [orgId, leaseId, scheduleLineId || null, modificationId || null, action, idempotencyKey, journalEntryId, actorUserId]);
}
async function recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType, payload = {} }) {
  await client.query(`INSERT INTO lease_events(organization_id, lease_id, event_type, event_payload, created_by) VALUES ($1,$2,$3,$4,$5)`,
    [orgId, leaseId, eventType, payload, actorUserId]);
}
async function assertPostableAccount({ orgId, accountId, label, client = pool }) {
  const { rows } = await client.query(`SELECT id, status, is_postable FROM chart_of_accounts WHERE organization_id=$1 AND id=$2 LIMIT 1`, [orgId, accountId]);
  if (!rows.length) throw new AppError(400, `Invalid ${label}`);
  if (rows[0].status !== 'active') throw new AppError(400, `${label} must be an active account`);
  if (!rows[0].is_postable) throw new AppError(400, `${label} must be postable`);
}
async function getValidCurrencyCode({ requestedCode, client = pool }) {
  const requested = String(requestedCode || '').trim().toUpperCase();
  if (requested) {
    const { rows } = await client.query(`SELECT code FROM currencies WHERE code=$1 LIMIT 1`, [requested]);
    if (!rows.length) throw new AppError(400, `Invalid currency code '${requested}'`);
    return rows[0].code;
  }
  const { rows: preferred } = await client.query(`SELECT code FROM currencies WHERE code IN ('GHS','USD') ORDER BY CASE code WHEN 'GHS' THEN 1 WHEN 'USD' THEN 2 ELSE 3 END LIMIT 1`);
  if (preferred.length) return preferred[0].code;
  const { rows } = await client.query(`SELECT code FROM currencies ORDER BY code LIMIT 1`);
  if (!rows.length) throw new AppError(400, 'No currencies are configured in reference data');
  return rows[0].code;
}
async function getLeaseBase({ orgId, leaseId, client = pool }) {
  const { rows } = await client.query(`SELECT l.*,
      coa_cash.name AS cash_account_name,
      coa_rou.name AS rou_asset_account_name,
      coa_ll.name AS lease_liability_account_name,
      coa_ad.name AS accumulated_depreciation_account_name,
      coa_de.name AS depreciation_expense_account_name,
      coa_ie.name AS interest_expense_account_name
    FROM leases l
    LEFT JOIN chart_of_accounts coa_cash ON coa_cash.id = l.cash_account_id
    LEFT JOIN chart_of_accounts coa_rou ON coa_rou.id = l.rou_asset_account_id
    LEFT JOIN chart_of_accounts coa_ll ON coa_ll.id = l.lease_liability_account_id
    LEFT JOIN chart_of_accounts coa_ad ON coa_ad.id = l.accumulated_depreciation_account_id
    LEFT JOIN chart_of_accounts coa_de ON coa_de.id = l.depreciation_expense_account_id
    LEFT JOIN chart_of_accounts coa_ie ON coa_ie.id = l.interest_expense_account_id
    WHERE l.id=$1 AND l.organization_id=$2 LIMIT 1`, [leaseId, orgId]);
  if (!rows.length) throw new AppError(404, 'Lease not found');
  return rows[0];
}
async function getLeaseSnapshot({ orgId, leaseId, client = pool }) {
  const lease = await getLeaseBase({ orgId, leaseId, client });
  const [contractRows, assetRows, paymentRows, modRows, schedRows, snapRows] = await Promise.all([
    client.query(`SELECT * FROM lease_contracts WHERE lease_id=$1 AND organization_id=$2 LIMIT 1`, [leaseId, orgId]),
    client.query(`SELECT * FROM lease_assets WHERE lease_id=$1 AND organization_id=$2 ORDER BY is_primary DESC, created_at ASC`, [leaseId, orgId]),
    client.query(`SELECT * FROM lease_payments WHERE lease_id=$1 AND organization_id=$2 ORDER BY due_date ASC, created_at ASC`, [leaseId, orgId]),
    client.query(`SELECT * FROM lease_modifications WHERE lease_id=$1 AND organization_id=$2 ORDER BY effective_date DESC, created_at DESC`, [leaseId, orgId]),
    client.query(`SELECT * FROM lease_schedule_lines WHERE lease_id=$1 ORDER BY line_no ASC`, [leaseId]),
    client.query(`SELECT * FROM lease_measurement_snapshots WHERE lease_id=$1 AND organization_id=$2 ORDER BY effective_date DESC, created_at DESC`, [leaseId, orgId]),
  ]);
  return { lease, contract: contractRows.rows[0] || null, assets: assetRows.rows, payments: paymentRows.rows, modifications: modRows.rows, schedule: schedRows.rows, measurement_snapshots: snapRows.rows };
}

module.exports = {
  pool, AppError, Decimal, workflow,
  toDecimal, roundCurrency, toCurrencyNumber, toCurrencyString, toISODate, buildIfrs16IdempotencyKey, addMonths, assertLeaseStatusAllowed,
  recordLeasePostingLedger, recordLeaseEvent, assertPostableAccount, getValidCurrencyCode, getLeaseBase, getLeaseSnapshot,
};
