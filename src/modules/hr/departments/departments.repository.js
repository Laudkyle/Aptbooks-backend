const { pool } = require("../../../db/pool"); 

async function createDepartment(orgId, payload) {
  const { rows } = await pool.query(
    `
      INSERT INTO hr_departments (organization_id, code, name, status)
      VALUES ($1,$2,$3,'active')
      RETURNING *
    `,
    [orgId, payload.code, payload.name]
  ); 
  return rows[0]; 
}

async function listDepartments(orgId, query = {}) {
  const status = query.status || null; 
  const { rows } = await pool.query(
    `
      SELECT *
      FROM hr_departments
      WHERE organization_id=$1
        AND ($2::text IS NULL OR status=$2)
      ORDER BY code
    `,
    [orgId, status]
  ); 
  return rows; 
}

async function getDepartment(orgId, id) {
  const { rows } = await pool.query(
    `SELECT * FROM hr_departments WHERE organization_id=$1 AND id=$2`,
    [orgId, id]
  ); 
  return rows[0] || null; 
}

async function getDepartmentByCode(orgId, code) {
  const { rows } = await pool.query(
    `SELECT * FROM hr_departments WHERE organization_id=$1 AND code=$2`,
    [orgId, code]
  ); 
  return rows[0] || null; 
}

async function updateDepartment(orgId, id, payload) {
  const fields = []; 
  const vals = [orgId, id]; 
  let i = 3; 
  for (const k of ["code", "name", "status"]) {
    if (payload[k] !== undefined) {
      fields.push(`${k}=$${i++}`); 
      vals.push(payload[k]); 
    }
  }
  if (!fields.length) return getDepartment(orgId, id); 
  const { rows } = await pool.query(
    `
      UPDATE hr_departments
      SET ${fields.join(", ")}, updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
    `,
    vals
  ); 
  return rows[0] || null; 
}

async function deactivateDepartment(orgId, id) {
  const { rows } = await pool.query(
    `
      UPDATE hr_departments
      SET status='inactive', updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
    `,
    [orgId, id]
  ); 
  return rows[0] || null; 
}

module.exports = {
  createDepartment,
  listDepartments,
  getDepartment,
  getDepartmentByCode,
  updateDepartment,
  deactivateDepartment,
}; 
