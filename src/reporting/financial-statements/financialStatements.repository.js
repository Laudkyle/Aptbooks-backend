const { pool } = require("../../db/pool");

async function insertFinancialStatement({ orgId, periodId, statementType, generatedBy, payload }) {
  const { rows } = await pool.query(
    `
    INSERT INTO financial_statements(
      organization_id,
      period_id,
      statement_type,
      generated_by,
      payload_json
    )
    VALUES ($1,$2,$3,$4,$5)
    RETURNING id, organization_id, period_id, statement_type, generated_by, generated_at
    `,
    [orgId, periodId, statementType, generatedBy || null, payload]
  );
  return rows[0];
}

async function listFinancialStatements({ orgId, periodId, statementType, limit = 50 }) {
  const params = [orgId];
  let where = `WHERE organization_id=$1`;
  if (periodId) {
    params.push(periodId);
    where += ` AND period_id=$${params.length}`;
  }
  if (statementType) {
    params.push(statementType);
    where += ` AND statement_type=$${params.length}`;
  }
  params.push(Math.min(Number(limit || 50) || 50, 200));

  const { rows } = await pool.query(
    `
    SELECT id, period_id, statement_type, generated_by, generated_at, payload_json
    FROM financial_statements
    ${where}
    ORDER BY generated_at DESC
    LIMIT $${params.length}
    `,
    params
  );
  return rows;
}

module.exports = { insertFinancialStatement, listFinancialStatements };
