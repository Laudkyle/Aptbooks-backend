const { AsyncLocalStorage } = require('async_hooks');

const tenantStorage = new AsyncLocalStorage();

function normalizeTenantId(value) {
  if (value === undefined || value === null || value === '') return null;
  const tenantId = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new Error('Tenant organization id must be a valid UUID');
  }
  return tenantId;
}

function runWithTenant(organizationId, fn) {
  const tenantId = normalizeTenantId(organizationId);
  if (!tenantId) throw new Error('A tenant organization id is required');
  return tenantStorage.run({ organizationId: tenantId }, fn);
}

function getTenantId() {
  return tenantStorage.getStore()?.organizationId || null;
}

function bindTenant(organizationId) {
  const tenantId = normalizeTenantId(organizationId);
  if (!tenantId) throw new Error('A tenant organization id is required');
  tenantStorage.enterWith({ organizationId: tenantId });
}

module.exports = { runWithTenant, getTenantId, bindTenant, normalizeTenantId };
