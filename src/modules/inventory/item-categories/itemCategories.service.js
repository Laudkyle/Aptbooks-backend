const repo = require("./itemCategories.repository");
const { AppError } = require("../../../shared/errors/AppError");

async function createCategory(orgId, payload) {
  const req = ["code","name","inventoryAccountId","cogsAccountId","adjustmentAccountId","clearingAccountId"];
  for (const k of req) if (!payload?.[k]) throw new AppError(400, `${k} is required`);
  return repo.createCategory(orgId, payload);
}

async function listCategories(orgId) {
  return repo.listCategories(orgId);
}

module.exports = { createCategory, listCategories };
