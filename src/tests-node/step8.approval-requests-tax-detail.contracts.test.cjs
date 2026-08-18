const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('document submission creates targeted approval requests for eligible current-level approvers', () => {
  const repo = read('workflow/documents/documents.repository.js');
  const svc = read('workflow/documents/documents.service.js');
  assert.match(repo, /INSERT INTO notifications/);
  assert.match(repo, /p\.code = 'approvals\.act'/);
  assert.match(repo, /approval_level_users alu_me/);
  assert.match(repo, /alu_me\.user_id = u\.id/);
  assert.match(svc, /createCurrentApprovalNotifications/);
  assert.match(svc, /Current approval level has no eligible approvers/);
  assert.match(svc, /Next approval level has no eligible approvers/);
});

test('approval inbox is scoped to the signed-in assigned approver', () => {
  const route = read('workflow/approvals/approvals.routes.js');
  const repo = read('workflow/approvals/approvals.repository.js');
  assert.match(route, /svc\.inbox\(req\.user\.organization_id, req\.user\.id, req\.query\)/);
  assert.match(repo, /alu_me\.user_id = \$2/);
  assert.match(repo, /da\.status='PENDING'/);
});

test('can_approve requires both current-level assignment and approvals.act permission', () => {
  const files = [
    'modules/transactions/invoices/invoices.service.js',
    'modules/transactions/bills/bills.repository.js',
    'modules/transactions/receipts/customer-receipts/customerReceipts.repository.js',
    'modules/transactions/payments/vendor-payments/vendorPayments.repository.js',
    'modules/transactions/credit-notes/creditNotes.repository.js',
    'modules/transactions/debit-notes/debitNotes.repository.js',
    'modules/transactions/_shared/opsDocs.repository.js',
  ];
  for (const rel of files) {
    const src = read(rel);
    assert.match(src, /p\.code = 'approvals\.act'/, rel);
    assert.match(src, /approval_level_users alu_me/, rel);
  }
});

test('multi-level operational workflows stay submitted until the final approval', () => {
  const ops = read('modules/transactions/_shared/opsDocs.service.js');
  const receipts = read('modules/transactions/receipts/customer-receipts/customerReceipts.service.js');
  const payments = read('modules/transactions/payments/vendor-payments/vendorPayments.service.js');
  assert.match(ops, /setStatus\(client, orgId, documentId, "submitted", actorUserId\)/);
  assert.match(ops, /isFinalApproval = !workflowDocument\?\.next/);
  assert.match(ops, /isFinalApproval \? "approved" : "submitted"/);
  assert.match(ops, /runPostingHookOnApproval && isFinalApproval/);
  assert.match(receipts, /if \(approved\?\.next\)[\s\S]*status='submitted'/);
  assert.match(payments, /if \(approved\?\.next\)[\s\S]*status='submitted'/);
});

test('detail enrichment computes gross from taxable base plus non-withholding tax', () => {
  const src = read('modules/transactions/_shared/detailEnrichment.js');
  assert.match(src, /const taxableAmount = Math\.max\(0, enteredLineTotal - inclusiveTaxAmount\)/);
  assert.match(src, /const nonWithholdingTax = line\.tax_amount \?\? 0/);
  assert.match(src, /line_gross_total: grossAmount/);
  assert.match(src, /entered_line_total/);
  assert.match(src, /calculation_method/);
  assert.match(src, /pricing_mode: pricingMode/);
  assert.doesNotMatch(src, /line_gross_total:\s*round2\(Number\(line\.line_total/);
});

test('approval actors can read their assigned inbox and existing pending requests are backfilled', () => {
  const permissions = read('middleware/permission.middleware.js');
  const route = read('workflow/approvals/approvals.routes.js');
  const migration = read('db/migrations/sql/157_step8_approval_request_tax_detail_hardening.sql');
  assert.match(permissions, /function requireAnyPermission/);
  assert.match(permissions, /p\.code = ANY\(\$3::text\[\]\)/);
  assert.match(route, /requireAnyPermission\(\["approvals\.inbox\.read", "approvals\.act"\]\)/);
  assert.match(migration, /INSERT INTO notifications/);
  assert.match(migration, /da\.status = 'PENDING'/);
  assert.match(migration, /d\.workflow_state_code = 'SUBMITTED'/);
  assert.match(migration, /perm\.code = 'approvals\.act'/);
});

test('credit and debit notes persist canonical taxable_amount for inclusive-tax detail rendering', () => {
  const credit = read('modules/transactions/credit-notes/creditNotes.repository.js');
  const debit = read('modules/transactions/debit-notes/debitNotes.repository.js');
  const migration = read('db/migrations/sql/157_step8_approval_request_tax_detail_hardening.sql');
  assert.match(credit, /tax_amount, taxable_amount/);
  assert.match(credit, /l\.taxableAmount \?\? l\.lineTotal \?\? 0/);
  assert.match(debit, /tax_amount, taxable_amount/);
  assert.match(debit, /l\.taxableAmount \?\? l\.lineTotal \?\? 0/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS taxable_amount NUMERIC\(18,2\)/);
  assert.match(migration, /calculation_method[\s\S]*inclusive/);
});

test('detail enrichment can infer historical inclusive and mixed taxable bases without double adding tax', () => {
  const src = read('modules/transactions/_shared/detailEnrichment.js');
  assert.match(src, /inclusiveTaxAmount/);
  assert.match(src, /resolveComponentMethod/);
  assert.match(src, /enteredLineTotal - inclusiveTaxAmount/);
  assert.match(src, /const taxableAmount = Math\.max\(0, enteredLineTotal - inclusiveTaxAmount\)/);
  assert.match(src, /line_gross_total: grossAmount/);
});
