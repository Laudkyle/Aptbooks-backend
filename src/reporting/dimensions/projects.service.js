const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");
const { normalizeCode, normalizeStatus } = require("../_util");

// Status constants matching database schema and frontend
const PROJECT_STATUS = ["draft", "active", "on_hold", "completed", "archived"];
const PHASE_STATUS = ["draft", "active", "on_hold", "completed", "archived"];
const TASK_STATUS = ["draft", "active", "on_hold", "completed", "archived"];
const TASK_PRIORITY = ["low", "medium", "high", "critical"];

// Helper function to validate date ranges
function validateDateRange(startDate, endDate, field = "dates") {
  if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
    throw new AppError(400, `End date must be after start date for ${field}`);
  }
}

// Helper to fetch project with validation
async function fetchProjectOrThrow({ orgId, projectId }) {
  const { rows } = await pool.query(
    `SELECT * FROM projects WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, projectId]
  );
  if (!rows.length) throw new AppError(404, "Project not found");
  return rows[0];
}

// Helper to check if project is editable
function assertProjectEditable(project) {
  if (project.status === "archived") {
    throw new AppError(409, "Project is archived and cannot be modified");
  }
  if (project.status === "completed") {
    throw new AppError(409, "Project is completed and cannot be modified");
  }
}

// Helper to check if phase is editable
function assertPhaseEditable(phase) {
  if (phase.status === "archived") {
    throw new AppError(409, "Phase is archived and cannot be modified");
  }
  if (phase.status === "completed") {
    throw new AppError(409, "Phase is completed and cannot be modified");
  }
}

// Helper to check if task is editable
function assertTaskEditable(task) {
  if (task.status === "archived") {
    throw new AppError(409, "Task is archived and cannot be modified");
  }
  if (task.status === "completed") {
    throw new AppError(409, "Task is completed and cannot be modified");
  }
}

function assertName(name, field = "name") {
  if (!name || typeof name !== "string" || !name.trim()) {
    throw new AppError(400, `${field} is required`);
  }
  if (name.trim().length < 2) {
    throw new AppError(400, `${field} must be at least 2 characters`);
  }
}

// ============================
// Projects
// ============================

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
  const { rows } = await pool.query(
    `SELECT * FROM projects WHERE organization_id=$1 AND id=$2`,
    [orgId, id]
  );
  
  if (!rows.length) return null;
  
  // Fetch phases for this project
  const phases = await listPhases({ orgId, projectId: id });
  
  // Fetch tasks for each phase
  for (const phase of phases) {
    phase.tasks = await listTasks({ orgId, projectId: id, phaseId: phase.id });
  }
  
  return {
    ...rows[0],
    phases
  };
}

async function createProject({ orgId, code, name, description, status, start_date, end_date, actorUserId, req }) {
  const c = normalizeCode(code);
  assertName(name);
  
  // Validate date range if both dates provided
  validateDateRange(start_date, end_date, "project");
  
  const st = normalizeStatus(status || "draft", PROJECT_STATUS, "status");
  
  const { rows } = await pool.query(
    `INSERT INTO projects(
      organization_id, code, name, description, status, start_date, end_date, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
    RETURNING *`,
    [orgId, c, name.trim(), description || null, st, start_date || null, end_date || null]
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

async function updateProject({ orgId, id, code, name, description, status, start_date, end_date, actorUserId, req }) {
  const current = await getProject({ orgId, id });
  if (!current) throw new AppError(404, "Project not found");

  // Check editability based on status
  if (current.status === "archived") {
    throw new AppError(409, "Archived projects cannot be modified");
  }
  
  if (current.status === "completed" && status !== "archived") {
    throw new AppError(409, "Completed projects can only be archived");
  }

  // Validate date range if both dates provided
  const newStartDate = start_date !== undefined ? start_date : current.start_date;
  const newEndDate = end_date !== undefined ? end_date : current.end_date;
  validateDateRange(newStartDate, newEndDate, "project");

  const c = code !== undefined ? normalizeCode(code) : current.code;
  const n = name !== undefined ? (assertName(name), name.trim()) : current.name;
  const desc = description !== undefined ? description : current.description;
  const st = status !== undefined ? normalizeStatus(status, PROJECT_STATUS, "status") : current.status;
  
  const { rows } = await pool.query(
    `UPDATE projects SET 
      code=$3, name=$4, description=$5, status=$6, start_date=$7, end_date=$8, updated_at=NOW()
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    [orgId, id, c, n, desc, st, newStartDate, newEndDate]
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
  return updateProject({
    orgId,
    id,
    status: "archived",
    actorUserId,
    req
  });
}

// ============================
// Phases
// ============================

async function listPhases({ orgId, projectId }) {
  const { rows } = await pool.query(
    `SELECT * FROM project_phases 
     WHERE organization_id=$1 AND project_id=$2 
     ORDER BY sort_order ASC, created_at ASC`,
    [orgId, projectId]
  );
  return rows;
}

async function getPhase({ orgId, projectId, phaseId }) {
  const { rows } = await pool.query(
    `SELECT * FROM project_phases 
     WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
    [orgId, projectId, phaseId]
  );
  
  if (!rows.length) return null;
  
  // Fetch tasks for this phase
  const tasks = await listTasks({ orgId, projectId, phaseId });
  
  return {
    ...rows[0],
    tasks
  };
}

async function createPhase({ orgId, projectId, code, name, description, status, start_date, end_date, sort_order, actorUserId, req }) {
  const project = await fetchProjectOrThrow({ orgId, projectId });
  assertProjectEditable(project);

  if (!code) throw new AppError(400, "Phase code is required");
  const c = normalizeCode(code);
  assertName(name);
  
  // Validate date range if both dates provided
  validateDateRange(start_date, end_date, "phase");
  
  const st = normalizeStatus(status || "draft", PHASE_STATUS, "status");
  const sortOrder = sort_order !== undefined ? sort_order : 0;
  
  const { rows } = await pool.query(
    `INSERT INTO project_phases(
      organization_id, project_id, code, name, description, status, start_date, end_date, sort_order, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
    RETURNING *`,
    [orgId, projectId, c, name.trim(), description || null, st, start_date || null, end_date || null, sortOrder]
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

async function updatePhase({ orgId, projectId, id, code, name, description, status, start_date, end_date, sort_order, actorUserId, req }) {
  const project = await fetchProjectOrThrow({ orgId, projectId });
  assertProjectEditable(project);

  const { rows: currRows } = await pool.query(
    `SELECT * FROM project_phases WHERE organization_id=$1 AND id=$2 AND project_id=$3`,
    [orgId, id, projectId]
  );
  
  const current = currRows[0];
  if (!current) throw new AppError(404, "Phase not found");
  
  // Check phase editability
  if (current.status === "archived" && status !== "archived") {
    throw new AppError(409, "Archived phases cannot be modified");
  }
  
  if (current.status === "completed" && status !== "archived") {
    throw new AppError(409, "Completed phases can only be archived");
  }

  // Validate date range if both dates provided
  const newStartDate = start_date !== undefined ? start_date : current.start_date;
  const newEndDate = end_date !== undefined ? end_date : current.end_date;
  validateDateRange(newStartDate, newEndDate, "phase");

  const c = code !== undefined ? normalizeCode(code) : current.code;
  const n = name !== undefined ? (assertName(name), name.trim()) : current.name;
  const desc = description !== undefined ? description : current.description;
  const st = status !== undefined ? normalizeStatus(status, PHASE_STATUS, "status") : current.status;
  const sortOrder = sort_order !== undefined ? sort_order : current.sort_order;
  
  const { rows } = await pool.query(
    `UPDATE project_phases SET 
      code=$4, name=$5, description=$6, status=$7, start_date=$8, end_date=$9, sort_order=$10, updated_at=NOW()
     WHERE organization_id=$1 AND id=$2 AND project_id=$3
     RETURNING *`,
    [orgId, id, projectId, c, n, desc, st, newStartDate, newEndDate, sortOrder]
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

async function archivePhase({ orgId, projectId, id, actorUserId, req }) {
  return updatePhase({
    orgId,
    projectId,
    id,
    status: "archived",
    actorUserId,
    req
  });
}

// ============================
// Tasks
// ============================

async function listTasks({ orgId, projectId, phaseId }) {
  const { rows } = await pool.query(
    `SELECT * FROM project_tasks 
     WHERE organization_id=$1 AND project_id=$2 AND phase_id=$3 
     ORDER BY sort_order ASC, created_at ASC`,
    [orgId, projectId, phaseId]
  );
  return rows;
}

async function getTask({ orgId, projectId, phaseId, taskId }) {
  const { rows } = await pool.query(
    `SELECT * FROM project_tasks 
     WHERE organization_id=$1 AND project_id=$2 AND phase_id=$3 AND id=$4`,
    [orgId, projectId, phaseId, taskId]
  );
  return rows[0] || null;
}

async function createTask({ 
  orgId, 
  projectId, 
  phaseId, 
  code, 
  name, 
  description,
  status, 
  priority,
  assigned_to,
  estimated_hours,
  actual_hours,
  start_date,
  end_date,
  completed_date,
  sort_order,
  actorUserId, 
  req 
}) {
  const project = await fetchProjectOrThrow({ orgId, projectId });
  assertProjectEditable(project);

  const { rows: phaseRows } = await pool.query(
    `SELECT * FROM project_phases WHERE organization_id=$1 AND id=$2 AND project_id=$3`,
    [orgId, phaseId, projectId]
  );
  
  const phase = phaseRows[0];
  if (!phase) throw new AppError(404, "Phase not found");
  
  if (phase.status === "archived") throw new AppError(409, "Cannot add tasks to archived phase");
  if (phase.status === "completed") throw new AppError(409, "Cannot add tasks to completed phase");

  assertName(name);
  
  // Validate date range if both dates provided
  validateDateRange(start_date, end_date, "task");
  
  // Validate completed date if task is completed
  if (status === "completed" && !completed_date) {
    completed_date = new Date().toISOString().split('T')[0];
  }

  const st = normalizeStatus(status || "draft", TASK_STATUS, "status");
  const pri = priority ? normalizeStatus(priority, TASK_PRIORITY, "priority") : "medium";
  const sortOrder = sort_order !== undefined ? sort_order : 0;
  
  const { rows } = await pool.query(
    `INSERT INTO project_tasks(
      organization_id, project_id, phase_id, code, name, description, status, priority,
      assigned_to, estimated_hours, actual_hours, start_date, end_date, completed_date,
      sort_order, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
    RETURNING *`,
    [
      orgId, projectId, phaseId, code || null, name.trim(), description || null, st, pri,
      assigned_to || null, 
      estimated_hours ? parseFloat(estimated_hours) : null,
      actual_hours ? parseFloat(actual_hours) : null,
      start_date || null, end_date || null, completed_date || null,
      sortOrder
    ]
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

async function updateTask({ 
  orgId, 
  projectId, 
  phaseId, 
  id, 
  code, 
  name, 
  description,
  status, 
  priority,
  assigned_to,
  estimated_hours,
  actual_hours,
  start_date,
  end_date,
  completed_date,
  sort_order,
  actorUserId, 
  req 
}) {
  const project = await fetchProjectOrThrow({ orgId, projectId });
  assertProjectEditable(project);

  const { rows: currRows } = await pool.query(
    `SELECT * FROM project_tasks WHERE organization_id=$1 AND id=$2 AND project_id=$3 AND phase_id=$4`,
    [orgId, id, projectId, phaseId]
  );
  
  const current = currRows[0];
  if (!current) throw new AppError(404, "Task not found");
  
  // Check task editability
  if (current.status === "archived" && status !== "archived") {
    throw new AppError(409, "Archived tasks cannot be modified");
  }
  
  if (current.status === "completed" && status !== "archived") {
    throw new AppError(409, "Completed tasks can only be archived");
  }

  // Validate date range if both dates provided
  const newStartDate = start_date !== undefined ? start_date : current.start_date;
  const newEndDate = end_date !== undefined ? end_date : current.end_date;
  validateDateRange(newStartDate, newEndDate, "task");
  
  // Auto-set completed date if task is being marked as completed
  let newCompletedDate = completed_date;
  if (status === "completed" && current.status !== "completed" && !completed_date) {
    newCompletedDate = new Date().toISOString().split('T')[0];
  }

  const c = code !== undefined ? code : current.code;
  const n = name !== undefined ? (assertName(name), name.trim()) : current.name;
  const desc = description !== undefined ? description : current.description;
  const st = status !== undefined ? normalizeStatus(status, TASK_STATUS, "status") : current.status;
  const pri = priority !== undefined ? normalizeStatus(priority, TASK_PRIORITY, "priority") : current.priority;
  const assign = assigned_to !== undefined ? assigned_to : current.assigned_to;
  const estHours = estimated_hours !== undefined ? (estimated_hours ? parseFloat(estimated_hours) : null) : current.estimated_hours;
  const actHours = actual_hours !== undefined ? (actual_hours ? parseFloat(actual_hours) : null) : current.actual_hours;
  const sortOrder = sort_order !== undefined ? sort_order : current.sort_order;
  
  const { rows } = await pool.query(
    `UPDATE project_tasks SET 
      code=$5, name=$6, description=$7, status=$8, priority=$9, assigned_to=$10,
      estimated_hours=$11, actual_hours=$12, start_date=$13, end_date=$14, completed_date=$15,
      sort_order=$16, updated_at=NOW()
     WHERE organization_id=$1 AND id=$2 AND project_id=$3 AND phase_id=$4
     RETURNING *`,
    [
      orgId, id, projectId, phaseId, c, n, desc, st, pri, assign,
      estHours, actHours, newStartDate, newEndDate, newCompletedDate || null,
      sortOrder
    ]
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

async function archiveTask({ orgId, projectId, phaseId, id, actorUserId, req }) {
  return updateTask({
    orgId,
    projectId,
    phaseId,
    id,
    status: "archived",
    actorUserId,
    req
  });
}

async function completeTask({ orgId, projectId, phaseId, id, actorUserId, req }) {
  return updateTask({
    orgId,
    projectId,
    phaseId,
    id,
    status: "completed",
    actorUserId,
    req
  });
}

module.exports = {
  // Projects
  listProjects,
  getProject,
  createProject,
  updateProject,
  archiveProject,
  
  // Phases
  listPhases,
  getPhase,
  createPhase,
  updatePhase,
  archivePhase,
  
  // Tasks
  listTasks,
  getTask,
  createTask,
  updateTask,
  archiveTask,
  completeTask,
  
  // Constants (for frontend reference if needed)
  PROJECT_STATUS,
  PHASE_STATUS,
  TASK_STATUS,
  TASK_PRIORITY
};