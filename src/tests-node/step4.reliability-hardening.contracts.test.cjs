const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('idempotency uses reclaimable owner leases and durable response finalization', () => {
  const src = read('middleware/idempotency.middleware.js');
  const migration = read('db/migrations/sql/156_step4_reliability_hardening.sql');
  assert.match(src, /FOR UPDATE/);
  assert.match(src, /lease_expires_at/);
  assert.match(src, /owner_token/);
  assert.match(src, /req\.originalUrl/);
  assert.match(src, /stableStringify\(req\.query \|\| \{\}\)/);
  assert.match(src, /const heartbeat = setInterval/);
  assert.match(src, /lease_expires_at=NOW\(\) \+ \(\$6::text \|\| ' seconds'\)::interval/);
  assert.match(src, /clearInterval\(heartbeat\)/);
  assert.match(src, /attempt_count=COALESCE\(attempt_count,0\)\+1/);
  assert.match(src, /row\.status === "IN_PROGRESS"/);
  assert.match(src, /statusCode >= 500 \? "FAILED" : "COMPLETED"/);
  assert.match(src, /Could not durably finalize idempotent request/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS owner_token UUID/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ/);
  assert.match(migration, /ix_api_idempotency_reclaim/);
});

test('access tokens are short lived, versioned, and checked against live membership', () => {
  const env = read('config/env.js');
  const tokens = read('core/foundation/users/tokens.service.js');
  const auth = read('middleware/auth.middleware.js');
  const authRoutes = read('core/foundation/users/auth.routes.js');
  const userRoutes = read('core/foundation/users/users.routes.js');
  assert.match(env, /JWT_EXPIRES_IN:\s*process\.env\.JWT_EXPIRES_IN \|\| "15m"/);
  assert.match(tokens, /ver: Number\(authVersion \|\| 1\)/);
  assert.match(tokens, /function signRefreshToken\(\{ userId, organizationId, email, familyId, authVersion = 1 \}\)/);
  assert.match(tokens, /Number\(payload\.ver \|\| 1\) !== Number\(user\.auth_version\)/);
  assert.match(tokens, /session_version_revoked/);
  assert.match(auth, /JOIN user_organizations/);
  assert.match(auth, /u\.auth_version/);
  assert.match(auth, /Number\(user\.auth_version\) !== Number\(payload\.ver\)/);
  assert.match(auth, /organization_id: rec\.organization_id, typ: "api_key"/);
  assert.doesNotMatch(auth, /WHERE u\.id=\$1 AND u\.organization_id=\$2 AND COALESCE\(u\.is_system/);
  assert.match(authRoutes, /auth_version=auth_version\+1/);
  assert.match(authRoutes, /action: "auth\.reset_password"[\s\S]*client,[\s\S]*COMMIT/);
  assert.match(authRoutes, /active persisted session before authorizing logout-all/);
  assert.match(authRoutes, /action: "auth\.logout_all"[\s\S]*client,[\s\S]*COMMIT/);
  assert.doesNotMatch(authRoutes, /organizationId: null[\s\S]*auth\.login/);
  assert.match(userRoutes, /auth_version\s*=\s*auth_version \+ CASE/);
  assert.match(userRoutes, /status='disabled', auth_version=auth_version\+1/);
});

test('scheduler uses one run row, shared locking, guaranteed unlock, and registry reconciliation', () => {
  const execution = read('utilities/scheduled-tasks/schedulerExecution.service.js');
  const scheduler = read('utilities/scheduled-tasks/scheduler.js');
  const manual = read('modules/automation/accounting-jobs/accountingJobs.service.js');
  const migration = read('db/migrations/sql/156_step4_reliability_hardening.sql');
  assert.equal((execution.match(/INSERT INTO scheduled_task_runs/g) || []).length, 1);
  assert.match(execution, /UPDATE scheduled_task_runs[\s\S]*WHERE id=\$1 AND status='running'/);
  assert.match(execution, /pg_try_advisory_lock/);
  assert.match(execution, /finally[\s\S]*pg_advisory_unlock/);
  assert.match(execution, /status === "failed" && triggerType === "scheduled"/);
  assert.match(execution, /failed operator-triggered run must not consume the scheduler's retry/);
  assert.match(manual, /executeTask\(/);
  assert.match(scheduler, /ON CONFLICT \(code\) DO UPDATE SET/);
  assert.match(scheduler, /IS DISTINCT FROM EXCLUDED\.schedule_type/);
  assert.match(migration, /trigger_type TEXT NOT NULL DEFAULT 'scheduled'/);
});

test('journal HTTP creation binds the header key to transaction-level journal idempotency', () => {
  const routes = read('core/accounting/journal/journal.routes.js');
  const svc = read('core/accounting/journal/journal.service.js');
  assert.match(routes, /router\.post\("\/", idempotency\(\{ required: true \}\)/);
  assert.match(routes, /payload\.idempotencyKey = req\.idempotency\.key/);
  assert.match(routes, /Body idempotencyKey must match Idempotency-Key header/);
  assert.match(svc, /ON CONFLICT \(organization_id, idempotency_key\)/);
  assert.match(svc, /action: "journal\.created"[\s\S]*client/);
  assert.match(svc, /action: "journal\.posted"[\s\S]*client/);
  assert.match(svc, /action: "journal\.voided"[\s\S]*client/);
});

test('cash settlement and invoice/bill financial transitions audit inside the same transaction', () => {
  const receipt = read('modules/transactions/receipts/customer-receipts/customerReceipts.service.js');
  const receiptRoutes = read('modules/transactions/receipts/customer-receipts/customerReceipts.routes.js');
  const payment = read('modules/transactions/payments/vendor-payments/vendorPayments.service.js');
  const invoice = read('modules/transactions/invoices/invoices.service.js');
  const bill = read('modules/transactions/bills/bills.service.js');

  assert.match(receipt, /postCustomerReceipt[\s\S]*withTransaction/);
  assert.match(receipt, /settlementCents \+= settlementCurrent/);
  assert.doesNotMatch(receipt, /parseDecimalToBigInt\(settlement,/);
  assert.match(receipt, /action: "customer_receipt\.posted"[\s\S]*client/);
  assert.match(receipt, /action: "customer_receipt\.voided"[\s\S]*client/);
  assert.match(receiptRoutes, /router\.post\("\/:id\/post", idempotency\(\{ required: true \}\)/);
  assert.match(receiptRoutes, /router\.post\("\/:id\/void", idempotency\(\{ required: true \}\)/);

  assert.match(payment, /getPaymentSettings\(\{ orgId, client \}\)/);
  assert.match(payment, /action: "vendor_payment\.posted"[\s\S]*client/);
  assert.match(payment, /action: "vendor_payment\.voided"[\s\S]*client/);
  assert.match(invoice, /action: "invoice\.issued"[\s\S]*client/);
  assert.match(invoice, /action: "invoice\.voided"[\s\S]*client/);
  assert.match(bill, /async function voidBill/);
  assert.match(bill, /action: "bill\.issued"[\s\S]*client/);
  assert.match(bill, /action: "bill\.voided"[\s\S]*client/);
});

test('IFRS9 critical controls no longer silently discard audit failures', () => {
  const src = read('compliance/ifrs9/ifrs9.service.js');
  assert.doesNotMatch(src, /IFRS9 audit write failed/);
  assert.match(src, /return writeAudit\(payload\)/);
  assert.match(src, /action: "ifrs9\.run\.finalize"[\s\S]*client/);
  assert.match(src, /action: "ifrs9\.run\.reverse"[\s\S]*client/);
  assert.match(src, /reversePostedJournal\([\s\S]*idempotencyKey,[\s\S]*client/);
  assert.match(src, /ifrs9\.model_change\.approve[\s\S]*after: rows\[0\], client[\s\S]*COMMIT/);
});

test('shared operational docs and credit/debit note effects are idempotent, reversible, and atomically audited', () => {
  const ops = read('modules/transactions/_shared/opsDocs.service.js');
  const opsRoutes = read('modules/transactions/_shared/opsDocs.routes.js');
  const migration = read('db/migrations/sql/156_step4_reliability_hardening.sql');
  const credit = read('modules/transactions/credit-notes/creditNotes.service.js');
  const creditRoutes = read('modules/transactions/credit-notes/creditNotes.routes.js');
  const debit = read('modules/transactions/debit-notes/debitNotes.service.js');
  const debitRoutes = read('modules/transactions/debit-notes/debitNotes.routes.js');

  assert.match(ops, /async function voidDocument[\s\S]*BEGIN[\s\S]*getLockedDocument/);
  assert.match(ops, /voidPostedJournal\([\s\S]*client/);
  assert.match(ops, /action: `\$\{entityType\}\.voided`[\s\S]*client/);
  assert.match(ops, /action: `\$\{entityType\}\.\$\{finalAction\}ed`[\s\S]*client/);
  assert.doesNotMatch(ops, /return repo\.voidDocument/);
  assert.doesNotMatch(opsRoutes, /action: `\$\{entityType\}\.voided`/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS reversal_journal_entry_id UUID REFERENCES journal_entries/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS void_reason TEXT/);

  assert.match(credit, /action: "credit_note\.issued"[\s\S]*client/);
  assert.match(credit, /action: "credit_note\.applied"[\s\S]*client/);
  assert.match(credit, /action: "credit_note\.voided"[\s\S]*client/);
  assert.match(credit, /reversalJournalEntryId: rev\.reversalJournalId/);
  assert.match(creditRoutes, /router\.post\("\/", idempotency\(\{ required: true \}\)/);
  assert.match(creditRoutes, /router\.post\("\/:id\/issue", idempotency\(\{ required: true \}\)/);
  assert.match(creditRoutes, /router\.post\("\/:id\/apply", idempotency\(\{ required: true \}\)/);
  assert.match(creditRoutes, /router\.post\("\/:id\/void", idempotency\(\{ required: true \}\)/);

  assert.match(debit, /action: "debit_note\.issued"[\s\S]*client/);
  assert.match(debit, /action: "debit_note\.applied"[\s\S]*client/);
  assert.match(debit, /action: "debit_note\.voided"[\s\S]*client/);
  assert.match(debit, /reversalJournalEntryId: rev\.reversalJournalId/);
  assert.match(debitRoutes, /router\.post\("\/", idempotency\(\{ required: true \}\)/);
  assert.match(debitRoutes, /router\.post\("\/:id\/issue", idempotency\(\{ required: true \}\)/);
  assert.match(debitRoutes, /router\.post\("\/:id\/apply", idempotency\(\{ required: true \}\)/);
  assert.match(debitRoutes, /router\.post\("\/:id\/void", idempotency\(\{ required: true \}\)/);
});


test('IFRS and high-risk accounting mutation surfaces uniformly require idempotency', () => {
  const standards = [
    'compliance/ifrs9/ifrs9.routes.js',
    'compliance/ifrs15/ifrs15.routes.js',
    'compliance/ifrs16/ifrs16.routes.js',
    'compliance/ias12/ias12.routes.js',
    'core/accounting/imports/imports.routes.js',
    'core/accounting/ledger/reconciliation.routes.js',
    'core/accounting/accruals/accruals.routes.js',
    'core/accounting/periods/periods.routes.js',
  ];
  for (const file of standards) {
    const src = read(file);
    assert.match(src, /const requireMutationIdempotency = idempotency\(\{ required: true \}\)/, file);
    assert.match(src, /\["POST", "PUT", "PATCH", "DELETE"\]\.includes\(req\.method\)/, file);
  }

  const journalRoutes = read('core/accounting/journal/journal.routes.js');
  assert.match(journalRoutes, /router\.patch\("\/:id", idempotency\(\{ required: true \}\)/);
  assert.match(journalRoutes, /router\.put\("\/:id\/lines", idempotency\(\{ required: true \}\)/);
  assert.match(journalRoutes, /router\.delete\("\/:id\/lines\/:lineNo", idempotency\(\{ required: true \}\)/);
});
