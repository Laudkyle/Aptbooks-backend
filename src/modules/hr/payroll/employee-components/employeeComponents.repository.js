const { pool } = require("../../../../db/pool");

function normalize(payload = {}) {
  const p = { ...payload };
  if (p.employeeId && p.employee_id === undefined) p.employee_id = p.employeeId;
  if (p.componentId && p.component_id === undefined) p.component_id = p.componentId;
  return p;
}

async function createAssignment(orgId, payload) {
  const p = normalize(payload);
  const { rows } = await pool.query(
    `
      INSERT INTO hr_employee_pay_components(
        organization_id, employee_id, component_id, amount, percent, status
      ) VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
    `,
    [
      orgId,
      p.employee_id,
      p.component_id,
      p.amount ?? null,
      p.percent ?? null,
      p.status || "active",
    ]
  );
  return rows[0];
}

async function listAssignments(orgId, query = {}) {
  const employeeId = query.employee_id || query.employeeId || null;
  const componentId = query.component_id || query.componentId || null;
  const status = query.status || null;
  const { rows } = await pool.query(
    `
      SELECT a.*, c.code AS component_code, c.name AS component_name, c.kind AS component_kind
      FROM hr_employee_pay_components a
      JOIN hr_payroll_components c ON c.id=a.component_id
      WHERE a.organization_id=$1
        AND ($2::uuid IS NULL OR a.employee_id=$2)
        AND ($3::uuid IS NULL OR a.component_id=$3)
        AND ($4::text IS NULL OR a.status=$4)
      ORDER BY a.created_at DESC
    `,
    [orgId, employeeId, componentId, status]
  );
  return rows;
}

async function getAssignment(orgId, assignmentId) {
  const { rows } = await pool.query(
    `SELECT * FROM hr_employee_pay_components WHERE organization_id=$1 AND id=$2`,
    [orgId, assignmentId]
  );
  return rows[0] || null;
}

async function updateAssignment(orgId, assignmentId, payload) {
  const p = normalize(payload);
  const { rows } = await pool.query(
    `
      UPDATE hr_employee_pay_components
      SET
        employee_id = COALESCE($3, employee_id),
        component_id = COALESCE($4, component_id),
        amount = COALESCE($5, amount),
        percent = COALESCE($6, percent),
        status = COALESCE($7, status),
        updated_at = NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
    `,
    [
      orgId,
      assignmentId,
      p.employee_id ?? null,
      p.component_id ?? null,
      p.amount ?? null,
      p.percent ?? null,
      p.status ?? null,
    ]
  );
  return rows[0];
}

async function setStatus(orgId, assignmentId, status) {
  const { rows } = await pool.query(
    `UPDATE hr_employee_pay_components SET status=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, assignmentId, status]
  );
  return rows[0];
}

module.exports = {
  createAssignment,
  listAssignments,
  getAssignment,
  updateAssignment,
  setStatus,
};
