const { pool } = require("../../../db/pool"); 

async function listRules({ organizationId, limit = 100, offset = 0 }) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM dimension_access_rules
    WHERE organization_id=$1
    ORDER BY updated_at DESC
    LIMIT $2 OFFSET $3
    `,
    [organizationId, limit, offset]
  ); 
  return rows; 
}

async function getRule({ organizationId, ruleId }) {
  const { rows } = await pool.query(
    `SELECT * FROM dimension_access_rules WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [organizationId, ruleId]
  ); 
  return rows[0] || null; 
}

async function createRule({ organizationId, actorUserId, principalType, principalId, effect, ruleJson, note }) {
  const { rows } = await pool.query(
    `
    INSERT INTO dimension_access_rules(
      organization_id, principal_type, principal_id, effect, rule_json, note, created_by_user_id
    )
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
    RETURNING *
    `,
    [organizationId, principalType, principalId, effect, JSON.stringify(ruleJson || {}), note || null, actorUserId]
  ); 
  return rows[0]; 
}

async function updateRule({ organizationId, ruleId, patch }) {
  const fields = []; 
  const values = [organizationId, ruleId]; 
  let i = 3; 

  if (patch.principalType) { fields.push(`principal_type=$${i++}`);  values.push(patch.principalType);  }
  if (patch.principalId) { fields.push(`principal_id=$${i++}`);  values.push(patch.principalId);  }
  if (patch.effect) { fields.push(`effect=$${i++}`);  values.push(patch.effect);  }
  if (patch.ruleJson !== undefined) { fields.push(`rule_json=$${i++}::jsonb`);  values.push(JSON.stringify(patch.ruleJson || {}));  }
  if (patch.note !== undefined) { fields.push(`note=$${i++}`);  values.push(patch.note);  }

  fields.push(`updated_at=now()`); 

  const { rows } = await pool.query(
    `
    UPDATE dimension_access_rules
    SET ${fields.join(", ")}
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    values
  ); 
  return rows[0] || null; 
}

async function deleteRule({ organizationId, ruleId }) {
  const { rows } = await pool.query(
    `DELETE FROM dimension_access_rules WHERE organization_id=$1 AND id=$2 RETURNING id`,
    [organizationId, ruleId]
  ); 
  return rows[0] || null; 
}

module.exports = { listRules, getRule, createRule, updateRule, deleteRule }; 
