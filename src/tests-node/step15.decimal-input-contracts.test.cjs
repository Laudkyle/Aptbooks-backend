const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('shared financial validators accept JSON numbers or decimal strings without Number coercion', () => {
  const src = read('src/shared/validators/financial.validators.js');
  assert.match(src, /normalizeDecimalInput/);
  assert.match(src, /typeof value === 'number'/);
  assert.match(src, /return String\(value\)/);
  assert.match(src, /parseDecimalToBigInt\(value, scale\)/);
  assert.match(src, /const moneyAmount = decimalValue/);
  assert.match(src, /const positiveMoneyAmount = decimalValue/);
  assert.match(src, /const quantityAmount = decimalValue/);
});

test('receipts and vendor payments preserve decimal-string totals and allocations', () => {
  const src = read('src/shared/validators/transactions.validators.js');
  assert.match(src, /const createVendorPaymentSchema[\s\S]*?amountTotal: moneyAmount/);
  assert.match(src, /const createCustomerReceiptSchema[\s\S]*?amountTotal: moneyAmount/);
  assert.match(src, /billId: z\.string\(\)\.uuid\(\),[\s\S]*?amountApplied: positiveMoneyAmount/);
  assert.match(src, /invoiceId: z\.string\(\)\.uuid\(\),[\s\S]*?amountApplied: positiveMoneyAmount/);
  assert.doesNotMatch(src, /amountTotal:\s*z\.number\(/);
  assert.doesNotMatch(src, /amountApplied:\s*z\.coerce\.number\(/);
});

test('invoice bill and note financial line values use decimal string contracts', () => {
  const invoice = read('src/shared/validators/transactions/invoices.validators.js');
  const transactions = read('src/shared/validators/transactions.validators.js');
  for (const src of [invoice, transactions]) {
    assert.match(src, /unitPrice: moneyAmount/);
    assert.match(src, /quantity: quantityAmount/);
    assert.match(src, /taxAmount: moneyAmount\.optional\(\)/);
    assert.match(src, /taxableAmount: moneyAmount\.optional\(\)/);
  }
});

test('all shared operational transaction schemas accept string money and quantity values', () => {
  const src = read('src/shared/validators/phase1.transactions.validators.js');
  assert.match(src, /amountTotal: moneyAmount\.optional\(\)/);
  assert.match(src, /amountTotal: positiveMoneyAmount/);
  assert.match(src, /unitPrice: moneyAmount\.optional\(\)/);
  assert.match(src, /lineTotal: moneyAmount\.optional\(\)/);
  assert.match(src, /quantity: quantityAmount\.optional\(\)/);
  assert.doesNotMatch(src, /amountTotal:\s*z\.number\(/);
});

test('asset and payment integration money validators no longer reject decimal strings', () => {
  const assets = read('src/shared/validators/assets.validators.js');
  assert.match(assets, /cost: moneyAmount/);
  assert.match(assets, /salvageValue: moneyAmount/);
  assert.match(assets, /proceeds: moneyAmount/);
  assert.match(assets, /newValue: moneyAmount/);
  assert.match(assets, /impairmentAmount: positiveMoneyAmount/);

  const payments = read('src/modules/integrations/payments/payments.validators.js');
  assert.match(payments, /amount: positiveMoneyAmount/);
  assert.doesNotMatch(payments, /amount:\s*z\.number\(\)\.positive/);
});

test('credit and debit note applications compare exact minor units rather than floating amounts', () => {
  for (const rel of [
    'src/modules/transactions/credit-notes/creditNotes.service.js',
    'src/modules/transactions/debit-notes/debitNotes.service.js',
  ]) {
    const src = read(rel);
    assert.match(src, /amountAppliedCents = parseDecimalToBigInt/);
    assert.match(src, /bigIntToDecimalString\(amountAppliedCents, 2\)/);
    assert.doesNotMatch(src, /normalizedPayload\.amountApplied > .*\+ 1e-9/);
  }
});
