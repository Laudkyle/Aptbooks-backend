const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('registration currency reference is public and supported currencies are seeded for upgrades', () => {
  const routes = read('core/foundation/reference/reference.routes.js');
  const migration = read('db/migrations/sql/167_currency_and_post161_rls_hardening.sql');
  assert.match(routes, /router\.get\(["']\/currencies["']/);
  assert.doesNotMatch(routes, /authRequired|requirePermission/);
  for (const code of ['GHS', 'USD', 'EUR', 'GBP']) assert.match(migration, new RegExp(`'${code}'`));
});

test('post-161 tenant tables are re-hardened with forced row-level security', () => {
  const migration = read('db/migrations/sql/167_currency_and_post161_rls_hardening.sql');
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /organization_id/);
});

test('commerce generic provider webhook fails closed and supported callbacks use integrations endpoints', () => {
  const routes = read('modules/commerce/commerce.routes.js');
  const service = read('modules/commerce/commerce.service.js');
  const webhookPos = routes.indexOf("router.post('/payments/webhooks/:provider'");
  const authPos = routes.indexOf('router.use(authRequired)');
  assert.ok(webhookPos >= 0 && authPos > webhookPos);
  assert.match(routes, /\/modules\/integrations\/payments\/webhooks\/\$\{supported\}/);
  assert.doesNotMatch(service, /recordPaymentWebhook/);
});

test('offline POS sync replays sales with stable per-sale idempotency and records outcomes', () => {
  const service = read('modules/commerce/commerce.service.js');
  assert.match(service, /OFFLINE:\$\{payload\.batchNo\}/);
  assert.match(service, /await createSale\(/);
  assert.match(service, /processedCount/);
  assert.match(service, /duplicateCount/);
  assert.match(service, /failedCount/);
});

test('public payment callback intent access re-enters tenant context for RLS-safe reads and writes', () => {
  const repo = read('modules/integrations/payments/payments.repository.js');
  assert.match(repo, /async function findIntentAcrossTenants/);
  assert.match(repo, /runWithTenant\(organization\.id/);
  assert.match(repo, /async function updateIntentStatus[\s\S]*?runWithTenant\(orgId/);
  assert.match(repo, /async function attachPostedReceipt[\s\S]*?runWithTenant\(orgId/);
});

test('financial statements use Decimal arithmetic and a restricted formula parser', () => {
  const service = read('reporting/financial-statements/financialStatements.service.js');
  assert.match(service, /require\(["']decimal\.js["']\)/);
  assert.match(service, /function safeEvalFormula/);
  assert.doesNotMatch(service, /new Function\s*\(|\bFunction\s*\(/);
  assert.doesNotMatch(service, /\bNumber\s*\(/);
  assert.match(service, /base_currency_code/);
});
