const { pool } = require("../../../db/pool");

async function createUnit(orgId, { code, name, symbol, decimalPlaces }) {
  const { rows } = await pool.query(
    `INSERT INTO item_units(organization_id, code, name, symbol, decimal_places, status)
     VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
    [orgId, code, name, symbol || null, decimalPlaces ?? 2]
  );
  return rows[0];
}

async function listUnits(orgId, { activeOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT id, code, name, symbol, decimal_places, status, created_at, updated_at
       FROM item_units WHERE organization_id=$1 ${activeOnly ? "AND status='active'" : ''} ORDER BY code`, [orgId]);
  return rows;
}

async function countItems(orgId, unitId) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM inventory_items WHERE organization_id=$1 AND unit_id=$2`, [orgId, unitId]);
  return rows[0]?.count || 0;
}

module.exports = { createUnit, listUnits, countItems };
