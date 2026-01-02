const repo = require("./items.repository");
const { AppError } = require("../../../shared/errors/AppError");

async function createItem(orgId, payload) {
  const req = ["categoryId","unitId","sku","name"];
  for (const k of req) if (!payload?.[k]) throw new AppError(400, `${k} is required`);
  return repo.createItem(orgId, payload);
}
async function listItems(orgId) { return repo.listItems(orgId); }

module.exports = { createItem, listItems };
