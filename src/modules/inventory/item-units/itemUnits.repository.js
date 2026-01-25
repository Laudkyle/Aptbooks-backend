const { pool } = require("../../../db/pool");

async function createUnit(orgId, { code, name }) {
  const { rows } = await pool.query(
    `INSERT INTO item_units(organization_id, code, name)
     VALUES ($1,$2,$3)
     RETURNING *`,
    [orgId, code, name]
  );
  return rows[0];
}

async function listUnits(orgId) {
  const { rows } = await pool.query(
    `SELECT * FROM item_units WHERE organization_id=$1 ORDER BY code`,
    [orgId]
  );
  return rows;
}

module.exports = { createUnit, listUnits };
