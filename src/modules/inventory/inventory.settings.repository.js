const { pool } = require("../../db/pool"); 

async function getSetting(orgId, key) {
  const { rows } = await pool.query(
    `SELECT value_json FROM system_settings WHERE organization_id=$1 AND key=$2`,
    [orgId, key]
  ); 
  return rows.length ? rows[0].value_json : null; 
}

async function upsertSetting(orgId, key, valueJson) {
  const { rows } = await pool.query(
    `INSERT INTO system_settings(organization_id, key, value_json)
     VALUES($1,$2,$3)
     ON CONFLICT (organization_id, key) DO UPDATE SET value_json=EXCLUDED.value_json
     RETURNING key, value_json`,
    [orgId, key, valueJson]
  ); 
  return rows[0]; 
}

module.exports = { getSetting, upsertSetting }; 
