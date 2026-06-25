const { pool } = require("../../../db/pool");

function normalizeEmployeePayload(payload = {}) {
  const out = { ...payload };
  // Accept common alternative keys without breaking API clients.
  if (out.departmentId && out.department_id === undefined) out.department_id = out.departmentId;
  if (out.positionId && out.position_id === undefined) out.position_id = out.positionId;
  if (out.gradeId && out.grade_id === undefined) out.grade_id = out.gradeId;
  if (out.costCenterId && out.cost_center_id === undefined) out.cost_center_id = out.costCenterId;
  if (out.expenseAccountId && out.expense_account_id === undefined) out.expense_account_id = out.expenseAccountId;
  if (out.payableAccountId && out.payable_account_id === undefined) out.payable_account_id = out.payableAccountId;
  if (out.compensationBandId && out.compensation_band_id === undefined) out.compensation_band_id = out.compensationBandId;
  return out;
}

async function createEmployee(orgId, payload) {
  const p = normalizeEmployeePayload(payload);
  const { rows } = await pool.query(
    `
      INSERT INTO hr_employees (
        organization_id, employee_no, first_name, last_name, other_names, email, phone,
        hire_date, status,
        department_id, position_id, grade_id, cost_center_id,
        expense_account_id, payable_account_id,
        compensation_band_id, base_salary_amount, base_salary_currency, base_salary_frequency,
        bank_name, bank_account_no, bank_branch,
        tax_id, national_id
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,
        $8,$9,
        $10,$11,$12,$13,
        $14,$15,
        $16,$17,$18,$19,
        $20,$21,$22,
        $23,$24
      )
      RETURNING *
    `,
    [
      orgId,
      p.employee_no,
      p.first_name,
      p.last_name,
      p.other_names || null,
      p.email || null,
      p.phone || null,
      p.hire_date ? new Date(p.hire_date) : null,
      p.status || "draft",
      p.department_id || null,
      p.position_id || null,
      p.grade_id || null,
      p.cost_center_id || null,
      p.expense_account_id || null,
      p.payable_account_id || null,
      p.compensation_band_id || null,
      p.base_salary_amount ?? null,
      p.base_salary_currency || null,
      p.base_salary_frequency || null,
      p.bank_name || null,
      p.bank_account_no || null,
      p.bank_branch || null,
      p.tax_id || null,
      p.national_id || null,
    ]
  );
  return rows[0];
}

async function listEmployees(orgId, query = {}) {
  const status = query.status || null;
  const departmentId = query.department_id || query.departmentId || null;
  const costCenterId = query.cost_center_id || query.costCenterId || null;
  const search = query.search || null;
  const { rows } = await pool.query(
    `
      SELECT e.*,
        d.code AS department_code, d.name AS department_name,
        p.code AS position_code, p.name AS position_name,
        g.code AS grade_code, g.name AS grade_name,
        cc.code AS cost_center_code, cc.name AS cost_center_name,
        exp.code AS expense_account_code, exp.name AS expense_account_name,
        pay.code AS payable_account_code, pay.name AS payable_account_name,
        cb.code AS comp_band_code, cb.name AS comp_band_name
      FROM hr_employees e
      LEFT JOIN hr_departments d ON d.id=e.department_id AND d.organization_id=e.organization_id
      LEFT JOIN hr_positions p ON p.id=e.position_id AND p.organization_id=e.organization_id
      LEFT JOIN hr_grades g ON g.id=e.grade_id AND g.organization_id=e.organization_id
      LEFT JOIN cost_centers cc ON cc.id=e.cost_center_id AND cc.organization_id=e.organization_id
      LEFT JOIN chart_of_accounts exp ON exp.id=e.expense_account_id AND exp.organization_id=e.organization_id
      LEFT JOIN chart_of_accounts pay ON pay.id=e.payable_account_id AND pay.organization_id=e.organization_id
      LEFT JOIN hr_compensation_bands cb ON cb.id=e.compensation_band_id AND cb.organization_id=e.organization_id
      WHERE e.organization_id=$1
        AND ($2::text IS NULL OR e.status=$2)
        AND ($3::uuid IS NULL OR e.department_id=$3)
        AND ($4::uuid IS NULL OR e.cost_center_id=$4)
        AND (
          $5::text IS NULL OR
          (e.employee_no ILIKE '%'||$5||'%') OR
          (e.first_name ILIKE '%'||$5||'%') OR
          (e.last_name ILIKE '%'||$5||'%') OR
          (COALESCE(e.email,'') ILIKE '%'||$5||'%')
        )
      ORDER BY e.employee_no
    `,
    [orgId, status, departmentId, costCenterId, search]
  );
  return rows;
}

async function getEmployee(orgId, id) {
  const { rows } = await pool.query(
    `
      SELECT e.*,
        d.code AS department_code, d.name AS department_name,
        p.code AS position_code, p.name AS position_name,
        g.code AS grade_code, g.name AS grade_name,
        cc.code AS cost_center_code, cc.name AS cost_center_name,
        exp.code AS expense_account_code, exp.name AS expense_account_name,
        pay.code AS payable_account_code, pay.name AS payable_account_name,
        cb.code AS comp_band_code, cb.name AS comp_band_name
      FROM hr_employees e
      LEFT JOIN hr_departments d ON d.id=e.department_id AND d.organization_id=e.organization_id
      LEFT JOIN hr_positions p ON p.id=e.position_id AND p.organization_id=e.organization_id
      LEFT JOIN hr_grades g ON g.id=e.grade_id AND g.organization_id=e.organization_id
      LEFT JOIN cost_centers cc ON cc.id=e.cost_center_id AND cc.organization_id=e.organization_id
      LEFT JOIN chart_of_accounts exp ON exp.id=e.expense_account_id AND exp.organization_id=e.organization_id
      LEFT JOIN chart_of_accounts pay ON pay.id=e.payable_account_id AND pay.organization_id=e.organization_id
      LEFT JOIN hr_compensation_bands cb ON cb.id=e.compensation_band_id AND cb.organization_id=e.organization_id
      WHERE e.organization_id=$1 AND e.id=$2
    `,
    [orgId, id]
  );
  return rows[0] || null;
}

async function getEmployeeByNo(orgId, employeeNo) {
  const { rows } = await pool.query(
    `SELECT * FROM hr_employees WHERE organization_id=$1 AND employee_no=$2`,
    [orgId, employeeNo]
  );
  return rows[0] || null;
}

async function updateEmployee(orgId, id, payload) {
  const p = normalizeEmployeePayload(payload);
  const fields = [];
  const vals = [orgId, id];
  let i = 3;

  const map = {
    employee_no: "employee_no",
    first_name: "first_name",
    last_name: "last_name",
    other_names: "other_names",
    email: "email",
    phone: "phone",
    hire_date: "hire_date",
    status: "status",
    department_id: "department_id",
    position_id: "position_id",
    grade_id: "grade_id",
    cost_center_id: "cost_center_id",
    expense_account_id: "expense_account_id",
    payable_account_id: "payable_account_id",
    compensation_band_id: "compensation_band_id",
    base_salary_amount: "base_salary_amount",
    base_salary_currency: "base_salary_currency",
    base_salary_frequency: "base_salary_frequency",
    bank_name: "bank_name",
    bank_account_no: "bank_account_no",
    bank_branch: "bank_branch",
    tax_id: "tax_id",
    national_id: "national_id",
  };

  for (const [k, col] of Object.entries(map)) {
    if (p[k] !== undefined) {
      fields.push(`${col}=$${i++}`);
      if (k === "hire_date") vals.push(p.hire_date ? new Date(p.hire_date) : null);
      else vals.push(p[k]);
    }
  }

  if (!fields.length) return getEmployee(orgId, id);

  const { rows } = await pool.query(
    `
      UPDATE hr_employees
      SET ${fields.join(", ")}, updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
    `,
    vals
  );
  return rows[0] || null;
}

async function setEmployeeStatus(orgId, id, status) {
  const { rows } = await pool.query(
    `
      UPDATE hr_employees
      SET status=$3, updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
    `,
    [orgId, id, status]
  );
  return rows[0] || null;
}

async function deleteEmployee(orgId, id) {
  // Soft delete: employees may be referenced by payroll, leave, benefits, and audit records.
  // Mark inactive instead of hard-deleting to preserve accounting/history integrity.
  return setEmployeeStatus(orgId, id, "inactive");
}

module.exports = {
  createEmployee,
  listEmployees,
  getEmployee,
  getEmployeeByNo,
  updateEmployee,
  setEmployeeStatus,
  deleteEmployee,
};
