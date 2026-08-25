const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('asset depreciation hardening preserves component basis and auditable calculation evidence', () => {
  const migration = read('db/migrations/sql/164_assets_inventory_production_hardening.sql');
  const service = read('modules/assets/depreciation/depreciation.service.js');
  const repo = read('modules/assets/depreciation/depreciation.repository.js');

  assert.match(migration, /basis_amount NUMERIC\(18,2\)/);
  assert.match(migration, /residual_value NUMERIC\(18,2\)/);
  assert.match(migration, /manual basis allocation/);
  assert.match(service, /pg_advisory_xact_lock/);
  assert.match(service, /Component schedules require an explicit basisAmount/);
  assert.match(service, /alreadyAllocated \+ basisUnits > book\.grossBookUnits/);
  assert.match(repo, /componentKey/);
  assert.match(repo, /active depreciation schedule already overlaps this component/i);
  assert.match(repo, /calculation_json/);
});

test('asset lifecycle accounting and carrying value remain transaction and decimal safe', () => {
  const service = read('modules/assets/fixed-assets/fixedAssets.service.js');
  const repo = read('modules/assets/fixed-assets/fixedAssets.repository.js');

  assert.match(service, /client/);
  assert.match(service, /postSourceJournal/);
  assert.match(repo, /gross_cost \+ r\.revaluation_total - d\.accumulated_depreciation - a\.impairment_total/);
  assert.doesNotMatch(repo, /const gross = Number\(/);
  assert.doesNotMatch(repo, /const accumulated = Number\(/);
});

test('stock count posting is atomic, serialized and idempotently recoverable', () => {
  const stockCount = read('modules/inventory/stock-counts/stockCounts.service.js');
  const transaction = read('modules/inventory/transactions/transactions.service.js');

  assert.match(stockCount, /FOR UPDATE OF sc/);
  assert.match(stockCount, /if \(sc\.status === "posted"\)/);
  assert.match(stockCount, /idempotencyKey: `stock-count:/);
  assert.match(stockCount, /createDraftTransaction\(\{[\s\S]*client,/);
  assert.match(stockCount, /postApprovedTransaction\(\{[\s\S]*client/);
  assert.match(transaction, /withDbTransaction\(existingClient/);
  assert.match(transaction, /client: existingClient = null/);
});

test('inventory master and valuation controls are explicit', () => {
  const migration = read('db/migrations/sql/164_assets_inventory_production_hardening.sql');
  const transaction = read('modules/inventory/transactions/transactions.service.js');
  const overview = read('modules/inventory/overview/inventoryOverview.service.js');

  assert.match(migration, /tracking_method IN \('none','batch','serial'\)/);
  assert.match(migration, /inventory_balances_qty_nonnegative_chk/);
  assert.match(migration, /inventory_balances_avg_cost_nonnegative_chk/);
  assert.match(transaction, /Warehouse .* invalid or inactive/);
  assert.match(transaction, /Item .* invalid, inactive, or uses inactive master data/);
  assert.match(overview, /negative_balances/);
  assert.match(overview, /posted_without_journal/);
  assert.match(overview, /reorderAttention/);
});
