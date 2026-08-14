-- Step 2: make the authoritative accounting source explicit.
-- Posted journal lines are the books; general_ledger_balances is a rebuildable projection.

CREATE OR REPLACE VIEW accounting_posted_ledger_totals AS
SELECT
  je.organization_id,
  je.period_id,
  jel.account_id,
  SUM(CASE WHEN jel.debit > 0 THEN jel.amount_base ELSE 0 END)::NUMERIC(18,2) AS debit_total,
  SUM(CASE WHEN jel.credit > 0 THEN jel.amount_base ELSE 0 END)::NUMERIC(18,2) AS credit_total,
  COUNT(*)::BIGINT AS line_count
FROM journal_entries je
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
WHERE je.status IN ('posted', 'voided')
GROUP BY je.organization_id, je.period_id, jel.account_id;

COMMENT ON VIEW accounting_posted_ledger_totals IS
  'Canonical ledger totals derived from immutable posted journal history. Includes voided originals because voiding is represented by a separate posted reversal.';

COMMENT ON TABLE general_ledger_balances IS
  'Derived/rebuildable ledger projection for performance and reconciliation. It is not the authoritative accounting record; journal_entries and journal_entry_lines are the source of truth.';
