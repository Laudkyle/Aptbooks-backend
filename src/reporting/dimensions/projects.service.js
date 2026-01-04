const { AppError } = require("../../shared/errors/AppError");
const { pool } = require("../../db/pool");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");

function assertCode(code) {
  if (!code || typeof code !== "string") throw new AppError(400, "code is required");
}

function assertName(name) {
  if (!name || typeof name !== "string") throw new AppError(400, "name is required");
}

async function listProjects({ orgId }) {
  const { rows } = await pool.query(
    `SELECT id, code, name, status, start_date, end_date, created_at, updated_at FROM projects WHERE organization_id=$1 ORDER BY code`,
    [orgId]
  );
  return rows;
}

async function createProject({ orgId, code, name, startDate, endDate, status, actorUserId, req }) {
  assertCode(code);
  assertName(name);
  const { rows } = await pool.query(
    `
    INSERT INTO projects(organization_id, code, name, start_date, end_date, status)
    VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING id, code, name, status, start_date, end_date, created_at, updated_at
    `,
    [orgId, code, name, startDate || null, endDate || null, status || 'open']
  );

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.project.create",
    entityType: "project",
    entityId: rows[0].id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: rows[0],
  });
  return rows[0];
}

async function assertProject({ orgId, projectId }) {
  const { rows } = await pool.query(
    `SELECT id FROM projects WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, projectId]
  );
  if (!rows.length) throw new AppError(404, "Project not found");
}

async function createPhase({ orgId, projectId, code, name, status, sortOrder, actorUserId, req }) {
  await assertProject({ orgId, projectId });
  assertCode(code);
  assertName(name);

  const { rows } = await pool.query(
    `
    INSERT INTO project_phases(organization_id, project_id, code, name, status, sort_order)
    VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING id, project_id, code, name, status, sort_order
    `,
    [orgId, projectId, code, name, status || 'open', Number(sortOrder || 0)]
  );

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.project.phase.create",
    entityType: "project_phase",
    entityId: rows[0].id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: rows[0],
  });
  return rows[0];
}

async function assertPhase({ orgId, projectId, phaseId }) {
  const { rows } = await pool.query(
    `
    SELECT id FROM project_phases
    WHERE organization_id=$1 AND project_id=$2 AND id=$3
    LIMIT 1
    `,
    [orgId, projectId, phaseId]
  );
  if (!rows.length) throw new AppError(404, "Project phase not found");
}

async function createTask({ orgId, projectId, phaseId, code, name, status, sortOrder, actorUserId, req }) {
  await assertProject({ orgId, projectId });
  await assertPhase({ orgId, projectId, phaseId });
  assertCode(code);
  assertName(name);

  const { rows } = await pool.query(
    `
    INSERT INTO project_tasks(organization_id, project_id, phase_id, code, name, status, sort_order)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING id, project_id, phase_id, code, name, status, sort_order
    `,
    [orgId, projectId, phaseId, code, name, status || 'open', Number(sortOrder || 0)]
  );

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.project.task.create",
    entityType: "project_task",
    entityId: rows[0].id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: rows[0],
  });
  return rows[0];
}

module.exports = { listProjects, createProject, createPhase, createTask };
