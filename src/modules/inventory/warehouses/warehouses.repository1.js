const { pool } = require("../../../db/pool");

async function createWarehouse(orgId, { code, name, isActive }) {
  const { rows } = await pool.query(
    `INSERT INTO warehouses(organization_id, code, name, is_active)
     VALUES($1,$2,$3,$4)
     RETURNING *`,
    [orgId, code, name, isActive !== false]
  );
  return rows[0];
}

async function listWarehouses(orgId) {
  const { rows } = await pool.query(
    `SELECT * FROM warehouses WHERE organization_id=$1 ORDER BY code`,
    [orgId]
  );
  return rows;
}


async function getWarehouse(orgId, warehouseId) {
  const { rows } = await pool.query(
    `SELECT * FROM warehouses WHERE organization_id=$1 AND id=$2`,
    [orgId, warehouseId]
  );
  return rows[0] || null;
}

async function updateWarehouse(orgId, warehouseId, { code, name, isActive }) {
  const current = await getWarehouse(orgId, warehouseId);
  if (!current) return null;
  const { rows } = await pool.query(
    `UPDATE warehouses
        SET code=$3, name=$4, is_active=$5
      WHERE organization_id=$1 AND id=$2
      RETURNING *`,
    [orgId, warehouseId, code || current.code, name || current.name, isActive == null ? current.is_active : isActive]
  );
  return rows[0] || null;
}

module.exports = { createWarehouse, listWarehouses, getWarehouse, updateWarehouse };
