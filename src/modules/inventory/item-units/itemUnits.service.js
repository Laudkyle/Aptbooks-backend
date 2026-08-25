const repo = require("./itemUnits.repository");
const { AppError } = require("../../../shared/errors/AppError");

async function createUnit(orgId, payload) {
  if (!payload?.code || !payload?.name) throw new AppError(400, "code and name are required");
  return repo.createUnit(orgId, payload);
}
async function listUnits(orgId, query = {}) { return repo.listUnits(orgId, { activeOnly: query.activeOnly === 'true' }); }
module.exports = { createUnit, listUnits };
