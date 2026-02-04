const repo = require("./bankAccounts.repository");
const { AppError } = require("../../../shared/errors/AppError");

async function create(orgId, payload) {
  const req = ["code","name","currencyCode","glAccountId"];
  for (const k of req) if (!payload?.[k]) throw new AppError(400, `${k} is required`);
  return repo.create(orgId, payload);
}
async function list(orgId) { return repo.list(orgId); }

module.exports = { create, list };
