const { pool } = require("../../../db/pool");

async function createBenefitPlan(orgId, payload) {
  const r = await pool.query(
    `
      INSERT INTO hr_benefit_plans
        (organization_id, code, name, description, employer_rate, employee_rate, base_on, cap_amount, expense_account_id, liability_account_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')
      RETURNING *
    `,
    [
      orgId,
      payload.code,
      payload.name,
      payload.description || null,
      payload.employer_rate,
      payload.employee_rate,
      payload.base_on || 'base',
      payload.cap_amount ?? null,
      payload.expense_account_id,
      payload.liability_account_id,
    ]
  );
  return r.rows[0];
}

async function listBenefitPlans(orgId, query = {}) {
  const params = [orgId];
  let where = "WHERE organization_id=$1";
  if (query.status) { params.push(query.status); where += ` AND status=$${params.length}`; }
  const r = await pool.query(`SELECT * FROM hr_benefit_plans ${where} ORDER BY code ASC`, params);
  return r.rows;
}

async function getBenefitPlan(orgId, id) {
  const r = await pool.query(`SELECT * FROM hr_benefit_plans WHERE organization_id=$1 AND id=$2`, [orgId, id]);
  return r.rows[0] || null;
}

async function getBenefitPlanByCode(orgId, code) {
  const r = await pool.query(`SELECT * FROM hr_benefit_plans WHERE organization_id=$1 AND code=$2`, [orgId, code]);
  return r.rows[0] || null;
}

async function updateBenefitPlan(orgId, id, payload) {
  const fields = [];
  const params = [orgId, id];
  const set = (k, v) => { params.push(v); fields.push(`${k}=$${params.length}`); };
  if (payload.code !== undefined) set("code", payload.code);
  if (payload.name !== undefined) set("name", payload.name);
  if (payload.description !== undefined) set("description", payload.description);
  if (payload.employer_rate !== undefined) set("employer_rate", payload.employer_rate);
  if (payload.employee_rate !== undefined) set("employee_rate", payload.employee_rate);
  if (payload.base_on !== undefined) set("base_on", payload.base_on);
  if (payload.cap_amount !== undefined) set("cap_amount", payload.cap_amount);
  if (payload.expense_account_id !== undefined) set("expense_account_id", payload.expense_account_id);
  if (payload.liability_account_id !== undefined) set("liability_account_id", payload.liability_account_id);
  if (payload.status !== undefined) set("status", payload.status);

  if (!fields.length) return getBenefitPlan(orgId, id);

  const r = await pool.query(
    `UPDATE hr_benefit_plans SET ${fields.join(", ")}, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    params
  );
  return r.rows[0] || null;
}

async function deactivateBenefitPlan(orgId, id) {
  const r = await pool.query(
    `UPDATE hr_benefit_plans SET status='inactive', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, id]
  );
  return r.rows[0] || null;
}

async function assignEmployeeBenefit(orgId, payload) {
  const r = await pool.query(
    `
      INSERT INTO hr_employee_benefits
        (organization_id, employee_id, benefit_plan_id, effective_from, effective_to, status)
      VALUES ($1,$2,$3,$4,$5,'active')
      RETURNING *
    `,
    [orgId, payload.employee_id, payload.benefit_plan_id, payload.effective_from, payload.effective_to || null]
  );
  return r.rows[0];
}

async function listEmployeeBenefits(orgId, query = {}) {
  const params = [orgId];
  let where = "WHERE eb.organization_id=$1";
  if (query.employee_id) { params.push(query.employee_id); where += ` AND eb.employee_id=$${params.length}`; }
  if (query.benefit_plan_id) { params.push(query.benefit_plan_id); where += ` AND eb.benefit_plan_id=$${params.length}`; }
  if (query.status) { params.push(query.status); where += ` AND eb.status=$${params.length}`; }

  const r = await pool.query(
    `
      SELECT eb.*, bp.code AS plan_code, bp.name AS plan_name
      FROM hr_employee_benefits eb
      JOIN hr_benefit_plans bp ON bp.id=eb.benefit_plan_id
      ${where}
      ORDER BY eb.created_at DESC
    `,
    params
  );
  return r.rows;
}

async function getEmployeeBenefit(orgId, id) {
  const r = await pool.query(
    `
      SELECT eb.*, bp.code AS plan_code, bp.name AS plan_name
      FROM hr_employee_benefits eb
      JOIN hr_benefit_plans bp ON bp.id=eb.benefit_plan_id
      WHERE eb.organization_id=$1 AND eb.id=$2
    `,
    [orgId, id]
  );
  return r.rows[0] || null;
}

async function listEmployeeBenefitsEffective(orgId, asOfDate) {
  const r = await pool.query(
    `
      SELECT eb.*, bp.code AS plan_code, bp.name AS plan_name,
             bp.employer_rate, bp.employee_rate, bp.expense_account_id, bp.liability_account_id,
             bp.status AS plan_status
      FROM hr_employee_benefits eb
      JOIN hr_benefit_plans bp ON bp.id=eb.benefit_plan_id
      WHERE eb.organization_id=$1
        AND eb.status='active'
        AND bp.status='active'
        AND eb.effective_from <= $2
        AND (eb.effective_to IS NULL OR eb.effective_to >= $2)
    `,
    [orgId, asOfDate]
  );
  return r.rows;
}

async function updateEmployeeBenefit(orgId, id, payload) {
  const fields = [];
  const params = [orgId, id];
  const set = (k, v) => { params.push(v); fields.push(`${k}=$${params.length}`); };
  if (payload.effective_from !== undefined) set("effective_from", payload.effective_from);
  if (payload.effective_to !== undefined) set("effective_to", payload.effective_to);
  if (payload.status !== undefined) set("status", payload.status);

  if (!fields.length) return getEmployeeBenefit(orgId, id);

  const r = await pool.query(
    `UPDATE hr_employee_benefits SET ${fields.join(", ")}, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    params
  );
  return r.rows[0] || null;
}

async function deactivateEmployeeBenefit(orgId, id) {
  const r = await pool.query(
    `UPDATE hr_employee_benefits SET status='inactive', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, id]
  );
  return r.rows[0] || null;
}

module.exports = {
  createBenefitPlan, listBenefitPlans, getBenefitPlan, updateBenefitPlan, deactivateBenefitPlan,
  getBenefitPlanByCode,
  assignEmployeeBenefit, listEmployeeBenefits, getEmployeeBenefit, updateEmployeeBenefit, deactivateEmployeeBenefit,
  listEmployeeBenefitsEffective,
};
