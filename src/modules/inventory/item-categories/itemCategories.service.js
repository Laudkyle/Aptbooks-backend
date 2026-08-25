const repo = require("./itemCategories.repository");
const { AppError } = require("../../../shared/errors/AppError");

async function assertAccounts(orgId, payload) {
  const fields = ['inventoryAccountId','cogsAccountId','adjustmentAccountId','clearingAccountId'];
  const ids = fields.map((key) => payload[key]).filter(Boolean);
  const rows = await repo.getAccounts(orgId, ids);
  const map = new Map(rows.map((row) => [String(row.id), row]));
  for (const key of fields) {
    if (!payload[key]) continue;
    const account = map.get(String(payload[key]));
    if (!account) throw new AppError(422, `${key} is not a valid account for this organization`);
    if (account.status !== 'active' || !account.is_postable) throw new AppError(422, `${key} must be an active postable account`);
  }
}
async function assertParent(orgId, parentId, categoryId = null) {
  if (!parentId) return;
  if (String(parentId) === String(categoryId)) throw new AppError(422, 'A category cannot be its own parent');
  if (!await repo.getActiveParent(orgId, parentId)) throw new AppError(422, 'Parent category is invalid or inactive');
}
async function createCategory(orgId, payload) {
  const req = ["code","name","inventoryAccountId","cogsAccountId","adjustmentAccountId","clearingAccountId"];
  for (const key of req) if (!payload?.[key]) throw new AppError(400, `${key} is required`);
  await assertAccounts(orgId, payload);
  await assertParent(orgId, payload.parentId);
  return repo.createCategory(orgId, payload);
}
async function listCategories(orgId) { return repo.listCategories(orgId); }
async function getCategory(orgId, id) {
  const category = await repo.getCategory(orgId, id);
  if (!category) throw new AppError(404, "Category not found");
  return category;
}
async function updateCategory(orgId, id, payload) {
  await assertAccounts(orgId, payload);
  await assertParent(orgId, payload.parentId, id);
  if (payload.status === 'inactive' && await repo.hasActiveItems(orgId, id)) {
    throw new AppError(409, 'Move or deactivate active items before deactivating this category');
  }
  const updated = await repo.updateCategory(orgId, id, payload);
  if (!updated) throw new AppError(404, "Category not found");
  return updated;
}
async function deleteCategory(orgId, id) {
  const category = await getCategory(orgId, id);
  if (await repo.hasItems(orgId, id)) throw new AppError(409, 'Category is in use and cannot be deleted; deactivate it instead');
  const out = await repo.deleteCategory(orgId, id);
  if (!out) throw new AppError(404, "Category not found");
  return { deleted: true, id, category };
}
module.exports = { createCategory, listCategories, getCategory, updateCategory, deleteCategory };
