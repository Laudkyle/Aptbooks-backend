const { pool } = require('../../db/pool');
const { AppError } = require('../../shared/errors/AppError');

async function resolvePeriodIdForDate(orgId, entryDate, client = null) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT id, status FROM accounting_periods
     WHERE organization_id=$1 AND $2::date BETWEEN start_date AND end_date
     ORDER BY start_date DESC LIMIT 1`,
    [orgId, entryDate]
  );
  if (!rows.length) throw new AppError(404, 'No accounting period found for entryDate');
  if (rows[0].status !== 'open') throw new AppError(409, 'Accounting period for entryDate is not open');
  return rows[0].id;
}

function normalizeEntryDate(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

module.exports = { resolvePeriodIdForDate, normalizeEntryDate };
