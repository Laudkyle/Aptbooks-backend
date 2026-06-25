const { pool } = require("../../../db/pool");

// Headcount by department / status
async function headcountSummary(orgId, query = {}) {
  const params = [orgId];
  let where = "WHERE e.organization_id=$1";
  if (query.status) { params.push(query.status); where += ` AND e.status=$${params.length}`; }

  const r = await pool.query(
    `
      SELECT
        d.id AS department_id,
        d.code AS department_code,
        d.name AS department_name,
        e.status,
        COUNT(*)::int AS headcount
      FROM hr_employees e
      LEFT JOIN hr_departments d ON d.id=e.department_id
      ${where}
      GROUP BY d.id, d.code, d.name, e.status
      ORDER BY d.code NULLS LAST, e.status ASC
    `,
    params
  );
  return r.rows;
}

async function leaveBalancesSummary(orgId, query = {}) {
  const params = [orgId];
  let where = "WHERE b.organization_id=$1";
  if (query.leave_type_id) { params.push(query.leave_type_id); where += ` AND b.leave_type_id=$${params.length}`; }

  const r = await pool.query(
    `
      SELECT
        lt.id AS leave_type_id,
        lt.code AS leave_type_code,
        lt.name AS leave_type_name,
        COUNT(DISTINCT b.employee_id)::int AS employees,
        COALESCE(SUM(b.balance_days),0)::numeric AS total_balance_days
      FROM hr_leave_balances b
      JOIN hr_leave_types lt ON lt.id=b.leave_type_id
      ${where}
      GROUP BY lt.id, lt.code, lt.name
      ORDER BY lt.code ASC
    `,
    params
  );
  return r.rows;
}

async function payrollCostSummary(orgId, query = {}) {
  // Summarize payroll run totals by accounting period, optionally by run_id.
  // hr_payroll_runs does not store a standalone run code or period dates;
  // those values come from accounting_periods.
  const params = [orgId];
  let where = "WHERE r.organization_id=$1";

  if (query.run_id) { params.push(query.run_id); where += ` AND r.id=$${params.length}`; }
  if (query.period_id) { params.push(query.period_id); where += ` AND r.period_id=$${params.length}`; }
  if (query.status) { params.push(query.status); where += ` AND r.status=$${params.length}`; }
  if (query.period_start) { params.push(query.period_start); where += ` AND p.start_date >= $${params.length}`; }
  if (query.period_end) { params.push(query.period_end); where += ` AND p.end_date <= $${params.length}`; }
  if (query.pay_date_from) { params.push(query.pay_date_from); where += ` AND r.pay_date >= $${params.length}`; }
  if (query.pay_date_to) { params.push(query.pay_date_to); where += ` AND r.pay_date <= $${params.length}`; }

  const r = await pool.query(
    `
      SELECT
        r.id AS run_id,
        CONCAT('PAYROLL-', p.code, '-', TO_CHAR(r.pay_date, 'YYYYMMDD')) AS code,
        p.code AS period_code,
        r.period_id,
        p.start_date AS period_start,
        p.end_date AS period_end,
        r.pay_date,
        r.currency,
        r.status,
        COALESCE(SUM(l.gross_pay),0)::numeric AS gross_pay,
        COALESCE(SUM(l.total_deductions),0)::numeric AS total_deductions,
        COALESCE(SUM(l.net_pay),0)::numeric AS net_pay,
        COUNT(l.id)::int AS employees
      FROM hr_payroll_runs r
      JOIN accounting_periods p ON p.id=r.period_id
      LEFT JOIN hr_payroll_run_lines l ON l.payroll_run_id=r.id
      ${where}
      GROUP BY r.id, p.code, p.start_date, p.end_date, r.period_id, r.pay_date, r.currency, r.status, r.created_at
      ORDER BY p.start_date DESC, r.pay_date DESC, r.created_at DESC
    `,
    params
  );
  return r.rows;
}

module.exports = { headcountSummary, leaveBalancesSummary, payrollCostSummary };
