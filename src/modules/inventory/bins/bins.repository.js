const { pool } = require('../../../db/pool');

async function listBins(orgId, { warehouseId, status } = {}, client = null) {
  const db = client || pool;
  const params = [orgId];
  const where = ['b.organization_id=$1'];
  if (warehouseId) { params.push(warehouseId); where.push(`b.warehouse_id=$${params.length}`); }
  if (status) { params.push(status); where.push(`b.status=$${params.length}`); }
  const { rows } = await db.query(
    `SELECT b.*, w.code AS warehouse_code, w.name AS warehouse_name
       FROM warehouse_bins b
       JOIN warehouses w ON w.id=b.warehouse_id
      WHERE ${where.join(' AND ')}
      ORDER BY w.code, b.code`,
    params
  );
  return rows;
}

async function createBin(client, orgId, payload) {
  if (payload.isDefault) {
    await client.query(`UPDATE warehouse_bins SET is_default=FALSE, updated_at=NOW() WHERE organization_id=$1 AND warehouse_id=$2`, [orgId, payload.warehouseId]);
  }
  const { rows } = await client.query(
    `INSERT INTO warehouse_bins(organization_id, warehouse_id, code, name, status, is_default)
     VALUES($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [orgId, payload.warehouseId, payload.code, payload.name, payload.status || 'active', payload.isDefault === true]
  );
  return rows[0];
}

async function getBin(orgId, binId, client = null) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT * FROM warehouse_bins WHERE organization_id=$1 AND id=$2`,
    [orgId, binId]
  );
  return rows[0] || null;
}

async function updateBin(client, orgId, binId, payload) {
  const current = await getBin(orgId, binId, client);
  if (!current) return null;
  const warehouseId = payload.warehouseId || current.warehouse_id;
  if (payload.isDefault === true) {
    await client.query(`UPDATE warehouse_bins SET is_default=FALSE, updated_at=NOW() WHERE organization_id=$1 AND warehouse_id=$2`, [orgId, warehouseId]);
  }
  const { rows } = await client.query(
    `UPDATE warehouse_bins
        SET warehouse_id=$3,
            code=$4,
            name=$5,
            status=$6,
            is_default=$7,
            updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *`,
    [orgId, binId, warehouseId, payload.code || current.code, payload.name || current.name, payload.status || current.status, payload.isDefault == null ? current.is_default : payload.isDefault]
  );
  return rows[0] || null;
}

module.exports = { listBins, createBin, getBin, updateBin };
