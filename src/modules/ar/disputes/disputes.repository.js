const { AppError } = require('../../../shared/errors/AppError');

async function listReasonCodes({ orgId, client }) {
  const { rows } = await client.query(
    `SELECT * FROM dispute_reason_codes WHERE organization_id=$1 ORDER BY code ASC`,
    [orgId]
  );
  return rows;
}

async function upsertReasonCode({ orgId, payload, client }) {
  const { rows } = await client.query(
    `INSERT INTO dispute_reason_codes (organization_id, code, description, is_active)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (organization_id, code) DO UPDATE
       SET description=EXCLUDED.description,
           is_active=EXCLUDED.is_active,
           updated_at=NOW()
     RETURNING *`,
    [orgId, payload.code, payload.description || null, payload.is_active !== false]
  );
  return rows[0];
}

async function deleteReasonCode({ orgId, code, client }) {
  await client.query(`DELETE FROM dispute_reason_codes WHERE organization_id=$1 AND code=$2`, [orgId, code]);
  return { ok: true };
}

async function listDisputes({ orgId, status, client }) {
  const { rows } = await client.query(
    `SELECT d.*, rc.code AS reason_code
       FROM disputes d
       LEFT JOIN dispute_reason_codes rc ON rc.id=d.reason_code_id
      WHERE d.organization_id=$1 AND ($2::text IS NULL OR d.status=$2)
      ORDER BY d.opened_at DESC, d.id DESC`,
    [orgId, status || null]
  );
  return rows;
}

async function getDispute({ orgId, id, client }) {
  const { rows } = await client.query(
    `SELECT d.*, rc.code AS reason_code
       FROM disputes d
       LEFT JOIN dispute_reason_codes rc ON rc.id=d.reason_code_id
      WHERE d.organization_id=$1 AND d.id=$2`,
    [orgId, id]
  );
  if (!rows.length) throw new AppError(404, 'Dispute not found');
  const actions = await client.query(
    `SELECT * FROM dispute_actions WHERE organization_id=$1 AND dispute_id=$2 ORDER BY id ASC`,
    [orgId, id]
  );
  return { ...rows[0], actions: actions.rows };
}

async function createDispute({ orgId, actorUserId, payload, client }) {
  const rcId = payload.reason_code
    ? (await client.query(`SELECT id FROM dispute_reason_codes WHERE organization_id=$1 AND code=$2`, [orgId, payload.reason_code])).rows[0]?.id
    : null;
  const { rows } = await client.query(
    `INSERT INTO disputes (organization_id, entity_type, entity_id, partner_id, reason_code_id, status, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,'open',$6,$7)
     RETURNING *`,
    [orgId, payload.entity_type, payload.entity_id, payload.partner_id, rcId || null, payload.notes || null, actorUserId]
  );
  const dispute = rows[0];
  await client.query(
    `INSERT INTO dispute_actions (organization_id, dispute_id, action_type, payload, actor_user_id)
     VALUES ($1,$2,'opened',$3,$4)`,
    [orgId, dispute.id, { notes: payload.notes || null }, actorUserId]
  );
  return dispute;
}

async function addAction({ orgId, id, actorUserId, action_type, payload, client }) {
  await client.query(
    `INSERT INTO dispute_actions (organization_id, dispute_id, action_type, payload, actor_user_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [orgId, id, action_type, payload || null, actorUserId]
  );
  return getDispute({ orgId, id, client });
}

async function resolveDispute({ orgId, id, actorUserId, resolution, client }) {
  const { rows } = await client.query(
    `UPDATE disputes
        SET status='resolved', resolved_at=NOW(), updated_at=NOW()
      WHERE organization_id=$1 AND id=$2 AND status='open'
      RETURNING *`,
    [orgId, id]
  );
  if (!rows.length) throw new AppError(400, 'Dispute not open or not found');
  await client.query(
    `INSERT INTO dispute_actions (organization_id, dispute_id, action_type, payload, actor_user_id)
     VALUES ($1,$2,'resolved',$3,$4)`,
    [orgId, id, { resolution: resolution || null }, actorUserId]
  );
  return getDispute({ orgId, id, client });
}

async function voidDispute({ orgId, id, actorUserId, client }) {
  const { rows } = await client.query(
    `UPDATE disputes
        SET status='void', updated_at=NOW()
      WHERE organization_id=$1 AND id=$2 AND status IN ('open','resolved')
      RETURNING *`,
    [orgId, id]
  );
  if (!rows.length) throw new AppError(404, 'Dispute not found');
  await client.query(
    `INSERT INTO dispute_actions (organization_id, dispute_id, action_type, payload, actor_user_id)
     VALUES ($1,$2,'voided',NULL,$3)`,
    [orgId, id, actorUserId]
  );
  return getDispute({ orgId, id, client });
}

module.exports = {
  listReasonCodes,
  upsertReasonCode,
  deleteReasonCode,
  listDisputes,
  getDispute,
  createDispute,
  addAction,
  resolveDispute,
  voidDispute
};
