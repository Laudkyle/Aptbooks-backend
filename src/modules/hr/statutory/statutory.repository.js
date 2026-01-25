const { pool } = require("../../../db/pool"); 

async function findOverlappingActiveRules(orgId, { code, ruleType, effectiveFrom, effectiveTo, excludeId = null }) {
  const r = await pool.query(
    `
      SELECT *
      FROM hr_statutory_rules
      WHERE organization_id=$1
        AND status='active'
        AND code=$2
        AND rule_type=$3
        AND ($4::uuid IS NULL OR id <> $4)
        AND effective_from <= COALESCE($5::date, 'infinity'::date)
        AND COALESCE(effective_to, 'infinity'::date) >= $6::date
      LIMIT 1
    `,
    [orgId, code, ruleType, excludeId, effectiveTo, effectiveFrom]
  ); 
  return r.rows[0] || null; 
}

async function createRule(orgId, payload) {
  const r = await pool.query(
    `
      INSERT INTO hr_statutory_rules
        (organization_id, code, name, description, rule_type, calculation_method, brackets_json, allowance_amount,
         employee_rate, employer_rate, base_on, cap_amount, expense_account_id, liability_account_id,
         effective_from, effective_to, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'active')
      RETURNING *
    `,
    [
      orgId,
      payload.code,
      payload.name,
      payload.description || null,
      payload.rule_type,
      payload.calculation_method || "flat",
      payload.brackets_json || null,
      Number(payload.allowance_amount || 0),
      Number(payload.employee_rate || 0),
      Number(payload.employer_rate || 0),
      payload.base_on || "base",
      payload.cap_amount ?? null,
      payload.expense_account_id,
      payload.liability_account_id,
      payload.effective_from || new Date(),
      payload.effective_to || null,
    ]
  ); 
  return r.rows[0]; 
}

async function getRuleByCode(orgId, code) {
  const r = await pool.query(`SELECT * FROM hr_statutory_rules WHERE organization_id=$1 AND code=$2`, [orgId, code]); 
  return r.rows[0] || null; 
}


async function listRules(orgId, query = {}) {
  const params = [orgId]; 
  let where = "WHERE organization_id=$1"; 
  if (query.status) { params.push(query.status);  where += ` AND status=$${params.length}`;  }
  if (query.rule_type) { params.push(query.rule_type);  where += ` AND rule_type=$${params.length}`;  }
  const r = await pool.query(`SELECT * FROM hr_statutory_rules ${where} ORDER BY code ASC`, params); 
  return r.rows; 
}

async function listRulesEffective(orgId, asOfDate) {
  const r = await pool.query(
    `
      SELECT *
      FROM hr_statutory_rules
      WHERE organization_id=$1
        AND status='active'
        AND effective_from <= $2
        AND (effective_to IS NULL OR effective_to >= $2)
      ORDER BY code ASC
    `,
    [orgId, asOfDate]
  ); 
  return r.rows; 
}

async function getRule(orgId, id) {
  const r = await pool.query(`SELECT * FROM hr_statutory_rules WHERE organization_id=$1 AND id=$2`, [orgId, id]); 
  return r.rows[0] || null; 
}

async function updateRule(orgId, id, payload) {
  const fields = []; 
  const params = [orgId, id]; 
  const set = (k, v) => { params.push(v);  fields.push(`${k}=$${params.length}`);  }; 

  if (payload.code !== undefined) set("code", payload.code); 
  if (payload.name !== undefined) set("name", payload.name); 
  if (payload.description !== undefined) set("description", payload.description); 
  if (payload.rule_type !== undefined) set("rule_type", payload.rule_type); 
  if (payload.calculation_method !== undefined) set("calculation_method", payload.calculation_method); 
  if (payload.brackets_json !== undefined) set("brackets_json", payload.brackets_json); 
  if (payload.allowance_amount !== undefined) set("allowance_amount", payload.allowance_amount); 
  if (payload.employee_rate !== undefined) set("employee_rate", payload.employee_rate); 
  if (payload.employer_rate !== undefined) set("employer_rate", payload.employer_rate); 
  if (payload.base_on !== undefined) set("base_on", payload.base_on); 
  if (payload.cap_amount !== undefined) set("cap_amount", payload.cap_amount); 
  if (payload.expense_account_id !== undefined) set("expense_account_id", payload.expense_account_id); 
  if (payload.liability_account_id !== undefined) set("liability_account_id", payload.liability_account_id); 
  if (payload.effective_from !== undefined) set("effective_from", payload.effective_from); 
  if (payload.effective_to !== undefined) set("effective_to", payload.effective_to); 
  if (payload.status !== undefined) set("status", payload.status); 

  if (!fields.length) return getRule(orgId, id); 

  const r = await pool.query(
    `UPDATE hr_statutory_rules SET ${fields.join(", ")}, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    params
  ); 
  return r.rows[0] || null; 
}

async function deactivateRule(orgId, id) {
  const r = await pool.query(
    `UPDATE hr_statutory_rules SET status='inactive', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, id]
  ); 
  return r.rows[0] || null; 
}

module.exports = {
  findOverlappingActiveRules,
  createRule,
  getRuleByCode,
  listRules,
  listRulesEffective,
  getRule,
  updateRule,
  deactivateRule,
}; 
