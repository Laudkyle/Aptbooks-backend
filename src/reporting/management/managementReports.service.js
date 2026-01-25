const { pool } = require("../../db/pool"); 
const { AppError } = require("../../shared/errors/AppError"); 

async function assertDimensionLedgerAvailable() {
  // This checks for the existence of the dimension ledger table.
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='general_ledger_dimension_balances' LIMIT 1`
  ); 
  if (!rows.length) {
    throw new AppError(409, "Dimensional ledger not available. Apply Stage 1/Stage 3 migrations."); 
  }
}

async function departmentalPnL({ organizationId, periodId, costCenterId = null, profitCenterId = null, projectId = null }) {
  await assertDimensionLedgerAvailable(); 

  const filters = []; 
  const params = [organizationId, periodId]; 

  if (costCenterId) {
    params.push(costCenterId); 
    filters.push(`dimension_json->>'costCenterId' = $${params.length}`); 
  }
  if (profitCenterId) {
    params.push(profitCenterId); 
    filters.push(`dimension_json->>'profitCenterId' = $${params.length}`); 
  }
  if (projectId) {
    params.push(projectId); 
    filters.push(`dimension_json->>'projectId' = $${params.length}`); 
  }

  const extra = filters.length ? ` AND ${filters.join(" AND ")}` : ""; 

  const { rows } = await pool.query(
    `
    SELECT
      account_id,
      SUM(debit_total) AS debit_total,
      SUM(credit_total) AS credit_total,
      SUM(credit_total - debit_total) AS net_total
    FROM general_ledger_dimension_balances
    WHERE organization_id=$1 AND period_id=$2
      ${extra}
    GROUP BY account_id
    ORDER BY account_id
    `,
    params
  ); 

  return rows; 
}

async function costCenterSummary({ organizationId, periodId }) {
  await assertDimensionLedgerAvailable(); 
  const { rows } = await pool.query(
    `
    SELECT
      dimension_json->>'costCenterId' AS cost_center_id,
      SUM(debit_total) AS debit_total,
      SUM(credit_total) AS credit_total,
      SUM(credit_total - debit_total) AS net_total
    FROM general_ledger_dimension_balances
    WHERE organization_id=$1 AND period_id=$2
      AND COALESCE(dimension_json->>'costCenterId','') <> ''
    GROUP BY dimension_json->>'costCenterId'
    ORDER BY net_total DESC
    `,
    [organizationId, periodId]
  ); 
  return rows; 
}

module.exports = {
  departmentalPnL,
  costCenterSummary,
}; 
