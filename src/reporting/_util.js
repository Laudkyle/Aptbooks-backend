const { AppError } = require("../shared/errors/AppError");
const Decimal = require("decimal.js");

function normalizeCode(code) {
  if (code === null || code === undefined) return null;
  if (typeof code !== "string") throw new AppError(400, "code must be a string");
  const v = code.trim();
  if (!v) throw new AppError(400, "code is required");
  return v.toUpperCase();
}
function assertCode(code) {
  if (code === null || code === undefined) return null;
  if (typeof code !== "string") throw new AppError(400, "code must be a string");
  const v = code.trim();
  if (!v) throw new AppError(400, "code is required");
  return v.toUpperCase();
}
function assertName(name) {
  if (name === null || name === undefined) return null;
  if (typeof name !== "string") throw new AppError(400, "code must be a string");
  const v = name.trim();
  if (!v) throw new AppError(400, "code is required");
  return v.toUpperCase();
}

function normalizeStatus(status, allowed, fieldName = "status") {
  if (status === null || status === undefined) return null;
  if (typeof status !== "string") throw new AppError(400, `${fieldName} must be a string`);
  const v = status.trim().toLowerCase();
  if (!allowed.includes(v)) throw new AppError(400, `${fieldName} must be one of: ${allowed.join(", ")}`);
  return v;
}

function toDecimal(value, fieldName = "value") {
  if (value === null || value === undefined || value === "") throw new AppError(400, `${fieldName} is required`);
  try {
    const d = new Decimal(value);
    if (!d.isFinite()) throw new Error("not finite");
    return d;
  } catch (e) {
    throw new AppError(400, `${fieldName} must be a valid decimal value`);
  }
}

function decimalToMoneyString(value, decimals = 2) {
  return toDecimal(value).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed(decimals);
}

function assertMoneyAmount(amount, fieldName = "amount") {
  return decimalToMoneyString(toDecimal(amount, fieldName), 2);
}

function assertDecimalRatio(value, fieldName = "ratio") {
  const d = toDecimal(value, fieldName);
  if (d.lt(0)) throw new AppError(400, `${fieldName} cannot be negative`);
  return d;
}

function isClosedPeriodStatus(status) {
  const s = String(status || "").toLowerCase();
  return ["closed", "locked", "finalized", "finalised", "blocked"].includes(s);
}

function assertUuid(id, fieldName) {
  if (!id) throw new AppError(400, `${fieldName} is required`);
  if (typeof id !== "string") throw new AppError(400, `${fieldName} must be a string`);
  // light check – DB will enforce.
  return id;
}

function resolveOrgId(req) {
  const user = req?.user || {};
  const orgId = user.organization_id || user.organizationId || user.org_id || user.orgId;
  if (!orgId) throw new AppError(401, "Organization context is required");
  return orgId;
}

module.exports = {
  normalizeCode,
  normalizeStatus,
  assertMoneyAmount,
  assertUuid,
  assertName,
  assertCode,
  resolveOrgId,
  toDecimal,
  decimalToMoneyString,
  assertDecimalRatio,
  isClosedPeriodStatus,
  Decimal
};




