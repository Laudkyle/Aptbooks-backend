const { pool } = require("../../../../db/pool");

function normalize(payload = {}) {
  const p = { ...payload };
  if (p.expenseAccountId && p.expense_account_id === undefined) p.expense_account_id = p.expenseAccountId;
  if (p.liabilityAccountId && p.liability_account_id === undefined) p.liability_account_id = p.liabilityAccountId;
  if (p.calculationMethod && p.calculation_method === undefined) p.calculation_method = p.calculationMethod;
  return p;
}

async function createComponent(orgId, payload) {
  const p = normalize(payload);
  const { rows } = await pool.query(
    `
      INSERT INTO hr_payroll_components(
        organization_id, code, name, kind, calculation_method,
        expense_account_id, liability_account_id,
        is_taxable, is_statutory, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `,
    [
      orgId,
      p.code,
      p.name,
      p.kind,
      p.calculation_method || "fixed",
      p.expense_account_id || null,
      p.liability_account_id || null,
      Boolean(p.is_taxable),
      Boolean(p.is_statutory),
      p.status || "active",
    ]
  );
  return rows[0];
}

async function listComponents(orgId, query = {}) {
  const status = query.status || null;
  const kind = query.kind || null;
  const { rows } = await pool.query(
    `
      SELECT *
      FROM hr_payroll_components
      WHERE organization_id=$1
        AND ($2::text IS NULL OR status=$2)
        AND ($3::text IS NULL OR kind=$3)
      ORDER BY created_at DESC
    `,
    [orgId, status, kind]
  );
  return rows;
}

async function getComponent(orgId, componentId) {
  const { rows } = await pool.query(
    `SELECT * FROM hr_payroll_components WHERE organization_id=$1 AND id=$2`,
    [orgId, componentId]
  );
  return rows[0] || null;
}

async function updateComponent(orgId, componentId, payload) {
  const p = normalize(payload);
  const { rows } = await pool.query(
    `
      UPDATE hr_payroll_components
      SET
        code = COALESCE($3, code),
        name = COALESCE($4, name),
        kind = COALESCE($5, kind),
        calculation_method = COALESCE($6, calculation_method),
        expense_account_id = COALESCE($7, expense_account_id),
        liability_account_id = COALESCE($8, liability_account_id),
        is_taxable = COALESCE($9, is_taxable),
        is_statutory = COALESCE($10, is_statutory),
        status = COALESCE($11, status),
        updated_at = NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
    `,
    [
      orgId,
      componentId,
      p.code ?? null,
      p.name ?? null,
      p.kind ?? null,
      p.calculation_method ?? null,
      p.expense_account_id ?? null,
      p.liability_account_id ?? null,
      p.is_taxable ?? null,
      p.is_statutory ?? null,
      p.status ?? null,
    ]
  );
  return rows[0];
}

async function setStatus(orgId, componentId, status) {
  const { rows } = await pool.query(
    `UPDATE hr_payroll_components SET status=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, componentId, status]
  );
  return rows[0];
}

module.exports = {
  createComponent,
  listComponents,
  getComponent,
  updateComponent,
  setStatus,
};
