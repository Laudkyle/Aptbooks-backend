const { AppError } = require("../shared/errors/AppError"); 

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

function assertMoneyAmount(amount, fieldName = "amount") {
  if (amount === null || amount === undefined) throw new AppError(400, `${fieldName} is required`); 
  const n = Number(amount); 
  if (!Number.isFinite(n)) throw new AppError(400, `${fieldName} must be a finite number`); 
  // Keep it permissive: some amounts may be negative (e.g., forecast reductions).
  return n; 
}

function assertUuid(id, fieldName) {
  if (!id) throw new AppError(400, `${fieldName} is required`); 
  if (typeof id !== "string") throw new AppError(400, `${fieldName} must be a string`); 
  // light check – DB will enforce.
  return id; 
}

module.exports = {
  normalizeCode,
  normalizeStatus,
  assertMoneyAmount,
  assertUuid,
  assertName,
  assertCode
}; 
