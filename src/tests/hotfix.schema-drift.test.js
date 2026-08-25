const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('inventory item updated_at mutations are backed by the production-hardening migration', () => {
  const source = read('modules/inventory/items/items.repository.js');
  const migration = read('db/migrations/sql/164_assets_inventory_production_hardening.sql');
  assert.match(migration, /ALTER TABLE inventory_items[\s\S]*updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(source, /updated_at=NOW\(\)/);
  assert.match(source, /tax_profile_id=CASE WHEN \$13::boolean THEN \$14::uuid ELSE tax_profile_id END/);
});

test('printing preset bootstrap is race-safe on organization/template code', () => {
  const repo = read('modules/printing/document-templates/documentTemplates.repository.js');
  const service = read('modules/printing/document-templates/documentTemplates.service.js');
  assert.match(repo, /ON CONFLICT \(organization_id, code\) DO NOTHING/);
  assert.match(repo, /async function createTemplateIfMissing/);
  assert.match(service, /repo\.createTemplateIfMissing/);
});

test('system settings route does not log organization ids through the removed debug statement', () => {
  const source = read('core/foundation/system-settings/system-settings.routes.js');
  assert.doesNotMatch(source, /This -- is the orgId for listing settings/);
});
