const { pool } = require("../../../db/pool"); 

async function listConnections({ organizationId }) {
  const { rows } = await pool.query(
    `SELECT * FROM integration_connections WHERE organization_id=$1 ORDER BY created_at DESC`,
    [organizationId]
  ); 
  return rows; 
}

async function getConnection({ organizationId, connectionId }) {
  const { rows } = await pool.query(
    `SELECT * FROM integration_connections WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [organizationId, connectionId]
  ); 
  return rows[0] || null; 
}

async function createConnection({ organizationId, actorUserId, type, name, status, configJson }) {
  const { rows } = await pool.query(
    `
    INSERT INTO integration_connections(
      organization_id, type, name, status, config_json, created_by_user_id
    ) VALUES($1,$2,$3,$4,$5::jsonb,$6)
    RETURNING *
    `,
    [organizationId, type, name, status || 'disabled', JSON.stringify(configJson || {}), actorUserId]
  ); 
  return rows[0]; 
}

async function updateConnection({ organizationId, connectionId, patch }) {
  const fields = []; 
  const values = [organizationId, connectionId]; 
  let i = 3; 

  if (patch.type) { fields.push(`type=$${i++}`);  values.push(patch.type);  }
  if (patch.name) { fields.push(`name=$${i++}`);  values.push(patch.name);  }
  if (patch.status) { fields.push(`status=$${i++}`);  values.push(patch.status);  }
  if (patch.configJson !== undefined) { fields.push(`config_json=$${i++}::jsonb`);  values.push(JSON.stringify(patch.configJson || {}));  }
  if (patch.lastTestedAt !== undefined) { fields.push(`last_tested_at=$${i++}::timestamptz`);  values.push(patch.lastTestedAt);  }
  if (patch.lastTestResult !== undefined) { fields.push(`last_test_result=$${i++}`);  values.push(patch.lastTestResult);  }
  if (patch.lastSyncAt !== undefined) { fields.push(`last_sync_at=$${i++}::timestamptz`);  values.push(patch.lastSyncAt);  }

  fields.push(`updated_at=now()`); 

  const { rows } = await pool.query(
    `UPDATE integration_connections SET ${fields.join(', ')} WHERE organization_id=$1 AND id=$2 RETURNING *`,
    values
  ); 
  return rows[0] || null; 
}

async function deleteConnection({ organizationId, connectionId }) {
  const { rows } = await pool.query(
    `DELETE FROM integration_connections WHERE organization_id=$1 AND id=$2 RETURNING id`,
    [organizationId, connectionId]
  ); 
  return rows[0] || null; 
}

module.exports = { listConnections, getConnection, createConnection, updateConnection, deleteConnection }; 
