const repo = require("./warehouses.repository1");
const { AppError } = require("../../../shared/errors/AppError");

async function createWarehouse(orgId, payload) {
  if (!payload?.code || !payload?.name) throw new AppError(400, "code and name are required");
  return repo.createWarehouse(orgId, payload);
}
async function listWarehouses(orgId) { return repo.listWarehouses(orgId); }
async function getWarehouse(orgId, warehouseId) {
  const found = await repo.getWarehouse(orgId, warehouseId);
  if (!found) throw new AppError(404, 'Warehouse not found');
  return found;
}
async function updateWarehouse(orgId, warehouseId, payload) {
  const updated = await repo.updateWarehouse(orgId, warehouseId, payload);
  if (!updated) throw new AppError(404, 'Warehouse not found');
  return updated;
}

module.exports = { createWarehouse, listWarehouses, getWarehouse, updateWarehouse };
