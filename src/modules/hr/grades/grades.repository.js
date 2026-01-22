const { pool } = require("../../../db/pool");

async function createGrade(orgId, payload) {
  const { rows } = await pool.query(
    `
      INSERT INTO hr_grades (organization_id, code, name, currency, min_amount, max_amount, status)
      VALUES ($1,$2,$3,$4,$5,$6,'active')
      RETURNING *
    `,
    [orgId, payload.code, payload.name, payload.currency || "GHS", payload.min_amount ?? null, payload.max_amount ?? null]
  );
  return rows[0];
}

async function listGrades(orgId, query = {}) {
  const status = query.status || null;
  const { rows } = await pool.query(
    `
      SELECT *
      FROM hr_grades
      WHERE organization_id=$1
        AND ($2::text IS NULL OR status=$2)
      ORDER BY code
    `,
    [orgId, status]
  );
  return rows;
}

async function getGrade(orgId, id) {
  const { rows } = await pool.query(
    `SELECT * FROM hr_grades WHERE organization_id=$1 AND id=$2`,
    [orgId, id]
  );
  return rows[0] || null;
}

async function getGradeByCode(orgId, code) {
  const { rows } = await pool.query(
    `SELECT * FROM hr_grades WHERE organization_id=$1 AND code=$2`,
    [orgId, code]
  );
  return rows[0] || null;
}

async function updateGrade(orgId, id, payload) {
  const fields = [];
  const vals = [orgId, id];
  let i = 3;
  for (const k of ["code", "name", "currency", "min_amount", "max_amount", "status"]) {
    if (payload[k] !== undefined) {
      fields.push(`${k}=$${i++}`);
      vals.push(payload[k]);
    }
  }
  if (!fields.length) return getGrade(orgId, id);
  const { rows } = await pool.query(
    `
      UPDATE hr_grades
      SET ${fields.join(", ")}, updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
    `,
    vals
  );
  return rows[0] || null;
}

async function deactivateGrade(orgId, id) {
  const { rows } = await pool.query(
    `
      UPDATE hr_grades
      SET status='inactive', updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
    `,
    [orgId, id]
  );
  return rows[0] || null;
}

module.exports = { createGrade, listGrades, getGrade, getGradeByCode, updateGrade, deactivateGrade };
