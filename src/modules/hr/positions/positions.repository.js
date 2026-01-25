const { pool } = require("../../../db/pool"); 

async function createPosition(orgId, payload) {
  const { rows } = await pool.query(
    `
      INSERT INTO hr_positions (organization_id, code, name, department_id, grade_id, status)
      VALUES ($1,$2,$3,$4,$5,'active')
      RETURNING *
    `,
    [orgId, payload.code, payload.name, payload.department_id || null, payload.grade_id || null]
  ); 
  return rows[0]; 
}

async function listPositions(orgId, query = {}) {
  const status = query.status || null; 
  const departmentId = query.department_id || query.departmentId || null; 
  const { rows } = await pool.query(
    `
      SELECT p.*,
        d.code AS department_code, d.name AS department_name,
        g.code AS grade_code, g.name AS grade_name
      FROM hr_positions p
      LEFT JOIN hr_departments d ON d.id=p.department_id AND d.organization_id=p.organization_id
      LEFT JOIN hr_grades g ON g.id=p.grade_id AND g.organization_id=p.organization_id
      WHERE p.organization_id=$1
        AND ($2::text IS NULL OR p.status=$2)
        AND ($3::uuid IS NULL OR p.department_id=$3)
      ORDER BY p.code
    `,
    [orgId, status, departmentId]
  ); 
  return rows; 
}

async function getPosition(orgId, id) {
  const { rows } = await pool.query(
    `
      SELECT p.*,
        d.code AS department_code, d.name AS department_name,
        g.code AS grade_code, g.name AS grade_name
      FROM hr_positions p
      LEFT JOIN hr_departments d ON d.id=p.department_id AND d.organization_id=p.organization_id
      LEFT JOIN hr_grades g ON g.id=p.grade_id AND g.organization_id=p.organization_id
      WHERE p.organization_id=$1 AND p.id=$2
    `,
    [orgId, id]
  ); 
  return rows[0] || null; 
}

async function getPositionByCode(orgId, code) {
  const { rows } = await pool.query(
    `SELECT * FROM hr_positions WHERE organization_id=$1 AND code=$2`,
    [orgId, code]
  ); 
  return rows[0] || null; 
}

async function updatePosition(orgId, id, payload) {
  const fields = []; 
  const vals = [orgId, id]; 
  let i = 3; 
  for (const k of ["code", "name", "department_id", "grade_id", "status"]) {
    if (payload[k] !== undefined) {
      fields.push(`${k}=$${i++}`); 
      vals.push(payload[k]); 
    }
  }
  if (!fields.length) return getPosition(orgId, id); 
  const { rows } = await pool.query(
    `
      UPDATE hr_positions
      SET ${fields.join(", ")}, updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
    `,
    vals
  ); 
  return rows[0] || null; 
}

async function deactivatePosition(orgId, id) {
  const { rows } = await pool.query(
    `
      UPDATE hr_positions
      SET status='inactive', updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
    `,
    [orgId, id]
  ); 
  return rows[0] || null; 
}

module.exports = { createPosition, listPositions, getPosition, getPositionByCode, updatePosition, deactivatePosition }; 
