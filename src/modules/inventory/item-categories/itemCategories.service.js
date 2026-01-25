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

async function getCategory(orgId, id) {
  const c = await repo.getCategory(orgId, id); 
  if (!c) throw new AppError(404, "Category not found"); 
  return c; 
}

async function updateCategory(orgId, id, payload) {
  const updated = await repo.updateCategory(orgId, id, payload); 
  if (!updated) throw new AppError(404, "Category not found"); 
  return updated; 
}

async function deleteCategory(orgId, id) {
  const deleted = await repo.deleteCategory(orgId, id); 
  if (!deleted) throw new AppError(404, "Category not found"); 
  return { deleted: true, id }; 
}

module.exports = { createCategory, listCategories, getCategory, updateCategory, deleteCategory }; 
