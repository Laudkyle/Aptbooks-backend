const { AppError } = require('../../../shared/errors/AppError');

async function listReasonCodes({ orgId, client }) {
  const { rows } = await client.query(`SELECT * FROM writeoff_reason_codes WHERE organization_id=$1 ORDER BY code ASC`, [orgId]);
  return rows;
}

async function upsertReasonCode({ orgId, payload, client }) {
  const { rows } = await client.query(
    `INSERT INTO writeoff_reason_codes (organization_id, code, description, is_active)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (organization_id, code) DO UPDATE
       SET description=EXCLUDED.description,
           is_active=EXCLUDED.is_active,
           updated_at=NOW()
     RETURNING *`,
    [orgId, payload.code, payload.description||null, payload.is_active !== false]
  );
  return rows[0];
}

async function deleteReasonCode({ orgId, code, client }) {
  await client.query(`DELETE FROM writeoff_reason_codes WHERE organization_id=$1 AND code=$2`, [orgId, code]);
  return { ok: true };
}

async function getSettings({ orgId, client }) {
  const { rows } = await client.query(`SELECT * FROM writeoff_settings WHERE organization_id=$1`, [orgId]);
  return rows[0] || null;
}

async function upsertSettings({ orgId, payload, client }) {
  const { rows } = await client.query(
    `INSERT INTO writeoff_settings (organization_id, ar_bad_debt_expense_account_id, ap_writeoff_income_account_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (organization_id) DO UPDATE
       SET ar_bad_debt_expense_account_id=EXCLUDED.ar_bad_debt_expense_account_id,
           ap_writeoff_income_account_id=EXCLUDED.ap_writeoff_income_account_id,
           updated_at=NOW()
     RETURNING *`,
    [orgId, payload.ar_bad_debt_expense_account_id||null, payload.ap_writeoff_income_account_id||null]
  );
  return rows[0];
}

async function listWriteoffs({ orgId, status, client }) {
  const { rows } = await client.query(
    `SELECT w.*, rc.code AS reason_code
       FROM writeoffs w
       LEFT JOIN writeoff_reason_codes rc ON rc.id=w.reason_code_id
      WHERE w.organization_id=$1 AND ($2::text IS NULL OR w.status=$2)
      ORDER BY w.created_at DESC, w.id DESC`,
    [orgId, status||null]
  );
  return rows;
}

async function getWriteoff({ orgId, id, client }) {
  const { rows } = await client.query(
    `SELECT w.*, rc.code AS reason_code
       FROM writeoffs w
       LEFT JOIN writeoff_reason_codes rc ON rc.id=w.reason_code_id
      WHERE w.organization_id=$1 AND w.id=$2`,
    [orgId, id]
  );
  if (!rows.length) throw new AppError(404,'Write-off not found');
  const actions = await client.query(
    `SELECT * FROM writeoff_actions WHERE organization_id=$1 AND writeoff_id=$2 ORDER BY id ASC`,
    [orgId, id]
  );
  return { ...rows[0], actions: actions.rows };
}

async function createDraft({ orgId, actorUserId, payload, client }) {
  const rcId = payload.reason_code
    ? (await client.query(`SELECT id FROM writeoff_reason_codes WHERE organization_id=$1 AND code=$2`, [orgId, payload.reason_code])).rows[0]?.id
    : null;

  const { rows } = await client.query(
    `INSERT INTO writeoffs (organization_id, entity_type, entity_id, partner_id, amount, reason_code_id, status, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8)
     RETURNING *`,
    [orgId, payload.entity_type, payload.entity_id, payload.partner_id, payload.amount, rcId||null, payload.notes||null, actorUserId]
  );
  const w = rows[0];
  await client.query(
    `INSERT INTO writeoff_actions (organization_id, writeoff_id, action_type, payload, actor_user_id)
     VALUES ($1,$2,'created',$3,$4)`,
    [orgId, w.id, { notes: payload.notes||null }, actorUserId]
  );
  return w;
}

async function transitionStatus({ orgId, id, fromStatuses, toStatus, actorUserId, actionType, payload, client }) {
  const { rows } = await client.query(
    `UPDATE writeoffs
        SET status=$3, updated_at=NOW()
      WHERE organization_id=$1 AND id=$2 AND status = ANY($4)
      RETURNING *`,
    [orgId, id, toStatus, fromStatuses]
  );
  if (!rows.length) throw new AppError(400, 'Invalid status transition');
  await client.query(
    `INSERT INTO writeoff_actions (organization_id, writeoff_id, action_type, payload, actor_user_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [orgId, id, actionType, payload||null, actorUserId]
  );
  return rows[0];
}

async function recordPosting({ orgId, id, journalId, client }) {
  const { rows } = await client.query(
    `UPDATE writeoffs SET journal_id=$3, status='posted', posted_at=NOW(), updated_at=NOW()
      WHERE organization_id=$1 AND id=$2 AND status='approved'
      RETURNING *`,
    [orgId, id, journalId]
  );
  if (!rows.length) throw new AppError(400,'Write-off not approved');
  return rows[0];
}

module.exports = {
  listReasonCodes,
  upsertReasonCode,
  deleteReasonCode,
  getSettings,
  upsertSettings,
  listWriteoffs,
  getWriteoff,
  createDraft,
  transitionStatus,
  recordPosting
};
