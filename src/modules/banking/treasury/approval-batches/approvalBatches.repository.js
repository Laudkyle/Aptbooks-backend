
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
  const params=[orgId,batchId,status]; const sets=['status=$3'];
  const fields=[['approved_by_user_id',patch.approvedByUserId],['submitted_by_user_id',patch.submittedByUserId],['cancelled_reason',patch.cancelledReason]];
  for(const [col,val] of fields){if(val!==undefined){params.push(val);sets.push(`${col}=$${params.length}`);}}
  if(patch.submittedAt) sets.push('submitted_at=NOW()');
  if(patch.approvedAt) sets.push('approved_at=NOW()');
  sets.push('updated_at=NOW()');
  const {rows}=await client.query(`UPDATE payment_approval_batches SET ${sets.join(', ')} WHERE organization_id=$1 AND id=$2 RETURNING *`,params);
  return rows[0]||null;
}

async function lockHeader(orgId,batchId,client=pool){const {rows}=await client.query(`SELECT id FROM payment_approval_batches WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[orgId,batchId]);return rows[0]||null;}

module.exports = { list, get, getItems, create, addItems, updateStatus, lockHeader };
