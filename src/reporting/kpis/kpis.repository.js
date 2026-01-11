const { pool } = require("../../db/pool");

async function listDefinitions({ orgId }) {
  const { rows } = await pool.query(
    `
    SELECT id, code, name, description, expression, unit, status, created_at, updated_at
    FROM kpi_definitions
    WHERE organization_id=$1
    ORDER BY code
    `,
    [orgId]
  );
  return rows;
}

async function createDefinition({ orgId, code, name, description, expression, unit, status }) {
  const { rows } = await pool.query(
    `
    INSERT INTO kpi_definitions(organization_id, code, name, description, expression, unit, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING id, code, name, description, expression, unit, status, created_at, updated_at
    `,
    [orgId, code, name, description || null, expression, unit || null, status || "active"]
  );
  return rows[0];
}

async function getDefinition({ orgId, id }) {
  const { rows } = await pool.query(
    `SELECT * FROM kpi_definitions WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, id]
  );
  return rows.length ? rows[0] : null;
}

async function updateDefinition({ orgId, id, code, name, description, expression, unit, status }) {
  const { rows } = await pool.query(
    `
    UPDATE kpi_definitions
    SET code = COALESCE($3, code),
        name = COALESCE($4, name),
        description = COALESCE($5, description),
        expression = COALESCE($6, expression),
        unit = COALESCE($7, unit),
        status = COALESCE($8, status),
        updated_at = NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING id, code, name, description, expression, unit, status, created_at, updated_at
    `,
    [orgId, id, code || null, name || null, description || null, expression || null, unit || null, status || null]
  );
  return rows.length ? rows[0] : null;
}

async function deleteDefinition({ orgId, id }) {
  await pool.query(`DELETE FROM kpi_definitions WHERE organization_id=$1 AND id=$2`, [orgId, id]);
}

async function upsertValue({ orgId, kpiDefinitionId, periodId, asOfDate, value, payloadJson }) {
  const { rows } = await pool.query(
    `
    INSERT INTO kpi_values(organization_id, kpi_definition_id, period_id, as_of_date, value, payload_json)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (organization_id, kpi_definition_id, period_id, as_of_date)
    DO UPDATE SET value = EXCLUDED.value,
                  payload_json = EXCLUDED.payload_json,
                  computed_at = NOW()
    RETURNING id, kpi_definition_id, period_id, as_of_date, value, computed_at
    `,
    [orgId, kpiDefinitionId, periodId || null, asOfDate || null, value, payloadJson || {}]
  );
  return rows[0];
}

module.exports = {
  listDefinitions,
  createDefinition,
  getDefinition,
  updateDefinition,
  deleteDefinition,
  upsertValue,
};
