const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");
const { normalizeCode, normalizeStatus } = require("../_util");

const PROJECT_STATUS = ["active", "on_hold", "closed", "archived"]; // archived is soft-delete
const PHASE_STATUS = ["active", "closed", "archived"]; 
const TASK_STATUS = ["active", "done", "archived"]; 

async function fetchProjectOrThrow({ orgId, projectId }) {
  const { rows } = await pool.query(
    `SELECT * FROM projects WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, projectId]
  );
  if (!rows.length) throw new AppError(404, "Project not found");
  return rows[0];
}

function assertProjectEditable(project) {
  if (project.status === "archived") throw new AppError(409, "Project is archived and cannot be modified");
  if (project.status === "closed") throw new AppError(409, "Project is closed and cannot be modified");
}

function assertName(name, field = "name") {
  if (!name || typeof name !== "string" || !name.trim()) throw new AppError(400, `${field} is required`);
}

async function listProjects({ orgId, limit = 100, offset = 0, status }) {
  const params = [orgId];
  let where = "WHERE organization_id=$1";
  if (status) {
    params.push(status);
    where += ` AND status=$${params.length}`;
  }
  params.push(limit);
  params.push(offset);
  const { rows } = await pool.query(
    `SELECT * FROM projects ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

async function getProject({ orgId, id }) {
  const { rows } = await pool.query(`SELECT * FROM projects WHERE organization_id=$1 AND id=$2`, [orgId, id]);
  return rows[0] || null;
}

async function createProject({ orgId, code, name, status, actorUserId, req }) {
  const c = normalizeCode(code);
  assertName(name);
  const st = normalizeStatus(status || "active", PROJECT_STATUS, "status");
  const { rows } = await pool.query(
    `INSERT INTO projects(organization_id, code, name, status)
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
    [orgId, c, name.trim(), st]
  );
  const created = rows[0];
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.project.create",
    entityType: "project",
    entityId: created.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: created,
  });
  return created;
}

async function updateProject({ orgId, id, code, name, status, actorUserId, req }) {
  const current = await getProject({ orgId, id });
  if (!current) throw new AppError(404, "Project not found");

  // Standard lifecycle rules:
  // - archived: immutable
  // - closed: allow status change to archived only; block code/name edits
  if (current.status === "archived") throw new AppError(409, "Project is archived and cannot be modified");
  if (current.status === "closed") {
    if (code !== undefined || name !== undefined) throw new AppError(409, "Closed projects are read-only");
    if (status === undefined || normalizeStatus(status, PROJECT_STATUS, "status") !== "archived") {
      throw new AppError(409, "Closed projects can only be archived");
    }
  }
  const c = code !== undefined ? normalizeCode(code) : current.code;
  const n = name !== undefined ? (assertName(name), name.trim()) : current.name;
  const st = status !== undefined ? normalizeStatus(status, PROJECT_STATUS, "status") : current.status;
  const { rows } = await pool.query(
    `UPDATE projects SET code=$3, name=$4, status=$5, updated_at=NOW()
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    [orgId, id, c, n, st]
  );
  const updated = rows[0];
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.project.update",
    entityType: "project",
    entityId: id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: current,
    after: updated,
  });
  return updated;
}

async function archiveProject({ orgId, id, actorUserId, req }) {
  const current = await getProject({ orgId, id });
  if (!current) throw new AppError(404, "Project not found");
  const { rows } = await pool.query(
    `UPDATE projects SET status='archived', updated_at=NOW()
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    [orgId, id]
  );
  const updated = rows[0];
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.project.archive",
    entityType: "project",
    entityId: id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: current,
    after: updated,
  });
}

async function listPhases({ orgId, projectId }) {
  const { rows } = await pool.query(
    `SELECT * FROM project_phases WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at ASC`,
    [orgId, projectId]
  );
  return rows;
}

async function createPhase({ orgId, projectId, code, name, status, actorUserId, req }) {
  const proj = await getProject({ orgId, id: projectId });
  if (!proj) throw new AppError(404, "Project not found");
  if (proj.status === "archived") throw new AppError(409, "Project is archived");
  if (proj.status === "closed") throw new AppError(409, "Project is closed and cannot be modified");
  const c = normalizeCode(code);
  assertName(name);
  const st = normalizeStatus(status || "active", PHASE_STATUS, "status");
  const { rows } = await pool.query(
    `INSERT INTO project_phases(organization_id, project_id, code, name, status)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [orgId, projectId, c, name.trim(), st]
  );
  const created = rows[0];
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.project_phase.create",
    entityType: "project_phase",
    entityId: created.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: created,
  });
  return created;
}

async function updatePhase({ orgId, projectId, id, code, name, status, actorUserId, req }) {
  const proj = await getProject({ orgId, id: projectId });
  if (!proj) throw new AppError(404, "Project not found");
  if (proj.status === "archived") throw new AppError(409, "Project is archived");
  if (proj.status === "closed") throw new AppError(409, "Closed projects are read-only");
  const { rows: currRows } = await pool.query(
    `SELECT * FROM project_phases WHERE organization_id=$1 AND id=$2 AND project_id=$3`,
    [orgId, id, projectId]
  );
  const current = currRows[0];
  if (!current) throw new AppError(404, "Phase not found");
  const c = code !== undefined ? normalizeCode(code) : current.code;
  const n = name !== undefined ? (assertName(name), name.trim()) : current.name;
  const st = status !== undefined ? normalizeStatus(status, PHASE_STATUS, "status") : current.status;
  const { rows } = await pool.query(
    `UPDATE project_phases SET code=$4, name=$5, status=$6, updated_at=NOW()
     WHERE organization_id=$1 AND id=$2 AND project_id=$3
     RETURNING *`,
    [orgId, id, projectId, c, n, st]
  );
  const updated = rows[0];
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.project_phase.update",
    entityType: "project_phase",
    entityId: id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: current,
    after: updated,
  });
  return updated;
}

async function listTasks({ orgId, projectId, phaseId }) {
  const { rows } = await pool.query(
    `SELECT * FROM project_tasks WHERE organization_id=$1 AND project_id=$2 AND phase_id=$3 ORDER BY created_at ASC`,
    [orgId, projectId, phaseId]
  );
  return rows;
}

async function createTask({ orgId, projectId, phaseId, code, name, status, actorUserId, req }) {
  const proj = await getProject({ orgId, id: projectId });
  if (!proj) throw new AppError(404, "Project not found");
  if (proj.status === "archived") throw new AppError(409, "Project is archived");
  if (proj.status === "closed") throw new AppError(409, "Project is closed");

  const phases = await pool.query(
    `SELECT * FROM project_phases WHERE organization_id=$1 AND id=$2 AND project_id=$3`,
    [orgId, phaseId, projectId]
  );
  const phase = phases.rows[0];
  if (!phase) throw new AppError(404, "Phase not found");
  if (phase.status === "archived") throw new AppError(409, "Phase is archived");
  if (phase.status === "closed") throw new AppError(409, "Phase is closed");
  if (phase.status === "closed") throw new AppError(409, "Phase is closed");

  const c = normalizeCode(code);
  assertName(name);
  const st = normalizeStatus(status || "active", TASK_STATUS, "status");
  const { rows } = await pool.query(
    `INSERT INTO project_tasks(organization_id, project_id, phase_id, code, name, status)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [orgId, projectId, phaseId, c, name.trim(), st]
  );
  const created = rows[0];
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.project_task.create",
    entityType: "project_task",
    entityId: created.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: created,
  });
  return created;
}

async function updateTask({ orgId, projectId, phaseId, id, code, name, status, actorUserId, req }) {
  const proj = await getProject({ orgId, id: projectId });
  if (!proj) throw new AppError(404, "Project not found");
  if (proj.status === "archived") throw new AppError(409, "Project is archived");
  if (proj.status === "closed") throw new AppError(409, "Project is closed");
  const { rows: currRows } = await pool.query(
    `SELECT * FROM project_tasks WHERE organization_id=$1 AND id=$2 AND project_id=$3 AND phase_id=$4`,
    [orgId, id, projectId, phaseId]
  );
  const current = currRows[0];
  if (!current) throw new AppError(404, "Task not found");
  const c = code !== undefined ? normalizeCode(code) : current.code;
  const n = name !== undefined ? (assertName(name), name.trim()) : current.name;
  const st = status !== undefined ? normalizeStatus(status, TASK_STATUS, "status") : current.status;
  const { rows } = await pool.query(
    `UPDATE project_tasks SET code=$5, name=$6, status=$7, updated_at=NOW()
     WHERE organization_id=$1 AND id=$2 AND project_id=$3 AND phase_id=$4
     RETURNING *`,
    [orgId, id, projectId, phaseId, c, n, st]
  );
  const updated = rows[0];
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.project_task.update",
    entityType: "project_task",
    entityId: id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: current,
    after: updated,
  });
  return updated;
}

module.exports = {
  listProjects,
  getProject,
  createProject,
  updateProject,
  archiveProject,
  listPhases,
  createPhase,
  updatePhase,
  listTasks,
  createTask,
  updateTask,
};
