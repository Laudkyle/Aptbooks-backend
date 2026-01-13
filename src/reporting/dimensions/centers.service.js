const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");
const { normalizeCode, normalizeStatus } = require("../_util");

const CENTER_TYPES = ["cost", "profit", "investment"]; // routes map to tables
const CENTER_STATUSES = ["active", "inactive", "archived"];

function tableForType(type) {
  if (!CENTER_TYPES.includes(type)) throw new AppError(400, "Unsupported center type");
  return type === "cost" ? "cost_centers" : type === "profit" ? "profit_centers" : "investment_centers";
}

async function listCenters({ orgId, type, status }) {
  const table = tableForType(type);
  const params = [orgId];
  let where = "WHERE organization_id=$1";
  if (status) {
    params.push(status);
    where += ` AND status=$${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT id, code, name, status, created_at, updated_at
     FROM ${table}
     ${where}
     ORDER BY code`,
    params
  );
  return rows;
}

async function createCenter({ orgId, type, code, name, status, actorUserId, req }) {
  const table = tableForType(type);
  const normCode = normalizeCode(code);
  if (!name || typeof name !== "string" || !name.trim()) throw new AppError(400, "name is required");
  const normStatus = normalizeStatus(status || "active", CENTER_STATUSES);

  const { rows } = await pool.query(
    `INSERT INTO ${table}(organization_id, code, name, status)
     VALUES ($1,$2,$3,$4)
     RETURNING id, code, name, status, created_at, updated_at`,
    [orgId, normCode, name.trim(), normStatus]
  );
  const created = rows[0];
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: `reporting.center.${type}.create`,
    entityType: table,
    entityId: created.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: created,
  });
  return created;
}

async function updateCenter({ orgId, type, id, code, name, status, actorUserId, req }) {
  const table = tableForType(type);
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM ${table} WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, id]
  );
  if (!existingRows.length) throw new AppError(404, "Center not found");
  const before = existingRows[0];
  if (before.status === "archived") throw new AppError(409, "Archived centers cannot be modified");

  const normCode = code ? normalizeCode(code) : null;
  const normStatus = status ? normalizeStatus(status, CENTER_STATUSES) : null;
  const normName = name ? String(name).trim() : null;
  if (name !== undefined && !normName) throw new AppError(400, "name cannot be empty");

  const { rows } = await pool.query(
    `UPDATE ${table}
     SET code = COALESCE($3, code),
         name = COALESCE($4, name),
         status = COALESCE($5, status),
         updated_at = NOW()
     WHERE organization_id=$1 AND id=$2
     RETURNING id, code, name, status, created_at, updated_at`,
    [orgId, id, normCode, normName, normStatus]
  );
  const updated = rows[0];
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: `reporting.center.${type}.update`,
    entityType: table,
    entityId: id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before,
    after: updated,
  });
  return updated;
}

// Production-grade behaviour: never hard-delete. Move to archived.
async function archiveCenter({ orgId, type, id, actorUserId, req }) {
  const table = tableForType(type);
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM ${table} WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, id]
  );
  if (!existingRows.length) return;
  const before = existingRows[0];
  if (before.status === "archived") return;

  const { rows } = await pool.query(
    `UPDATE ${table}
     SET status='archived', updated_at=NOW()
     WHERE organization_id=$1 AND id=$2
     RETURNING id, code, name, status, created_at, updated_at`,
    [orgId, id]
  );
  const after = rows[0];
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: `reporting.center.${type}.archive`,
    entityType: table,
    entityId: id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before,
    after,
  });
}

module.exports = {
  listCenters,
  createCenter,
  updateCenter,
  archiveCenter,
};
