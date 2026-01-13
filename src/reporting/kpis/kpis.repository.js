const { pool } = require("../../db/pool");

async function listDefinitions({ orgId, status = null, limit = 100, offset = 0 }) {
  const params = [orgId];
  let where = "WHERE organization_id=$1";
  if (status) {
    params.push(status);
    where += ` AND status=$${params.length}`;
  }
  params.push(limit);
  params.push(offset);
  const { rows } = await pool.query(
    `SELECT * FROM kpi_definitions ${where} ORDER BY code LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

async function getDefinition({ orgId, id }) {
  const { rows } = await pool.query(
    `SELECT * FROM kpi_definitions WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, id]
  );
  return rows.length ? rows[0] : null;
}

async function createDefinition({
  orgId,
  code,
  name,
  kpiType,
  status,
  accountId,
  expressionJson,
  createdByUserId,
}) {
  const { rows } = await pool.query(
    `
    INSERT INTO kpi_definitions(
      organization_id, code, name, kpi_type, status,
      account_id, expression_json, created_by_user_id
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *
    `,
    [orgId, code, name, kpiType, status, accountId || null, expressionJson || null, createdByUserId]
  );
  return rows[0];
}

async function updateDefinition({ orgId, id, patch }) {
  const fields = [];
  const values = [orgId, id];
  const allowed = {
    code: "code",
    name: "name",
    kpiType: "kpi_type",
    status: "status",
    accountId: "account_id",
    expressionJson: "expression_json",
  };

  for (const [k, col] of Object.entries(allowed)) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      values.push(patch[k]);
      fields.push(`${col}=$${values.length}`);
    }
  }
  if (!fields.length) return getDefinition({ orgId, id });
  const { rows } = await pool.query(
    `UPDATE kpi_definitions SET ${fields.join(", ")}, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    values
  );
  return rows.length ? rows[0] : null;
}

async function archiveDefinition({ orgId, id }) {
  const { rows } = await pool.query(
    `UPDATE kpi_definitions SET status='archived', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, id]
  );
  return rows.length ? rows[0] : null;
}

async function upsertValue({ orgId, kpiDefinitionId, periodId, asOfDate, value, metaJson }) {
  const { rows } = await pool.query(
    `
    INSERT INTO kpi_values(organization_id, kpi_definition_id, period_id, as_of_date, value, meta_json)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (organization_id, kpi_definition_id, period_id, as_of_date)
    DO UPDATE SET value=EXCLUDED.value, meta_json=EXCLUDED.meta_json, updated_at=NOW()
    RETURNING *
    `,
    [orgId, kpiDefinitionId, periodId, asOfDate, value, metaJson || {}]
  );
  return rows[0];
}

async function listValues({ orgId, periodId, limit = 200, offset = 0 }) {
  const params = [orgId];
  let where = "WHERE organization_id=$1";
  if (periodId) {
    params.push(periodId);
    where += ` AND period_id=$${params.length}`;
  }
  params.push(limit);
  params.push(offset);
  const { rows } = await pool.query(
    `SELECT * FROM kpi_values ${where} ORDER BY as_of_date DESC, created_at DESC LIMIT $${
      params.length - 1
    } OFFSET $${params.length}`,
    params
  );
  return rows;
}

async function getNormalisedAccountActual({ orgId, periodId, accountId }) {
  const { rows } = await pool.query(
    `
    SELECT
      CASE WHEN coa.normal_balance='CREDIT'
           THEN (glb.credit_total - glb.debit_total)
           ELSE (glb.debit_total - glb.credit_total)
      END AS actual_normal
    FROM general_ledger_balances glb
    JOIN chart_of_accounts coa ON coa.id = glb.account_id
    WHERE glb.organization_id=$1 AND glb.period_id=$2 AND glb.account_id=$3
    LIMIT 1
    `,
    [orgId, periodId, accountId]
  );
  return rows.length ? Number(rows[0].actual_normal || 0) : 0;
}

module.exports = {
  listDefinitions,
  getDefinition,
  createDefinition,
  updateDefinition,
  archiveDefinition,
  upsertValue,
  listValues,
  getNormalisedAccountActual,
};
