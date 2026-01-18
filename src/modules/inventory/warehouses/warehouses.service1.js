const repo = require("./warehouses.repository1");
const { AppError } = require("../../../shared/errors/AppError");

async function createWarehouse(orgId, payload) {
  if (!payload?.code || !payload?.name) throw new AppError(400, "code and name are required");
  return repo.createWarehouse(orgId, payload);
}
async function listWarehouses(orgId) { return repo.listWarehouses(orgId); }

module.exports = { createWarehouse, listWarehouses };
