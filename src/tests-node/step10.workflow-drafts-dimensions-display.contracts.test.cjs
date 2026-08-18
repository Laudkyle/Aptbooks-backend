const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('unsubmitted journal drafts replace existing lines by upsert and remain balance-optional until submit', () => {
  const service = read('core/accounting/journal/journal.service.js');
  assert.match(service, /Only draft\/rejected journals can be edited/);
  assert.match(service, /async function replaceDraftLines/);
  assert.match(service, /requireBalanced = false/);
  assert.match(service, /ON CONFLICT \(journal_entry_id, line_no\) DO UPDATE SET/);
  assert.match(service, /DELETE FROM journal_entry_lines WHERE journal_entry_id=\$1 AND line_no > \$2/);
  assert.match(service, /if \(totals\.debit !== totals\.credit\) throw new AppError\(400, "Journal not balanced"\)/);
});

test('approval inbox treats undefined/all filters as absent and applies selected filters to pending approval semantics', () => {
  const service = read('workflow/approvals/approvals.service.js');
  const repo = read('workflow/approvals/approvals.repository.js');
  assert.match(service, /text\.toLowerCase\(\) === "undefined"/);
  assert.match(service, /text\.toLowerCase\(\) === "all"/);
  assert.match(repo, /da\.status='PENDING'/);
  assert.match(repo, /LOWER\(COALESCE\(approval_status,''\)\)/);
  assert.match(repo, /LOWER\(source\)/);
  assert.match(repo, /document_type_id =/);
});

test('dimension security provides tenant-scoped named options and validates selected principals', () => {
  const routes = read('core/foundation/dimension-security/dimensionSecurity.routes.js');
  const service = read('core/foundation/dimension-security/dimensionSecurity.service.js');
  const repo = read('core/foundation/dimension-security/dimensionSecurity.repository.js');
  assert.match(routes, /router\.get\("\/options"/);
  assert.match(service, /assertPrincipalExists/);
  assert.match(repo, /principal_name/);
  assert.match(repo, /org_locations/);
  assert.match(repo, /org_departments/);
  assert.match(repo, /cost_centers/);
  assert.match(repo, /profit_centers/);
  assert.match(repo, /investment_centers/);
  assert.match(repo, /projects/);
});

test('project dimension status validation uses the actual active/completed project vocabulary', () => {
  const validator = read('reporting/dimensions/dimensions.validator.js');
  assert.match(validator, /\['active','completed'\]\.includes\(phase\.status\)/);
  assert.match(validator, /\["active", "completed"\]\.includes\(task\.status\)/);
  assert.doesNotMatch(validator, /\['active','closed'\]\.includes\(phase\.status\)/);
});

test('major accounting detail repositories enrich internal references with business labels', () => {
  const journal = read('core/accounting/journal/journal.service.js');
  const ops = read('modules/transactions/_shared/opsDocs.repository.js');
  const assets = read('modules/assets/fixed-assets/fixedAssets.repository.js');
  const recon = read('modules/banking/reconciliations/reconciliations.repository.js');
  assert.match(journal, /created_by_name/);
  assert.match(journal, /approved_by_name/);
  assert.match(journal, /period_code/);
  assert.match(ops, /partner_name/);
  assert.match(ops, /cash_account_name/);
  assert.match(ops, /journal_entry_no/);
  assert.match(assets, /location_name/);
  assert.match(assets, /department_name/);
  assert.match(recon, /bank_account_name/);
  assert.match(recon, /reconciled_by_name/);
});

test('reconciliation write locks target only the reconciliation row, not nullable display joins', () => {
  const repo = read('modules/banking/reconciliations/reconciliations.repository.js');
  assert.match(repo, /if \(forUpdate\)/);
  assert.match(repo, /SELECT \* FROM bank_reconciliations[\s\S]*FOR UPDATE/);
});
