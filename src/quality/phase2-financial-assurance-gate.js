const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const SRC = path.resolve(__dirname, '..');
const failures = [];
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
function must(rel, rx, message) { if (!rx.test(read(rel))) failures.push(`${rel}: ${message}`); }

must('interfaces/journalPosting.interface.js', /postingEngine\.service/, 'journal interface must route financial posting through the canonical engine');
must('core/accounting/posting/postingEngine.service.js', /financial_idempotency_conflict/, 'domain idempotency fingerprint enforcement missing');
must('core/accounting/posting/postingEngine.service.js', /claim && !claim\.isNew[\s\S]*idempotent: true/, 'post retry must close the DB-commit-before-HTTP-response idempotency gap');
must('core/accounting/journal/journal.routes.js', /postDraftJournal\(\{[\s\S]*idempotencyKey: req\.idempotency\.key/, 'journal post route must bind HTTP idempotency to the accounting command');
must('core/accounting/posting/postingEngine.service.js', /recordPostingProvenance/, 'immutable posting provenance missing');
must('core/accounting/policy/accountingPolicy.service.js', /accounting_policy_retroactive_change/, 'retroactive accounting policy guard missing');
must('core/accounting/integrity/financialIntegrity.service.js', /posted_journal_balance/, 'posted journal balance integrity check missing');
must('core/accounting/integrity/financialIntegrity.service.js', /ledger_projection_matches_journals/, 'ledger projection integrity check missing');
must('core/accounting/integrity/financialIntegrity.service.js', /ar_control_reconciliation/, 'AR subledger control reconciliation missing');
must('core/accounting/integrity/financialIntegrity.service.js', /ap_control_reconciliation/, 'AP subledger control reconciliation missing');
must('core/accounting/integrity/financialIntegrity.service.js', /inventory_control_reconciliation/, 'inventory control reconciliation missing');
must('db/migrations/sql/162_phase2_financial_assurance.sql', /journal_posting_provenance/, 'Phase 2 provenance schema missing');
must('db/migrations/sql/162_phase2_financial_assurance.sql', /FORCE ROW LEVEL SECURITY/, 'Phase 2 tenant tables must force RLS');
must('utilities/scheduled-tasks/taskRegistry.js', /accounting\.financial_integrity\.daily/, 'daily persisted financial-integrity job is not registered');
must('utilities/scheduled-tasks/accountingIntegrity.jobs.js', /runWithTenant/, 'scheduled integrity execution must establish tenant context');
must('health/health.routes.js', /162_phase2_financial_assurance\.sql/, 'readiness must require the Phase 2 schema baseline');
must('core/accounting/policy/accountingPolicy.js', /taxRoundingScope: new Set\(\['LINE'\]\)/, 'policy layer must not expose tax rounding behavior the engine does not implement');
must('core/accounting/posting/postingEngine.service.js', /normalizePostingLines\(normalizedPayload\.lines \|\| \[\], \{ requireBalanced: false \}\)/, 'canonical engine must defer multi-currency base balance validation to the journal kernel');

// Tier >= 2 code may not bypass the canonical journal interface.
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(abs) : [abs];
  });
}
for (const file of walk(SRC).filter((f) => f.endsWith('.js'))) {
  const rel = path.relative(SRC, file).replaceAll('\\', '/');
  if (rel === 'interfaces/journalPosting.interface.js' || rel.startsWith('core/accounting/journal/') || rel.startsWith('core/accounting/posting/') || rel.startsWith('quality/')) continue;
  const source = fs.readFileSync(file, 'utf8');
  if (/core\/accounting\/journal\/journal\.service|journal\.service/.test(source)) failures.push(`${rel}: imports journal service directly; use interfaces/journalPosting.interface.js`);
}

// The rebuildable GL projection has exactly two authorized runtime writers:
// the journal kernel and the reconciliation repair service.
for (const file of walk(SRC).filter((f) => f.endsWith('.js'))) {
  const rel = path.relative(SRC, file).replaceAll('\\', '/');
  if (rel.startsWith('tests/') || rel.startsWith('tests-node/') || rel.startsWith('quality/')) continue;
  const source = fs.readFileSync(file, 'utf8');
  if (/(INSERT INTO|UPDATE|DELETE FROM)\s+general_ledger_balances/i.test(source)
      && !['core/accounting/journal/journal.service.js','core/accounting/ledger/reconciliation.service.js'].includes(rel)) {
    failures.push(`${rel}: writes general_ledger_balances outside the accounting kernel/reconciliation repair path`);
  }
}

const unit = cp.spawnSync(process.execPath, ['--test', path.join(SRC, 'tests-node', 'phase2.financial-assurance.test.cjs')], { encoding: 'utf8' });
if (unit.status !== 0) failures.push(`Phase 2 financial invariant tests failed:\n${unit.stdout}${unit.stderr}`);

if (failures.length) {
  console.error('Phase 2 financial assurance gate: FAIL');
  failures.forEach((failure) => console.error(` - ${failure}`));
  process.exit(1);
}
console.log('Phase 2 financial assurance gate: PASS');
console.log(unit.stdout.trim());
