
const { AppError } = require("../../../../shared/errors/AppError");
const periodIF = require("../../../../interfaces/periodManagement.interface");

function genCode(prefix) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${prefix}-${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function normalizeAmount(value, field = "amount") {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new AppError(400, `${field} must be a positive number`);
  return n;
}

function parseOptionalAmount(value, field = "amount") {
  if (value == null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new AppError(400, `${field} must be a non-negative number`);
  return n;
}

async function findOpenPeriodId(orgId, date, client) {
  const p = await periodIF.findOpenPeriodForDate({ orgId, date, client });
  return p.id;
}

module.exports = { genCode, normalizeAmount, parseOptionalAmount, findOpenPeriodId };
