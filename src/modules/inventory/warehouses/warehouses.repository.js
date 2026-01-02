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

module.exports = { createWarehouse, listWarehouses };
