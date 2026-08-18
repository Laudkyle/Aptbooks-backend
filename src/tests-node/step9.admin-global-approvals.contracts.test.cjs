const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const detailFiles = [
  'modules/transactions/invoices/invoices.service.js',
  'modules/transactions/bills/bills.repository.js',
  'modules/transactions/receipts/customer-receipts/customerReceipts.repository.js',
  'modules/transactions/payments/vendor-payments/vendorPayments.repository.js',
  'modules/transactions/credit-notes/creditNotes.repository.js',
  'modules/transactions/debit-notes/debitNotes.repository.js',
  'modules/transactions/_shared/opsDocs.repository.js',
];

test('default approval ladder is global and defaults to organization Admin', () => {
  const migration = read('db/migrations/sql/158_step9_global_admin_approval_defaults.sql');
  const onboarding = read('core/foundation/system-settings/system-settings.routes.js');
  const orgs = read('core/foundation/organizations/organizations.service.js');
  assert.match(migration, /document_global_approval_levels/);
  assert.match(migration, /DEFAULT_APPROVE/);
  assert.match(migration, /approval_level_users/);
  assert.match(migration, /LOWER\(r\.name\) IN \('admin','administrator','super admin','owner'\)/);
  assert.match(onboarding, /Default Approver/);
  assert.match(onboarding, /document_global_approval_levels/);
  assert.match(onboarding, /approval_level_users/);
  assert.match(orgs, /Approval workflow defaults/);
  assert.match(orgs, /document_global_approval_levels/);
});

test('document-specific approval ladders remain overrides over the global fallback', () => {
  const repo = read('workflow/documents/documents.repository.js');
  assert.match(repo, /if \(r\.rows\.length \|\| !includeGlobalFallback\) return r\.rows;/);
  assert.match(repo, /return listGlobalApprovalLadder\(\{ orgId, client \}\);/);
  assert.match(repo, /\[documentId, level\.id, i \+ 1, status\]/);
});

test('organization Admin can act on approvals without manual per-level assignment', () => {
  const rules = read('workflow/documents/documentWorkflowRules.service.js');
  const service = read('workflow/documents/documents.service.js');
  const inbox = read('workflow/approvals/approvals.repository.js');
  assert.match(rules, /async function isOrganizationAdmin/);
  assert.match(service, /if \(!actorIsAdmin && !isAssigned\)/);
  assert.match(inbox, /LOWER\(r_admin\.name\) IN \('admin','administrator','super admin','owner'\)/);
});

test('operational transaction detail can_approve treats Admin as an approval actor by default', () => {
  for (const rel of detailFiles) {
    const src = read(rel);
    assert.match(src, /ur_admin/);
    assert.match(src, /LOWER\(r_admin\.name\) IN \('admin','administrator','super admin','owner'\)/);
    assert.match(src, /ur_admin2/);
  }
});

test('submitted documents missing approval rows are repaired against explicit-or-global ladder', () => {
  const migration = read('db/migrations/sql/158_step9_global_admin_approval_defaults.sql');
  assert.match(migration, /submitted_without_steps/);
  assert.match(migration, /explicit_ladder/);
  assert.match(migration, /global_ladder/);
  assert.match(migration, /INSERT INTO document_approvals/);
  assert.match(migration, /CASE WHEN step_no=1 THEN 'PENDING' ELSE 'QUEUED' END/);
  assert.match(migration, /INSERT INTO notifications/);
});
