const { queryMany, queryOne, requireDbClient, requireOrganizationId } = require('../../../shared/db/repositoryStandard');

async function ensureDefault({ client, orgId, actorUserId, policy }) {
  requireDbClient(client);
  requireOrganizationId(orgId);
  await client.query(
    `INSERT INTO accounting_policy_versions
      (organization_id, version_no, effective_from, status, money_scale, exchange_rate_scale,
       inventory_value_scale, rounding_mode, tax_rounding_scope, posting_date_policy,
       closed_period_adjustment_policy, reversal_policy, created_by, policy_json)
     VALUES ($1,1,DATE '1900-01-01','active',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (organization_id, version_no) DO NOTHING`,
    [orgId, policy.moneyScale, policy.exchangeRateScale, policy.inventoryValueScale, policy.roundingMode,
      policy.taxRoundingScope, policy.postingDatePolicy, policy.closedPeriodAdjustmentPolicy,
      policy.reversalPolicy, actorUserId, JSON.stringify(policy)]
  );
}

function findEffective({ client, orgId, asOfDate }) {
  requireOrganizationId(orgId);
  return queryOne(client,
    `SELECT id, organization_id, version_no, effective_from, effective_to, status,
            money_scale, exchange_rate_scale, inventory_value_scale, rounding_mode,
            tax_rounding_scope, posting_date_policy, closed_period_adjustment_policy,
            reversal_policy, created_by, created_at, policy_json
       FROM accounting_policy_versions
      WHERE organization_id=$1 AND status='active' AND effective_from <= $2::date
      ORDER BY effective_from DESC, version_no DESC LIMIT 1`,
    [orgId, asOfDate]);
}

function findVersionOne({ client, orgId }) {
  requireOrganizationId(orgId);
  return queryOne(client,
    `SELECT id, organization_id, version_no, effective_from, effective_to, status,
            money_scale, exchange_rate_scale, inventory_value_scale, rounding_mode,
            tax_rounding_scope, posting_date_policy, closed_period_adjustment_policy,
            reversal_policy, created_by, created_at, policy_json
       FROM accounting_policy_versions WHERE organization_id=$1 AND version_no=1 LIMIT 1`, [orgId]);
}

function listVersions({ client, orgId }) {
  requireOrganizationId(orgId);
  return queryMany(client,
    `SELECT id, organization_id, version_no, effective_from, effective_to, status,
            money_scale, exchange_rate_scale, inventory_value_scale, rounding_mode,
            tax_rounding_scope, posting_date_policy, closed_period_adjustment_policy,
            reversal_policy, created_by, created_at, policy_json
       FROM accounting_policy_versions WHERE organization_id=$1 ORDER BY version_no DESC`, [orgId]);
}

function lockLatestVersion({ client, orgId }) {
  requireOrganizationId(orgId);
  return queryOne(client,
    `SELECT id, organization_id, version_no, effective_from, status
       FROM accounting_policy_versions WHERE organization_id=$1
      ORDER BY version_no DESC LIMIT 1 FOR UPDATE`, [orgId]);
}

function latestPostedEntryDate({ client, orgId }) {
  requireOrganizationId(orgId);
  return queryOne(client,
    `SELECT MAX(entry_date) AS latest_entry_date
       FROM journal_entries WHERE organization_id=$1 AND status IN ('posted','voided')`, [orgId]);
}

function insertVersion({ client, orgId, actorUserId, effectiveFrom, version, policy }) {
  requireOrganizationId(orgId);
  return queryOne(client,
    `INSERT INTO accounting_policy_versions
      (organization_id, version_no, effective_from, status, money_scale, exchange_rate_scale,
       inventory_value_scale, rounding_mode, tax_rounding_scope, posting_date_policy,
       closed_period_adjustment_policy, reversal_policy, created_by, policy_json)
     VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     RETURNING id, organization_id, version_no, effective_from, effective_to, status,
               money_scale, exchange_rate_scale, inventory_value_scale, rounding_mode,
               tax_rounding_scope, posting_date_policy, closed_period_adjustment_policy,
               reversal_policy, created_by, created_at, policy_json`,
    [orgId, version, effectiveFrom, policy.moneyScale, policy.exchangeRateScale,
      policy.inventoryValueScale, policy.roundingMode, policy.taxRoundingScope,
      policy.postingDatePolicy, policy.closedPeriodAdjustmentPolicy, policy.reversalPolicy,
      actorUserId, JSON.stringify(policy)]);
}

module.exports = {
  ensureDefault,
  findEffective,
  findVersionOne,
  insertVersion,
  latestPostedEntryDate,
  listVersions,
  lockLatestVersion,
};
