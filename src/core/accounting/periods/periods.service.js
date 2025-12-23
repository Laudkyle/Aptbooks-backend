const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");

async function createPeriod({ orgId, payload }) {
  const { rows } = await pool.query(
    `
    INSERT INTO accounting_periods (organization_id, code, start_date, end_date, status)
    VALUES ($1,$2,$3,$4,'open')
    RETURNING id, code, start_date, end_date, status
    `,
    [orgId, payload.code, payload.startDate, payload.endDate]
  );
  return rows[0];
}

async function listPeriods({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM accounting_periods WHERE organization_id=$1 ORDER BY start_date`,
    [orgId]
  );
  return rows;
}

async function closePeriod({ orgId, periodId }) {
  const { rows: beforeRows } = await pool.query(
    `SELECT * FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!beforeRows.length) throw new AppError(404, "Period not found");
  if (beforeRows[0].status !== "open") throw new AppError(409, "Period must be open to close");

  const { rows: afterRows } = await pool.query(
    `
    UPDATE accounting_periods
    SET status='closed', updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [orgId, periodId]
  );

  return { id: periodId, before: beforeRows[0], after: afterRows[0] };
}

async function reopenPeriod({ orgId, periodId }) {
  const { rows: beforeRows } = await pool.query(
    `SELECT * FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!beforeRows.length) throw new AppError(404, "Period not found");
  if (beforeRows[0].status !== "closed") throw new AppError(409, "Period must be closed to reopen");

  const { rows: afterRows } = await pool.query(
    `
    UPDATE accounting_periods
    SET status='open', updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [orgId, periodId]
  );

  return { id: periodId, before: beforeRows[0], after: afterRows[0] };
}

module.exports = { createPeriod, listPeriods, closePeriod, reopenPeriod };
