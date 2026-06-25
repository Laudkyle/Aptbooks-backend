const { pool } = require("../../../../db/pool");

async function createRun(orgId, actorUserId, payload) {
  const { rows } = await pool.query(
    `
      INSERT INTO hr_payroll_runs(organization_id, period_id, pay_date, currency, status, created_by)
      VALUES($1,$2,$3,$4,'draft',$5)
      RETURNING *
    `,
    [orgId, payload.period_id, new Date(payload.pay_date), (payload.currency || 'GHS').toUpperCase(), actorUserId]
  );
  return rows[0];
}

async function listRuns(orgId, query = {}) {
  const periodId = query.period_id || query.periodId || null;
  const status = query.status || null;
  const { rows } = await pool.query(
    `
      SELECT r.*, p.code AS period_code, p.start_date, p.end_date
      FROM hr_payroll_runs r
      JOIN accounting_periods p ON p.id=r.period_id
      WHERE r.organization_id=$1
        AND ($2::uuid IS NULL OR r.period_id=$2)
        AND ($3::text IS NULL OR r.status=$3)
      ORDER BY r.created_at DESC
    `,
    [orgId, periodId, status]
  );
  return rows;
}

async function getRun(orgId, runId) {
  const { rows } = await pool.query(
    `SELECT * FROM hr_payroll_runs WHERE organization_id=$1 AND id=$2`,
    [orgId, runId]
  );
  return rows[0] || null;
}

async function setRunStatus(orgId, runId, status, actorUserId, client = null) {
  const db = client || pool;
  const { rows } = await db.query(
    `UPDATE hr_payroll_runs SET status=$3, updated_at=NOW(), updated_by=$4 WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, runId, status, actorUserId]
  );
  return rows[0];
}

async function getPeriod(orgId, periodId) {
  const { rows } = await pool.query(
    `SELECT * FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  return rows[0] || null;
}

async function replaceRunLines(orgId, runId, lines) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM hr_payroll_run_lines WHERE organization_id=$1 AND payroll_run_id=$2`,
      [orgId, runId]
    );
    let i = 0;
    for (const l of lines) {
      i += 1;
      await client.query(
        `
          INSERT INTO hr_payroll_run_lines(
            organization_id, payroll_run_id, line_no, employee_id,
            base_salary, total_earnings, total_deductions, gross_pay, net_pay,
            currency, breakdown_json
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `,
        [
          orgId,
          runId,
          i,
          l.employee_id,
          l.base_salary ?? 0,
          l.total_earnings ?? 0,
          l.total_deductions ?? 0,
          l.gross_pay ?? 0,
          l.net_pay ?? 0,
          (l.currency || 'GHS').toUpperCase(),
          l.breakdown || {},
        ]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function listRunLines(orgId, runId) {
  const { rows } = await pool.query(
    `
      SELECT l.*, e.employee_no, e.first_name, e.last_name
      FROM hr_payroll_run_lines l
      JOIN hr_employees e ON e.id=l.employee_id
      WHERE l.organization_id=$1 AND l.payroll_run_id=$2
      ORDER BY l.line_no ASC
    `,
    [orgId, runId]
  );
  return rows;
}

async function getEmployeesForIds(orgId, employeeIds) {
  const { rows } = await pool.query(
    `
      SELECT id, employee_no, expense_account_id, payable_account_id
      FROM hr_employees
      WHERE organization_id=$1 AND id = ANY($2::uuid[])
    `,
    [orgId, employeeIds]
  );
  return rows;
}

async function getRunJournal(orgId, runId) {
  const { rows } = await pool.query(
    `
      SELECT pj.*, je.status AS journal_status
      FROM hr_payroll_run_postings pj
      LEFT JOIN journal_entries je ON je.id=pj.journal_entry_id
      WHERE pj.organization_id=$1 AND pj.payroll_run_id=$2
    `,
    [orgId, runId]
  );
  return rows[0] || null;
}

async function linkRunJournal(orgId, runId, journalId, actorUserId) {
  const { rows } = await pool.query(
    `
      INSERT INTO hr_payroll_run_postings(organization_id, payroll_run_id, journal_entry_id, created_by)
      VALUES($1,$2,$3,$4)
      ON CONFLICT (organization_id, payroll_run_id) DO UPDATE
        SET journal_entry_id=EXCLUDED.journal_entry_id, updated_at=NOW(), updated_by=EXCLUDED.created_by
      RETURNING *
    `,
    [orgId, runId, journalId, actorUserId]
  );
  return rows[0];
}

async function markJournalPosted(orgId, runId, journalId, actorUserId, client = null) {
  const db = client || pool;
  const { rows } = await db.query(
    `
      UPDATE hr_payroll_run_postings
      SET posted_at=NOW(), posted_by=$4, updated_at=NOW(), updated_by=$4
      WHERE organization_id=$1 AND payroll_run_id=$2 AND journal_entry_id=$3
      RETURNING *
    `,
    [orgId, runId, journalId, actorUserId]
  );
  return rows[0];
}

module.exports = {
  createRun,
  listRuns,
  getRun,
  setRunStatus,
  getPeriod,
  replaceRunLines,
  listRunLines,
  getEmployeesForIds,
  getRunJournal,
  linkRunJournal,
  markJournalPosted,
};
