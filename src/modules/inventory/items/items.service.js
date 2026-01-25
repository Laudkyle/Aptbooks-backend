const repo = require("./items.repository"); 
const { AppError } = require("../../../shared/errors/AppError"); 

async function createItem(orgId, payload) {
  const req = ["categoryId", "unitId", "sku", "name"]; 
  for (const k of req) if (!payload?.[k]) throw new AppError(400, `${k} is required`); 
  return repo.createItem(orgId, payload); 
}

async function listItems(orgId) { return repo.listItems(orgId);  }

async function getItem(orgId, id) {
  const item = await repo.getItem(orgId, id); 
  if (!item) throw new AppError(404, "Item not found"); 
  return item; 
}

async function updateItem(orgId, id, payload) {
  const updated = await repo.updateItem(orgId, id, payload); 
  if (!updated) throw new AppError(404, "Item not found"); 
  return updated; 
}

async function deleteItem(orgId, id) {
  const out = await repo.deleteItem(orgId, id); 
  if (!out) throw new AppError(404, "Item not found"); 
  return { deleted: true, id }; 
}

module.exports = { createItem, listItems, getItem, updateItem, deleteItem }; 
