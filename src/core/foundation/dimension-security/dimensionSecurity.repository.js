const { pool } = require("../../../db/pool");

async function listRules({ organizationId, limit = 100, offset = 0 }) {
  const { rows } = await pool.query(
    `
    SELECT dar.*,
           CASE
             WHEN dar.principal_type='user' THEN COALESCE(u.full_name, u.email)
             WHEN dar.principal_type='role' THEN r.name
             ELSE NULL
           END AS principal_name,
           CASE WHEN dar.principal_type='user' THEN u.email ELSE NULL END AS principal_email
    FROM dimension_access_rules dar
    LEFT JOIN users u
      ON dar.principal_type='user'
     AND u.id=dar.principal_id
     AND u.organization_id=dar.organization_id
    LEFT JOIN roles r
      ON dar.principal_type='role'
     AND r.id=dar.principal_id
     AND r.organization_id=dar.organization_id
    WHERE dar.organization_id=$1
    ORDER BY dar.updated_at DESC
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

async function getPrincipal({ organizationId, principalType, principalId }) {
  const table = principalType === "user" ? "users" : "roles";
  const { rows } = await pool.query(
    `SELECT id FROM ${table} WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [organizationId, principalId]
  );
  return rows[0] || null;
}

async function listOptions({ organizationId }) {
  const [users, roles, locations, assetDepartments, hrDepartments, costCenters, profitCenters, investmentCenters, projects] = await Promise.all([
    pool.query(`SELECT id, full_name, email FROM users WHERE organization_id=$1 AND status='active' AND COALESCE(is_system,false)=false ORDER BY COALESCE(full_name,email)`, [organizationId]),
    pool.query(`SELECT id, name FROM roles WHERE organization_id=$1 ORDER BY name`, [organizationId]),
    pool.query(`SELECT id, code, name FROM org_locations WHERE organization_id=$1 AND status='active' ORDER BY code, name`, [organizationId]),
    pool.query(`SELECT id, code, name FROM org_departments WHERE organization_id=$1 AND status='active' ORDER BY code, name`, [organizationId]),
    pool.query(`SELECT id, code, name FROM hr_departments WHERE organization_id=$1 AND status='active' ORDER BY code, name`, [organizationId]),
    pool.query(`SELECT id, code, name FROM cost_centers WHERE organization_id=$1 AND status='active' ORDER BY code, name`, [organizationId]),
    pool.query(`SELECT id, code, name FROM profit_centers WHERE organization_id=$1 AND status='active' ORDER BY code, name`, [organizationId]),
    pool.query(`SELECT id, code, name FROM investment_centers WHERE organization_id=$1 AND status='active' ORDER BY code, name`, [organizationId]),
    pool.query(`SELECT id, code, name FROM projects WHERE organization_id=$1 AND status IN ('active','completed') ORDER BY code, name`, [organizationId]),
  ]);

  // Asset departments and HR departments are both legitimate human-readable
  // department masters in the current schema. Deduplicate by UUID for selection.
  const departmentMap = new Map();
  for (const row of [...assetDepartments.rows, ...hrDepartments.rows]) departmentMap.set(String(row.id), row);

  return {
    users: users.rows,
    roles: roles.rows,
    locations: locations.rows,
    departments: [...departmentMap.values()],
    costCenters: costCenters.rows,
    profitCenters: profitCenters.rows,
    investmentCenters: investmentCenters.rows,
    projects: projects.rows,
  };
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

  if (patch.principalType) { fields.push(`principal_type=$${i++}`); values.push(patch.principalType); }
  if (patch.principalId) { fields.push(`principal_id=$${i++}`); values.push(patch.principalId); }
  if (patch.effect) { fields.push(`effect=$${i++}`); values.push(patch.effect); }
  if (patch.ruleJson !== undefined) { fields.push(`rule_json=$${i++}::jsonb`); values.push(JSON.stringify(patch.ruleJson || {})); }
  if (patch.note !== undefined) { fields.push(`note=$${i++}`); values.push(patch.note); }

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

module.exports = { listRules, getRule, getPrincipal, listOptions, createRule, updateRule, deleteRule };
