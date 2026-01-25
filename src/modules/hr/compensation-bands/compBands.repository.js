const { pool } = require("../../../db/pool"); 

async function createBand(orgId, payload) {
  const { rows } = await pool.query(
    `
      INSERT INTO hr_compensation_bands
        (organization_id, code, name, currency, min_amount, max_amount, pay_frequency, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
      RETURNING *
    `,
    [orgId, payload.code, payload.name, payload.currency || "GHS", payload.min_amount, payload.max_amount, payload.pay_frequency || "monthly"]
  ); 
  return rows[0]; 
}

async function listBands(orgId, query = {}) {
  const status = query.status || null; 
  const { rows } = await pool.query(
    `
      SELECT *
      FROM hr_compensation_bands
      WHERE organization_id=$1
        AND ($2::text IS NULL OR status=$2)
      ORDER BY code
    `,
    [orgId, status]
  ); 
  return rows; 
}

async function getBand(orgId, id) {
  const { rows } = await pool.query(
    `SELECT * FROM hr_compensation_bands WHERE organization_id=$1 AND id=$2`,
    [orgId, id]
  ); 
  return rows[0] || null; 
}

async function getBandByCode(orgId, code) {
  const { rows } = await pool.query(
    `SELECT * FROM hr_compensation_bands WHERE organization_id=$1 AND code=$2`,
    [orgId, code]
  ); 
  return rows[0] || null; 
}

async function updateBand(orgId, id, payload) {
  const fields = []; 
  const vals = [orgId, id]; 
  let i = 3; 
  for (const k of ["code", "name", "currency", "min_amount", "max_amount", "pay_frequency", "status"]) {
    if (payload[k] !== undefined) {
      fields.push(`${k}=$${i++}`); 
      vals.push(payload[k]); 
    }
  }
  if (!fields.length) return getBand(orgId, id); 
  const { rows } = await pool.query(
    `
      UPDATE hr_compensation_bands
      SET ${fields.join(", ")}, updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
    `,
    vals
  ); 
  return rows[0] || null; 
}

async function deactivateBand(orgId, id) {
  const { rows } = await pool.query(
    `
      UPDATE hr_compensation_bands
      SET status='inactive', updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
    `,
    [orgId, id]
  ); 
  return rows[0] || null; 
}

module.exports = { createBand, listBands, getBand, getBandByCode, updateBand, deactivateBand }; 
