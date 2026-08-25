const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(src, rel), 'utf8');

test('tax workspace exposes one read-only aggregate endpoint ahead of tax.read gate', () => {
  const root = read('core/accounting/tax/tax.routes.js');
  const workspace = read('core/accounting/tax/tax-workspace.routes.js');
  assert.match(root, /router\.use\(workspaceRoutes\)/);
  assert.ok(root.indexOf('router.use(workspaceRoutes)') < root.indexOf('router.use(requirePermission("tax.read"))'));
  assert.match(workspace, /router\.get\(['"]\/workspace['"]/);
  assert.match(workspace, /getWorkspaceSummary/);
});

test('Ghana withholding remittances have a canonical read endpoint backed by statutory rows only', () => {
  const routes = read('core/accounting/tax/tax-withholding.routes.js');
  const service = read('core/accounting/tax/ghanaWithholding.service.js');
  const repo = read('core/accounting/tax/ghanaWithholding.repository.js');
  assert.match(routes, /router\.get\('\/ghana\/withholding\/remittances'/);
  assert.match(routes, /ghWithholdingSvc\.listRemittances/);
  assert.match(service, /async function listRemittances/);
  assert.match(repo, /withholding_regime IN \('income_wht','vat_withholding'\)/);
  assert.match(repo, /SELECT id,organization_id,remittance_no,direction,status/);
});
