const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runPhase3MaintainabilityGate } = require('../quality/phase3-maintainability-gate');
const { explicitColumns, tenantPredicate, requireOrganizationId } = require('../shared/db/repositoryStandard');

const SRC = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');

test('Phase 3 maintainability gate is clean', () => {
  assert.deepEqual(runPhase3MaintainabilityGate(), []);
});

test('repository standard requires explicit safe identifiers and tenant context', () => {
  assert.equal(explicitColumns(['id', 'organization_id'], { alias: 'j' }), 'j.id, j.organization_id');
  assert.equal(tenantPredicate({ alias: 'j', parameter: 2 }), 'j.organization_id=$2');
  assert.throws(() => explicitColumns(['id; DROP TABLE x']), /Unsafe SQL column/);
  assert.throws(() => requireOrganizationId(null), /Organization context is required/);
});

test('tax router is a bounded composition root', () => {
  const root = read('core/accounting/tax/tax.routes.js');
  assert.ok(root.split(/\r?\n/).length < 80);
  for (const module of ['tax-setup.routes', 'tax-compliance.routes', 'tax-returns.routes', 'tax-withholding.routes']) {
    assert.match(root, new RegExp(`require\\(\\"\\./${module.replace('.', '\\.')}`));
  }
});

test('strict type contracts exist for accounting IDs, money and posting commands', () => {
  const accounting = read('types/accounting.d.ts');
  const brands = read('types/brands.d.ts');
  const config = JSON.parse(read('tsconfig.phase3.json'));
  assert.match(brands, /type OrganizationId = Brand/);
  assert.match(accounting, /interface PostJournalCommand/);
  assert.match(accounting, /type DecimalString/);
  assert.equal(config.compilerOptions.strict, true);
  assert.equal(config.compilerOptions.noEmit, true);
});
