const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('migration 165 installs tenant-safe treasury controls and active-cheque uniqueness', () => {
  const src = read('db/migrations/sql/165_banking_treasury_production_hardening.sql');
  assert.match(src, /CREATE TABLE IF NOT EXISTS treasury_controls/);
  assert.match(src, /ALTER TABLE treasury_controls ENABLE ROW LEVEL SECURITY/);
  assert.match(src, /ALTER TABLE treasury_controls FORCE ROW LEVEL SECURITY/);
  assert.match(src, /CREATE POLICY aptbooks_tenant_isolation ON treasury_controls/);
  assert.match(src, /CREATE UNIQUE INDEX uq_cheques_org_payment_run[\s\S]*status NOT IN \('voided','bounced'\)/);
  assert.match(src, /reversal_journal_entry_id/);
});

test('treasury instructions enforce maker-checker, batch isolation and same-currency posting', () => {
  const runs = read('modules/banking/treasury/payment-runs/paymentRuns.service.js');
  const transfers = read('modules/banking/treasury/bank-transfers/bankTransfers.service.js');
  const batches = read('modules/banking/treasury/approval-batches/approvalBatches.service.js');
  assert.match(runs, /assertMakerChecker/);
  assert.match(runs, /belongs to an approval batch and must be approved through that batch/);
  assert.match(runs, /\['executed','reversed'\]\.includes\(h\.status\)/);
  assert.match(transfers, /Direct cross-currency bank transfers are blocked/);
  assert.match(transfers, /Cross-currency bank transfer posting requires a dedicated FX workflow/);
  assert.match(transfers, /assertExecutionSeparation/);
  assert.match(batches, /Only explicitly submitted treasury instructions can enter an approval batch/);
  assert.match(batches, /approvalBatchId:null/);
});

test('cheques cannot bypass the ledger and linked payment-run reversals preserve evidence', () => {
  const src = read('modules/banking/treasury/cheques/cheques.service.js');
  assert.match(src, /Only available cheques can be issued/);
  assert.match(src, /Cheque issue must either be linked to a controlled payment run or post its accounting entry on issue/);
  assert.match(src, /assertNoActiveChequeForRun/);
  assert.match(src, /cheque-payment-run-reversal:/);
  assert.match(src, /PAYMENT_RUN_REVERSED_BY_CHEQUE/);
  assert.match(src, /reversalJournalEntryId/);
  assert.match(src, /A payment-run cheque cannot clear until its payment run has been executed and posted/);
});

test('bank reconciliation closes only on validated, exact, open-period control evidence', () => {
  const src = read('modules/banking/reconciliations/reconciliations.service.js');
  assert.match(src, /assertPeriodOpen\(orgId, current\.period_id, client\)/);
  assert.match(src, /Statement must be validated before reconciliation can close/);
  assert.match(src, /unmatched_count/);
  assert.match(src, /wrong_currency_lines/);
  assert.match(src, /absUnits\(moneyUnits\(control\.difference\)\) > moneyUnits\(control\.tolerance_amount \|\| 0\)/);
  assert.match(src, /BANK_RECONCILIATION_CLOSED/);
  assert.match(src, /setStatementStatus\(orgId, control\.statement_id, 'locked', userId, client\)/);
});

test('treasury liquidity and forecasting remain currency separated and avoid cheque double counting', () => {
  const dashboard = read('modules/banking/treasury/dashboard/dashboard.service.js');
  const forecast = read('modules/banking/treasury/cash-forecast/cashForecast.service.js');
  const forecastRepo = read('modules/banking/treasury/cash-forecast/cashForecast.repository.js');
  assert.match(dashboard, /liquidityByCurrency/);
  assert.match(forecast, /summaryByCurrency/);
  assert.match(forecast, /mixedCurrency:summaryByCurrency\.length>1/);
  assert.doesNotMatch(forecastRepo, /FROM cheques[\s\S]*status='issued'/);
  assert.doesNotMatch(dashboard, /bank_statement_lines l WHERE l\.organization_id/);
  const overview = read('modules/banking/overview/overview.repository.js');
  assert.doesNotMatch(overview, /bank_statement_lines bsl WHERE bsl\.organization_id/);
});
