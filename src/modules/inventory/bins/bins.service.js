const { pool } = require('../../../db/pool');
const { AppError } = require('../../../shared/errors/AppError');
const repo = require('./bins.repository');

async function assertWarehouse(orgId, warehouseId, client = null) {
  const db = client || pool;
  const { rows } = await db.query(`SELECT id FROM warehouses WHERE organization_id=$1 AND id=$2`, [orgId, warehouseId]);
  if (!rows.length) throw new AppError(404, 'Warehouse not found');
}

async function listBins(orgId, query) { return repo.listBins(orgId, query); }

async function createBin(orgId, payload) {
  if (!payload?.warehouseId || !payload?.code || !payload?.name) throw new AppError(400, 'warehouseId, code and name are required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertWarehouse(orgId, payload.warehouseId, client);
    const created = await repo.createBin(client, orgId, payload);
    await client.query('COMMIT');
    return created;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function updateBin(orgId, binId, payload) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (payload.warehouseId) await assertWarehouse(orgId, payload.warehouseId, client);
    const updated = await repo.updateBin(client, orgId, binId, payload);
    if (!updated) throw new AppError(404, 'Bin not found');
    await client.query('COMMIT');
    return updated;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

module.exports = { listBins, createBin, updateBin };
