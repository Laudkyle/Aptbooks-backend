const { pool } = require("../../db/pool"); 
const { AppError } = require("../../shared/errors/AppError"); 
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service"); 
const { normalizeCode, normalizeStatus, assertUuid } = require("../_util"); 

const CENTER_TYPES = ["cost", "profit", "investment"];  // routes map to tables
const CENTER_STATUSES = ["active", "inactive", "archived"]; 

function tableForType(type) {
  if (!CENTER_TYPES.includes(type)) throw new AppError(400, "Unsupported center type"); 
  return type === "cost" ? "cost_centers" : type === "profit" ? "profit_centers" : "investment_centers"; 
}

function assertName(name) {
  if (!name || typeof name !== "string" || !name.trim()) throw new AppError(400, "name is required"); 
}

function parseDate(value, field) {
  if (value === null || value === undefined || value === "") return null; 
  if (typeof value !== "string") throw new AppError(400, `${field} must be an ISO date string (YYYY-MM-DD)`); 
  // light validation;  Postgres will enforce on write
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError(400, `${field} must be YYYY-MM-DD`); 
  return value; 
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
    `SELECT id, code, name, status,
            parent_id AS "parentId",
            valid_from AS "validFrom",
            valid_to AS "validTo",
            is_blocked AS "isBlocked",
            blocked_reason AS "blockedReason",
            created_at, updated_at
       FROM ${table}
       ${where}
       ORDER BY code`,
    params
  ); 
  return rows; 
}

async function createCenter({ orgId, type, code, name, status, parentId, validFrom, validTo, isBlocked, blockedReason, actorUserId, req }) {
  const table = tableForType(type); 
  const normCode = normalizeCode(code); 
  assertName(name); 
  const normStatus = normalizeStatus(status || "active", CENTER_STATUSES); 

  const pId = parentId ? (assertUuid(parentId, "parentId"), parentId) : null; 
  const vf = parseDate(validFrom, "validFrom"); 
  const vt = parseDate(validTo, "validTo"); 
  const blocked = isBlocked === true; 
  const bReason = blockedReason !== undefined && blockedReason !== null ? String(blockedReason).trim() : null; 

  if (vf && vt && vf > vt) throw new AppError(400, "validFrom must be <= validTo"); 
  if (blocked && !bReason) throw new AppError(400, "blockedReason is required when isBlocked=true"); 

  const { rows } = await pool.query(
    `INSERT INTO ${table}(
        organization_id, code, name, status,
        parent_id, valid_from, valid_to, is_blocked, blocked_reason
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, code, name, status,
               parent_id AS "parentId",
               valid_from AS "validFrom",
               valid_to AS "validTo",
               is_blocked AS "isBlocked",
               blocked_reason AS "blockedReason",
               created_at, updated_at`,
    [orgId, normCode, name.trim(), normStatus, pId, vf, vt, blocked, bReason]
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

async function getCenter({ orgId, type, id }) {
  const table = tableForType(type); 
  const { rows } = await pool.query(`SELECT * FROM ${table} WHERE organization_id=$1 AND id=$2 LIMIT 1`, [orgId, id]); 
  return rows[0] || null; 
}

async function usageForCenter({ orgId, type, id }) {
  // Today, the only concrete cross-module reference in this repo is fixed_assets.cost_center_id.
  // This method is intentionally extensible: add new queries as more modules join the dimension model.
  const usage = []; 

  if (type === "cost") {
    const fa = await pool.query(
      `SELECT COUNT(1)::int AS count
         FROM fixed_assets
        WHERE organization_id=$1 AND cost_center_id=$2`,
      [orgId, id]
    ); 
    usage.push({ entity: "fixed_assets", field: "cost_center_id", count: fa.rows[0]?.count || 0 }); 
  }

  // profit/investment centers currently have no references in this repo.
  // Keep a stable shape for clients.
  return { centerId: id, type, usage }; 
}

function ensureNotArchived(before) {
  if (before.status === "archived") throw new AppError(409, "Archived centers cannot be modified"); 
}

function ensureLifecycleCoherent({ validFrom, validTo }) {
  if (validFrom && validTo && validFrom > validTo) throw new AppError(400, "validFrom must be <= validTo"); 
}

async function updateCenter({ orgId, type, id, code, name, status, parentId, validFrom, validTo, isBlocked, blockedReason, actorUserId, req }) {
  const table = tableForType(type); 
  const before = await getCenter({ orgId, type, id }); 
  if (!before) throw new AppError(404, "Center not found"); 
  ensureNotArchived(before); 

  const normCode = code !== undefined ? (code ? normalizeCode(code) : null) : null; 
  const normStatus = status !== undefined ? (status ? normalizeStatus(status, CENTER_STATUSES) : null) : null; 
  const normName = name !== undefined ? (name === null ? null : String(name).trim()) : null; 
  if (name !== undefined && !normName) throw new AppError(400, "name cannot be empty"); 

  const pId = parentId !== undefined ? (parentId ? (assertUuid(parentId, "parentId"), parentId) : null) : null; 
  const vf = validFrom !== undefined ? parseDate(validFrom, "validFrom") : null; 
  const vt = validTo !== undefined ? parseDate(validTo, "validTo") : null; 

  const blocked = isBlocked !== undefined ? isBlocked === true : null; 
  const bReason = blockedReason !== undefined ? (blockedReason === null ? null : String(blockedReason).trim()) : null; 

  ensureLifecycleCoherent({
    validFrom: vf !== null ? vf : before.valid_from,
    validTo: vt !== null ? vt : before.valid_to,
  }); 
  if ((blocked === true || before.is_blocked === true) && blocked === true && !(bReason || before.blocked_reason)) {
    throw new AppError(400, "blockedReason is required when isBlocked=true"); 
  }

  // Governance: if deactivating/archiving, warn on usage.
  if (normStatus && ["inactive", "archived"].includes(normStatus)) {
    const usage = await usageForCenter({ orgId, type, id }); 
    const hasRefs = usage.usage.some((u) => Number(u.count || 0) > 0); 
    if (hasRefs && normStatus === "archived") {
      // allow inactive with refs;  disallow archiving if referenced (can be changed later via explicit reassignment workflow)
      throw new AppError(409, "Center is referenced by existing records;  archive is not permitted. Use inactive/block instead."); 
    }
  }

  const { rows } = await pool.query(
    `UPDATE ${table}
        SET code = COALESCE($3, code),
            name = COALESCE($4, name),
            status = COALESCE($5, status),
            parent_id = COALESCE($6, parent_id),
            valid_from = COALESCE($7, valid_from),
            valid_to = COALESCE($8, valid_to),
            is_blocked = COALESCE($9, is_blocked),
            blocked_reason = COALESCE($10, blocked_reason),
            updated_at = NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING id, code, name, status,
                parent_id AS "parentId",
                valid_from AS "validFrom",
                valid_to AS "validTo",
                is_blocked AS "isBlocked",
                blocked_reason AS "blockedReason",
                created_at, updated_at`,
    [orgId, id, normCode, normName, normStatus, pId, vf, vt, blocked, bReason]
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
  const before = await getCenter({ orgId, type, id }); 
  if (!before) return; 
  if (before.status === "archived") return; 

  // Governance: do not archive if referenced;  use inactive instead.
  const usage = await usageForCenter({ orgId, type, id }); 
  const hasRefs = usage.usage.some((u) => Number(u.count || 0) > 0); 
  if (hasRefs) {
    throw new AppError(409, "Center is referenced by existing records;  archive is not permitted. Use inactive/block instead."); 
  }

  const { rows } = await pool.query(
    `UPDATE ${table}
        SET status='archived', updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING id, code, name, status,
                parent_id AS "parentId",
                valid_from AS "validFrom",
                valid_to AS "validTo",
                is_blocked AS "isBlocked",
                blocked_reason AS "blockedReason",
                created_at, updated_at`,
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
  usageForCenter,
}; 
