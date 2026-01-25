const repo = require("./itemUnits.repository"); 
const { AppError } = require("../../../shared/errors/AppError"); 

async function createUnit(orgId, payload) {
  if (!payload?.code || !payload?.name) throw new AppError(400, "code and name are required"); 
  return repo.createUnit(orgId, { code: payload.code, name: payload.name }); 
}

async function listUnits(orgId) {
  return repo.listUnits(orgId); 
}

module.exports = { createUnit, listUnits }; 
