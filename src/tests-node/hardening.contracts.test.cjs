const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('public organization router has no unauthenticated POST root provisioner', () => {
  const source = read('core/foundation/organizations/organizations.routes.js');
  assert.doesNotMatch(source, /router\.post\(\s*["']\/["']/);
});

test('refresh cookie is scoped across auth endpoints and registration/login set it', () => {
  const source = read('core/foundation/users/auth.routes.js');
  assert.match(source, /path:\s*["']\/auth["']/);
  const calls = (source.match(/setRefreshCookie\(res,/g) || []).length;
  assert.ok(calls >= 3, `expected registration/login/refresh cookie writes, found ${calls}`);
});

test('outbox enqueue supports caller transaction and journal posting passes its client', () => {
  const webhooks = read('modules/webhooks/webhooks.service.js');
  const journal = read('core/accounting/journal/journal.service.js');
  assert.match(webhooks, /async function enqueueEvent\(\{ orgId, eventType, payload, client = null \}\)/);
  assert.match(journal, /enqueueEvent\(\{\s*client,/s);
});

test('webhook dispatcher uses durable processing claim fields', () => {
  const source = read('modules/webhooks/webhooks.service.js');
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /status='processing'/);
  assert.match(source, /claim_token/);
  assert.match(source, /claimed_at/);
});

test('MTN callback verifies provider status rather than trusting callback payload', () => {
  const source = read('modules/integrations/payments/payments.routes.js');
  assert.match(source, /getRequestToPayStatus\(\{ referenceId \}\)/);
});

test('financial statements and balances read canonical journal-derived totals', () => {
  const balances = read('core/accounting/ledger/balances.service.js');
  const statements = read('reporting/financial-statements/financialStatements.service.js');
  assert.match(balances, /accounting_posted_ledger_totals/);
  assert.match(statements, /accounting_posted_ledger_totals/);
});

test('canonical ledger view includes posted and voided originals', () => {
  const migration = read('db/migrations/sql/144_step2_ledger_source_of_truth.sql');
  assert.match(migration, /WHERE je\.status IN \('posted', 'voided'\)/);
  assert.match(migration, /general_ledger_balances[\s\S]*rebuildable/i);
});

test('journal create uses conflict-safe idempotent insert', () => {
  const source = read('core/accounting/journal/journal.service.js');
  assert.match(source, /ON CONFLICT \(organization_id, idempotency_key\)[\s\S]*DO NOTHING/);
  assert.match(source, /idempotent: true/);
});
