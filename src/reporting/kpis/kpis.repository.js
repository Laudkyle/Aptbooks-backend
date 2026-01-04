const { pool } = require("../../db/pool");

async function listDefinitions({ orgId }) {
  const { rows } = await pool.query(
    `
    SELECT id, code, name, description, data_type, definition_json, status, created_at, updated_at
    FROM kpi_definitions
    WHERE organization_id=$1
    ORDER BY code
    `,
    [orgId]
  );
  return rows;
}

async function createDefinition({ orgId, code, name, description, dataType, definitionJson, status }) {
  const { rows } = await pool.query(
    `
    INSERT INTO kpi_definitions(organization_id, code, name, description, data_type, definition_json, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING id, code, name, description, data_type, definition_json, status, created_at, updated_at
    `,
    [orgId, code, name, description || null, dataType, definitionJson || {}, status || "active"]
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

async function updateDefinition({ orgId, id, code, name, description, dataType, definitionJson, status }) {
  const { rows } = await pool.query(
    `
    UPDATE kpi_definitions
    SET code = COALESCE($3, code),
        name = COALESCE($4, name),
        description = COALESCE($5, description),
        data_type = COALESCE($6, data_type),
        definition_json = COALESCE($7, definition_json),
        status = COALESCE($8, status),
        updated_at = NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING id, code, name, description, data_type, definition_json, status, created_at, updated_at
    `,
    [orgId, id, code || null, name || null, description || null, dataType || null, definitionJson || null, status || null]
  );
  return rows.length ? rows[0] : null;
}

async function deleteDefinition({ orgId, id }) {
  await pool.query(`DELETE FROM kpi_definitions WHERE organization_id=$1 AND id=$2`, [orgId, id]);
}

async function upsertValue({ orgId, kpiId, periodId, valueNumeric, valueText, payloadJson }) {
  const { rows } = await pool.query(
    `
    INSERT INTO kpi_values(organization_id, kpi_id, period_id, value_numeric, value_text, payload_json)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (organization_id, kpi_id, period_id)
    DO UPDATE SET value_numeric = EXCLUDED.value_numeric,
                  value_text = EXCLUDED.value_text,
                  payload_json = EXCLUDED.payload_json,
                  computed_at = NOW()
    RETURNING id, kpi_id, period_id, value_numeric, value_text, computed_at
    `,
    [orgId, kpiId, periodId, valueNumeric || null, valueText || null, payloadJson || {}]
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
