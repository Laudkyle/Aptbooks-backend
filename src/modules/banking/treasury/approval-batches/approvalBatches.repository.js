
const { pool } = require('../../../../db/pool');

async function list(orgId) {
  const { rows } = await pool.query(
    `SELECT pab.*, COALESCE((SELECT COUNT(*) FROM payment_approval_batch_items bi WHERE bi.batch_id = pab.id), 0) AS item_count
       FROM payment_approval_batches pab
      WHERE organization_id=$1
      ORDER BY created_at DESC`,
    [orgId]
  );
  return rows;
}

async function get(orgId, batchId, client = pool) {
  const { rows } = await client.query(`SELECT * FROM payment_approval_batches WHERE organization_id=$1 AND id=$2`, [orgId, batchId]);
  return rows[0] || null;
}

async function getItems(orgId, batchId, client = pool) {
  const { rows } = await client.query(
    `SELECT * FROM payment_approval_batch_items WHERE organization_id=$1 AND batch_id=$2 ORDER BY created_at ASC`,
    [orgId, batchId]
  );
  return rows;
}

async function create(orgId, payload, actorUserId, client = pool) {
  const { rows } = await client.query(
    `INSERT INTO payment_approval_batches(
      organization_id, batch_no, name, scheduled_date, notes, status, created_by_user_id
    ) VALUES ($1,$2,$3,$4,$5,'draft',$6)
    RETURNING *`,
    [orgId, payload.batchNo, payload.name, payload.scheduledDate || null, payload.notes || null, actorUserId || null]
  );
  return rows[0];
}

async function addItems(orgId, batchId, items, client = pool) {
  const out = [];
  for (const item of items) {
    const { rows } = await client.query(
      `INSERT INTO payment_approval_batch_items(organization_id, batch_id, item_type, item_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (batch_id, item_type, item_id) DO NOTHING
       RETURNING *`,
      [orgId, batchId, item.itemType, item.itemId]
    );
    if (rows[0]) out.push(rows[0]);
  }
  return out;
}

async function updateStatus(orgId, batchId, status, patch = {}, client = pool) {
  const params = [orgId, batchId, status, patch.approvedByUserId ?? null, patch.cancelledReason ?? null];
  const { rows } = await client.query(
    `UPDATE payment_approval_batches
        SET status=$3,
            approved_by_user_id=COALESCE($4, approved_by_user_id),
            cancelled_reason=COALESCE($5, cancelled_reason),
            updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *`,
    params
  );
  return rows[0] || null;
}

module.exports = { list, get, getItems, create, addItems, updateStatus };
