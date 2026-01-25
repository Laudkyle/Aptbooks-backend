const { pool } = require("../../../db/pool");

function q(client) { return client || pool;}

// -------------------- Leave Types --------------------
async function createLeaveType(orgId, payload) {
  const { rows } = await pool.query(
    `
      INSERT INTO hr_leave_types (organization_id, code, name, unit, is_paid, status)
      VALUES ($1,$2,$3,$4,$5,'active')
      RETURNING *
    `,
    [orgId, payload.code, payload.name, payload.unit || "days", !!payload.is_paid]
  );
  return rows[0];
}

async function listLeaveTypes(orgId, query = {}) {
  const params = [orgId];
  let where = "WHERE organization_id=$1";
  if (query.status) { params.push(query.status);where += ` AND status=$${params.length}`;}
  const r = await pool.query(`SELECT * FROM hr_leave_types ${where} ORDER BY code ASC`, params);
  return r.rows;
}

async function getLeaveType(orgId, id) {
  const r = await pool.query(`SELECT * FROM hr_leave_types WHERE organization_id=$1 AND id=$2`, [orgId, id]);
  return r.rows[0] || null;
}

async function updateLeaveType(orgId, id, payload) {
  const fields = [];
  const params = [orgId, id];
  const set = (k, v) => { params.push(v);fields.push(`${k}=$${params.length}`);};

  if (payload.code !== undefined) set("code", payload.code);
  if (payload.name !== undefined) set("name", payload.name);
  if (payload.unit !== undefined) set("unit", payload.unit);
  if (payload.is_paid !== undefined) set("is_paid", !!payload.is_paid);
  if (payload.status !== undefined) set("status", payload.status);

  if (!fields.length) return getLeaveType(orgId, id);

  const r = await pool.query(
    `UPDATE hr_leave_types SET ${fields.join(", ")}, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    params
  );
  return r.rows[0] || null;
}

async function deactivateLeaveType(orgId, id) {
  const r = await pool.query(
    `UPDATE hr_leave_types SET status='inactive', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, id]
  );
  return r.rows[0] || null;
}

// -------------------- Leave Balances --------------------
async function upsertLeaveBalance(orgId, { employeeId, leaveTypeId, balanceDays }) {
  const r = await pool.query(
    `
      INSERT INTO hr_leave_balances (organization_id, employee_id, leave_type_id, balance_days)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (organization_id, employee_id, leave_type_id)
      DO UPDATE SET balance_days=EXCLUDED.balance_days, updated_at=NOW()
      RETURNING *
    `,
    [orgId, employeeId, leaveTypeId, balanceDays]
  );
  return r.rows[0];
}

async function getLeaveBalance(orgId, { employeeId, leaveTypeId }, client=null, forUpdate=false) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const r = await q(client).query(
    `SELECT * FROM hr_leave_balances WHERE organization_id=$1 AND employee_id=$2 AND leave_type_id=$3${lock}`,
    [orgId, employeeId, leaveTypeId]
  );
  return r.rows[0] || null;
}

async function listLeaveBalances(orgId, query = {}) {
  const params = [orgId];
  let where = "WHERE b.organization_id=$1";
  if (query.employee_id) { params.push(query.employee_id);where += ` AND b.employee_id=$${params.length}`;}
  if (query.leave_type_id) { params.push(query.leave_type_id);where += ` AND b.leave_type_id=$${params.length}`;}
  const r = await pool.query(
    `
      SELECT b.*, lt.code AS leave_type_code, lt.name AS leave_type_name
      FROM hr_leave_balances b
      JOIN hr_leave_types lt ON lt.id=b.leave_type_id
      ${where}
      ORDER BY lt.code ASC
    `,
    params
  );
  return r.rows;
}

async function insertLeaveLedger(orgId, { employeeId, leaveTypeId, deltaDays, reason, refType=null, refId=null }, client=null) {
  const r = await q(client).query(
    `
      INSERT INTO hr_leave_ledger (organization_id, employee_id, leave_type_id, delta_days, reason, ref_type, ref_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `,
    [orgId, employeeId, leaveTypeId, deltaDays, reason || null, refType, refId]
  );
  return r.rows[0];
}

// -------------------- Leave Requests --------------------
async function createLeaveRequest(orgId, userId, payload) {
  const r = await pool.query(
    `
      INSERT INTO hr_leave_requests
        (organization_id, employee_id, leave_type_id, start_date, end_date, days, reason, status, created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8)
      RETURNING *
    `,
    [orgId, payload.employee_id, payload.leave_type_id, payload.start_date, payload.end_date, payload.days, payload.reason || null, userId]
  );
  return r.rows[0];
}

async function getLeaveRequest(orgId, id, client=null, forUpdate=false) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const r = await q(client).query(
    `
      SELECT lr.*,
             e.employee_no, e.first_name, e.last_name,
             lt.code AS leave_type_code, lt.name AS leave_type_name
      FROM hr_leave_requests lr
      JOIN hr_employees e ON e.id=lr.employee_id
      JOIN hr_leave_types lt ON lt.id=lr.leave_type_id
      WHERE lr.organization_id=$1 AND lr.id=$2
      ${lock}
    `,
    [orgId, id]
  );
  return r.rows[0] || null;
}

async function listLeaveRequests(orgId, query = {}) {
  const params = [orgId];
  let where = "WHERE lr.organization_id=$1";
  if (query.status) { params.push(query.status);where += ` AND lr.status=$${params.length}`;}
  if (query.employee_id) { params.push(query.employee_id);where += ` AND lr.employee_id=$${params.length}`;}
  if (query.leave_type_id) { params.push(query.leave_type_id);where += ` AND lr.leave_type_id=$${params.length}`;}
  if (query.from_date) { params.push(query.from_date);where += ` AND lr.start_date >= $${params.length}`;}
  if (query.to_date) { params.push(query.to_date);where += ` AND lr.end_date <= $${params.length}`;}

  const r = await pool.query(
    `
      SELECT lr.*,
             e.employee_no, e.first_name, e.last_name,
             lt.code AS leave_type_code, lt.name AS leave_type_name
      FROM hr_leave_requests lr
      JOIN hr_employees e ON e.id=lr.employee_id
      JOIN hr_leave_types lt ON lt.id=lr.leave_type_id
      ${where}
      ORDER BY lr.created_at DESC
    `,
    params
  );
  return r.rows;
}

async function setLeaveRequestStatus(orgId, id, status, client=null) {
  const r = await q(client).query(
    `UPDATE hr_leave_requests SET status=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, id, status]
  );
  return r.rows[0] || null;
}

async function setLeaveBalance(orgId, { employeeId, leaveTypeId, newBalance }, client=null) {
  const r = await q(client).query(
    `
      INSERT INTO hr_leave_balances (organization_id, employee_id, leave_type_id, balance_days)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (organization_id, employee_id, leave_type_id)
      DO UPDATE SET balance_days=$4, updated_at=NOW()
      RETURNING *
    `,
    [orgId, employeeId, leaveTypeId, newBalance]
  );
  return r.rows[0];
}

module.exports = {
  // leave types
  createLeaveType, listLeaveTypes, getLeaveType, updateLeaveType, deactivateLeaveType,
  // balances
  upsertLeaveBalance, getLeaveBalance, listLeaveBalances, insertLeaveLedger, setLeaveBalance,
  // requests
  createLeaveRequest, getLeaveRequest, listLeaveRequests, setLeaveRequestStatus,
};
