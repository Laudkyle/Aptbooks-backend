const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('AR/AP open item views exclude voided source documents', () => {
  const migration = read('src/db/migrations/sql/159_step14_voided_source_reporting_hardening.sql');
  assert.match(migration, /CREATE OR REPLACE VIEW reporting_ar_open_items/);
  assert.match(migration, /FROM invoices i[\s\S]*?WHERE i\.status IN \('issued','paid'\)/);
  assert.match(migration, /CREATE OR REPLACE VIEW reporting_ap_open_items/);
  assert.match(migration, /FROM bills b[\s\S]*?WHERE b\.status IN \('issued','paid'\)/);
  assert.match(migration, /WHVAT settlement semantics/);
});

test('live tax reporting excludes voided sources while reconciliation nets original plus reversal journals', () => {
  const taxReport = read('src/reporting/tax/tax.service.js');
  const ghanaVat = read('src/core/accounting/tax/ghanaVat.service.js');
  assert.match(taxReport, /source_type='invoice'[\s\S]*?status IN \('issued','paid'\)/);
  assert.match(taxReport, /source_type='bill'[\s\S]*?status IN \('issued','paid'\)/);
  assert.match(taxReport, /source_type='credit_note'[\s\S]*?status='issued'/);
  assert.match(taxReport, /je\.status IN \('posted','voided'\)/);
  assert.match(ghanaVat, /REPORTABLE_SOURCE_SQL/);
  assert.match(ghanaVat, /source_type='invoice'[\s\S]*?status IN \('issued','paid'\)/);
  assert.match(ghanaVat, /source_type IN \('expense','petty_cash','return'\)[\s\S]*?status='posted'/);
});

test('voiding is blocked once source tax is in submitted or finalized filing history', () => {
  const guard = read('src/shared/tax/taxVoidCompliance.js');
  assert.match(guard, /tax_ledger_entries/);
  assert.match(guard, /status IN \('queued','submitted','accepted','finalized'\)/);
  assert.match(guard, /statutory adjustment\/credit\/debit-note or return-amendment workflow/);

  for (const file of [
    'src/modules/transactions/invoices/invoices.service.js',
    'src/modules/transactions/bills/bills.service.js',
    'src/modules/transactions/credit-notes/creditNotes.service.js',
    'src/modules/transactions/debit-notes/debitNotes.service.js',
    'src/modules/transactions/_shared/opsDocs.service.js',
  ]) {
    assert.match(read(file), /assertSourceNotInFinalizedTaxReturn\(/, file);
  }
});

test('invoice and bill voids refuse dependent settlements, notes and writeoffs', () => {
  const invoice = read('src/modules/transactions/invoices/invoices.service.js');
  const bill = read('src/modules/transactions/bills/bills.service.js');
  assert.match(invoice, /Cannot void an invoice with posted receipts/);
  assert.match(invoice, /Cannot void an invoice with applied credit notes/);
  assert.match(invoice, /Cannot void an invoice with a posted write-off/);
  assert.match(bill, /Cannot void a bill with posted vendor payments/);
  assert.match(bill, /Cannot void a bill with applied debit notes/);
  assert.match(bill, /Cannot void a bill with a posted write-off/);
});

test('live E-VAT and finalized withholding history cannot be silently erased by source void', () => {
  const fiscal = read('src/modules/integrations/fiscalization/fiscalization.service.js');
  const invoice = read('src/modules/transactions/invoices/invoices.service.js');
  const wht = read('src/core/accounting/tax/ghanaWithholding.service.js');
  assert.match(fiscal, /async function prepareSourceForVoid/);
  assert.match(fiscal, /live GRA E-VAT fiscalization process/);
  assert.match(fiscal, /status='cancelled'/);
  assert.match(invoice, /fiscalizationSvc\.prepareSourceForVoid/);
  assert.match(wht, /r\.status IN \('finalized','filed','amended'\)/);
  assert.match(wht, /withholding-return amendment workflow/);
  assert.match(wht, /DELETE FROM ghana_withholding_return_lines/);
});
