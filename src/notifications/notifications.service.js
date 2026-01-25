const { pool } = require("../db/pool"); 
const { AppError } = require("../shared/errors/AppError"); 

async function listNotifications({ orgId, userId, query }) {
  const limit = Math.min(Number(query?.limit || 50), 200); 
  const offset = Math.max(Number(query?.offset || 0), 0); 
  const unreadOnly = String(query?.unreadOnly || "false") === "true"; 

  const where = ["organization_id=$1", "user_id=$2"]; 
  const params = [orgId, userId]; 
  if (unreadOnly) where.push("read_at IS NULL"); 

  const { rows } = await pool.query(
    `
    SELECT id, type, title, body, severity, entity_type, entity_id,
           created_at, read_at
    FROM notifications
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
    `,
    params
  ); 

  const { rows: counts } = await pool.query(
    `
    SELECT
      COUNT(*)::int AS total,
      SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END)::int AS unread
    FROM notifications
    WHERE organization_id=$1 AND user_id=$2
    `,
    [orgId, userId]
  ); 

  return { items: rows, meta: { total: counts[0].total, unread: counts[0].unread, limit, offset } }; 
}

async function createNotification({ orgId, actorUserId, payload }) {
  const {
    userId,
    title,
    body,
    type = "general",
    severity = "info",
    entityType = null,
    entityId = null
  } = payload || {}; 

  if (!title || !body) throw new AppError(400, "title and body required"); 
  const sev = String(severity); 
  if (![["info"], ["warning"], ["error"], ["success"]].flat().includes(sev)) {
    throw new AppError(400, "invalid severity"); 
  }

  // If userId is omitted, broadcast to all active users in org.
  if (!userId) {
    const { rows: users } = await pool.query(
      `SELECT id FROM users WHERE organization_id=$1 AND status='active' AND is_system=FALSE`,
      [orgId]
    ); 
    const created = []; 
    for (const u of users) {
      const { rows } = await pool.query(
        `
        INSERT INTO notifications(
          organization_id, user_id, created_by_user_id,
          type, title, body, severity, entity_type, entity_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING id, user_id, type, title, body, severity, entity_type, entity_id, created_at, read_at
        `,
        [orgId, u.id, actorUserId || null, type, title, body, sev, entityType, entityId]
      ); 
      created.push(rows[0]); 
    }
    return { broadcast: true, createdCount: created.length, items: created }; 
  }

  const { rows: exists } = await pool.query(
    `SELECT id FROM users WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, userId]
  ); 
  if (!exists.length) throw new AppError(404, "Target user not found"); 

  const { rows } = await pool.query(
    `
    INSERT INTO notifications(
      organization_id, user_id, created_by_user_id,
      type, title, body, severity, entity_type, entity_id
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING id, user_id, type, title, body, severity, entity_type, entity_id, created_at, read_at
    `,
    [orgId, userId, actorUserId || null, type, title, body, sev, entityType, entityId]
  ); 
  return rows[0]; 
}

async function markRead({ orgId, userId, notificationId }) {
  const { rows } = await pool.query(
    `
    UPDATE notifications
    SET read_at = COALESCE(read_at, NOW())
    WHERE organization_id=$1 AND user_id=$2 AND id=$3
    RETURNING id, read_at
    `,
    [orgId, userId, notificationId]
  ); 
  if (!rows.length) throw new AppError(404, "Notification not found"); 
  return rows[0]; 
}

async function markReadBulk({ orgId, userId, ids }) {
  if (!Array.isArray(ids) || ids.length === 0) throw new AppError(400, "ids required"); 

  const { rows } = await pool.query(
    `
    UPDATE notifications
    SET read_at = COALESCE(read_at, NOW())
    WHERE organization_id=$1 AND user_id=$2 AND id = ANY($3::uuid[])
    RETURNING id, read_at
    `,
    [orgId, userId, ids]
  ); 

  return { updated: rows.length, items: rows }; 
}

module.exports = {
  listNotifications,
  createNotification,
  markRead,
  markReadBulk
}; 
