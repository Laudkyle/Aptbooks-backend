const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
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
  test(`approval visibility uses current workflow assignment: ${rel}`, () => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(src, /workflow_state_code\)\s*=\s*'submitted'/i);
    assert.match(src, /FROM document_approvals da/);
    assert.match(src, /da\.status = 'PENDING'/);
    assert.match(src, /FROM approval_level_users alu_me/);
    assert.match(src, /alu_me\.user_id = \$3::uuid/);
    assert.match(src, /allow_self_approval/);
    assert.doesNotMatch(src, /WHEN d\.created_by_user_id = \$3\s*\n\s*THEN COALESCE\(dws\.creator_can_approve/i);
  });
}
