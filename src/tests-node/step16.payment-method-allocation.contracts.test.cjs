const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('payment methods persist an organization-safe default posting account', () => {
  const migration = read('src/db/migrations/sql/160_step16_payment_method_account_mapping.sql');
  const routes = read('src/modules/business/payment-config/payment-config.routes.js');
  const paymentIF = read('src/interfaces/paymentConfig.interface.js');
  const orgInit = read('src/core/foundation/organizations/organizations.service.js');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS default_account_id UUID/);
  assert.match(routes, /defaultAccountId: z\.string\(\)\.uuid\(\)\.nullable\(\)\.optional\(\)/);
  assert.match(paymentIF, /assertPaymentMethodAccount/);
  assert.match(paymentIF, /coa\.organization_id = pm\.organization_id/);
  assert.match(paymentIF, /default_account_code/);
  assert.match(paymentIF, /default_account_name/);
  assert.match(paymentIF, /default_account_id=\$\$\{i\+\+\}/);
  assert.match(migration, /UPPER\(pm\.code\) = 'CASH'[\s\S]*coa\.code = '1000'/);
  assert.match(orgInit, /ensurePaymentConfig\(\{ orgId, cashAccountId, bankAccountId: bankGlAccountId \}\)/);
});

test('receipt and vendor payment may resolve mapped account or accept an explicit override', () => {
  const validator = read('src/shared/validators/transactions.validators.js');
  const resolver = read('src/modules/transactions/_shared/paymentAccount.service.js');
  const receipt = read('src/modules/transactions/receipts/customer-receipts/customerReceipts.service.js');
  const payment = read('src/modules/transactions/payments/vendor-payments/vendorPayments.service.js');

  assert.match(validator, /cashAccountId: z\.string\(\)\.uuid\(\)\.optional\(\)\.nullable\(\)/);
  assert.match(resolver, /cashAccountId \|\| method\?\.default_account_id/);
  assert.match(resolver, /\$\{label\} must be postable/);
  assert.match(resolver, /\$\{label\} must be active/);
  assert.match(receipt, /resolvePaymentAccount/);
  assert.match(receipt, /cashAccountId: paymentAccountId/);
  assert.match(payment, /resolvePaymentAccount/);
  assert.match(payment, /cashAccountId: paymentAccountId/);
});

test('invoice and bill selection APIs expose live open balances', () => {
  const invoices = read('src/modules/transactions/invoices/invoices.service.js');
  const bills = read('src/modules/transactions/bills/bills.repository.js');
  assert.match(invoices, /LEFT JOIN reporting_ar_open_items ar/);
  assert.match(invoices, /ar\.outstanding AS outstanding/);
  assert.match(bills, /LEFT JOIN reporting_ap_open_items ap/);
  assert.match(bills, /ap\.outstanding AS outstanding/);
});
