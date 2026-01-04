const { AppError } = require("../../shared/errors/AppError");
const { pool } = require("../../db/pool");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");

const TYPE_TO_TABLE = {
  cost: "cost_centers",
  profit: "profit_centers",
  investment: "investment_centers",
};

function tableFor(type) {
  const t = TYPE_TO_TABLE[type];
  if (!t) throw new AppError(400, "type must be one of: cost, profit, investment");
  return t;
}

async function list({ orgId, type }) {
  const table = tableFor(type);
  const { rows } = await pool.query(
    `SELECT id, code, name, status, created_at, updated_at FROM ${table} WHERE organization_id=$1 ORDER BY code`,
    [orgId]
  );
  return rows;
}

async function create({ orgId, type, code, name, status, actorUserId, req }) {
  if (!code) throw new AppError(400, "code is required");
  if (!name) throw new AppError(400, "name is required");
  const table = tableFor(type);
  const { rows } = await pool.query(
    `
    INSERT INTO ${table}(organization_id, code, name, status)
    VALUES ($1,$2,$3,$4)
    RETURNING id, code, name, status, created_at, updated_at
    `,
    [orgId, code, name, status || "active"]
  );

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.center.create",
    entityType: table,
    entityId: rows[0].id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: { type, ...rows[0] },
  });

  return rows[0];
}

async function update({ orgId, type, id, code, name, status, actorUserId, req }) {
  const table = tableFor(type);
  const { rows: beforeRows } = await pool.query(
    `SELECT * FROM ${table} WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, id]
  );
  if (!beforeRows.length) throw new AppError(404, "Center not found");

  const { rows } = await pool.query(
    `
    UPDATE ${table}
    SET code = COALESCE($3, code),
        name = COALESCE($4, name),
        status = COALESCE($5, status),
        updated_at = NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING id, code, name, status, created_at, updated_at
    `,
    [orgId, id, code || null, name || null, status || null]
  );

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.center.update",
    entityType: table,
    entityId: id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: beforeRows[0],
    after: { type, ...rows[0] },
  });

  return rows[0];
}

async function remove({ orgId, type, id, actorUserId, req }) {
  const table = tableFor(type);
  const { rows: beforeRows } = await pool.query(
    `SELECT * FROM ${table} WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, id]
  );
  if (!beforeRows.length) throw new AppError(404, "Center not found");

  await pool.query(`DELETE FROM ${table} WHERE organization_id=$1 AND id=$2`, [orgId, id]);

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.center.delete",
    entityType: table,
    entityId: id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: beforeRows[0],
    after: null,
  });
}

module.exports = { list, create, update, remove };
