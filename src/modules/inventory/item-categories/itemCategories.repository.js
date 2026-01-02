const { pool } = require("../../../db/pool");

async function createCategory(orgId, payload) {
  const { code, name, inventoryAccountId, cogsAccountId, adjustmentAccountId, clearingAccountId } = payload;
  const { rows } = await pool.query(
    `INSERT INTO item_categories(
        organization_id, code, name, inventory_account_id, cogs_account_id, adjustment_account_id, clearing_account_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [orgId, code, name, inventoryAccountId, cogsAccountId, adjustmentAccountId, clearingAccountId]
  );
  return rows[0];
}

async function listCategories(orgId) {
  const { rows } = await pool.query(
    `SELECT * FROM item_categories WHERE organization_id=$1 ORDER BY code`,
    [orgId]
  );
  return rows;
}

module.exports = { createCategory, listCategories };
