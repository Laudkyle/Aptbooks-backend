const { AppError } = require("../../shared/errors/AppError");
const { pool } = require("../../db/pool");

async function ingest(orgId, userId, req) {
  const body = req.body || {};
  const entries = Array.isArray(body) ? body : (Array.isArray(body.entries) ? body.entries : [body]);
  if (!entries.length) throw new AppError(400, "No log entries provided");

  const inserted = [];
  for (const e of entries) {
    const level = String(e.level || "info").toLowerCase();
    const message = String(e.message || e.msg || "").trim();
    if (!message) throw new AppError(400, "Each log entry requires message");
    const correlationId = e.correlationId || e.correlation_id || req.headers["x-request-id"] || null;
    const context = e.context || e.meta || null;
    const userAgent = req.headers["user-agent"] || null;
    const ip = req.ip || req.socket.remoteAddress || null;

    const { rows } = await pool.query(
      `INSERT INTO client_logs(organization_id, user_id, correlation_id, level, message, context, user_agent, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [orgId || null, userId || null, correlationId, level, message, context, userAgent, ip]
    );
    inserted.push(rows[0]);
  }

  return { data: inserted, inserted: inserted.length };
}

async function query(orgId, q = {}) {
  const limit = Math.min(Number(q.limit || 100), 500);
  const offset = Math.max(Number(q.offset || 0), 0);
  const correlationId = q.correlationId || q.correlation_id || null;
  const level = q.level || null;

  const params = [orgId];
  let where = "WHERE organization_id=$1";
  if (correlationId) {
    params.push(correlationId);
    where += ` AND correlation_id=$${params.length}`;
  }
  if (level) {
    params.push(level);
    where += ` AND level=$${params.length}`;
  }
  params.push(limit);
  params.push(offset);

  const { rows } = await pool.query(
    `SELECT * FROM client_logs ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { data: rows, paging: { limit, offset } };
}

module.exports = { ingest, query };
