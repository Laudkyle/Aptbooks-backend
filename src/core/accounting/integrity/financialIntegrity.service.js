const { pool } = require('../../../db/pool');
const { AppError } = require('../../../shared/errors/AppError');
const { writeAudit } = require('../../foundation/audit-logs/audit.service');

const MAX_FINDINGS_PER_CHECK = 1000;

function today() { return new Date().toISOString().slice(0, 10); }
function severityRank(value) { return ({ info: 0, warning: 1, error: 2, critical: 3 })[value] ?? 0; }
function statusFromFindings(findings) {
  const max = findings.reduce((m, f) => Math.max(m, severityRank(f.severity)), 0);
  if (max >= 2) return 'failed';
  if (max === 1) return 'warnings';
  return 'passed';
}
async function getBaseCurrency(client, orgId) {
  const { rows } = await client.query('SELECT base_currency_code FROM organizations WHERE id=$1', [orgId]);
  if (!rows.length) throw new AppError(404, 'Organization not found', null, 'organization_not_found');
  return rows[0].base_currency_code;
}

async function checkPostedJournalBalance(client, { orgId, periodId, asOfDate }) {
  const params = [orgId, asOfDate];
  let periodSql = '';
  if (periodId) { params.push(periodId); periodSql = ` AND je.period_id=$${params.length}`; }
  const { rows } = await client.query(`
    SELECT je.id, je.entry_no, je.period_id, je.entry_date,
           SUM(CASE WHEN jel.debit > 0 THEN jel.amount_base ELSE 0 END)::numeric(18,2) AS debit_total,
           SUM(CASE WHEN jel.credit > 0 THEN jel.amount_base ELSE 0 END)::numeric(18,2) AS credit_total,
           (SUM(CASE WHEN jel.debit > 0 THEN jel.amount_base ELSE 0 END) -
            SUM(CASE WHEN jel.credit > 0 THEN jel.amount_base ELSE 0 END))::numeric(18,2) AS variance
      FROM journal_entries je
      JOIN journal_entry_lines jel ON jel.journal_entry_id=je.id
     WHERE je.organization_id=$1 AND je.status IN ('posted','voided') AND je.entry_date <= $2::date
       ${periodSql}
     GROUP BY je.id, je.entry_no, je.period_id, je.entry_date
    HAVING SUM(CASE WHEN jel.debit > 0 THEN jel.amount_base ELSE 0 END) <>
           SUM(CASE WHEN jel.credit > 0 THEN jel.amount_base ELSE 0 END)
     ORDER BY je.entry_date, je.entry_no
     LIMIT ${MAX_FINDINGS_PER_CHECK}`, params);
  return rows.map((row) => ({ checkCode: 'posted_journal_balance', severity: 'critical', entityType: 'journal_entry',
    entityId: row.id, expectedAmount: row.debit_total, actualAmount: row.credit_total, varianceAmount: row.variance,
    message: `Posted journal ${row.entry_no || row.id} is not balanced in base currency.`,
    details: { periodId: row.period_id, entryDate: row.entry_date } }));
}

async function checkPeriodDateIntegrity(client, { orgId, periodId, asOfDate }) {
  const params = [orgId, asOfDate];
  let periodSql = '';
  if (periodId) { params.push(periodId); periodSql = ` AND je.period_id=$${params.length}`; }
  const { rows } = await client.query(`
    SELECT je.id, je.entry_no, je.entry_date, ap.id AS period_id, ap.code AS period_code, ap.start_date, ap.end_date
      FROM journal_entries je
      JOIN accounting_periods ap ON ap.id=je.period_id AND ap.organization_id=je.organization_id
     WHERE je.organization_id=$1 AND je.status IN ('posted','voided') AND je.entry_date <= $2::date
       ${periodSql}
       AND (je.entry_date < ap.start_date OR je.entry_date > ap.end_date)
     ORDER BY je.entry_date
     LIMIT ${MAX_FINDINGS_PER_CHECK}`, params);
  return rows.map((row) => ({ checkCode: 'journal_period_date', severity: 'critical', entityType: 'journal_entry', entityId: row.id,
    message: `Journal ${row.entry_no || row.id} falls outside accounting period ${row.period_code}.`,
    details: { entryDate: row.entry_date, periodId: row.period_id, startDate: row.start_date, endDate: row.end_date } }));
}

async function checkLedgerProjection(client, { orgId, periodId }) {
  const params = [orgId];
  let periodFilter = '';
  if (periodId) { params.push(periodId); periodFilter = ` AND period_id=$${params.length}`; }
  const { rows } = await client.query(`
    WITH canonical AS (
      SELECT organization_id, period_id, account_id, debit_total, credit_total
        FROM accounting_posted_ledger_totals
       WHERE organization_id=$1 ${periodFilter}
    ), projection AS (
      SELECT organization_id, period_id, account_id, debit_total, credit_total
        FROM general_ledger_balances
       WHERE organization_id=$1 ${periodFilter}
    )
    SELECT COALESCE(c.period_id,p.period_id) AS period_id,
           COALESCE(c.account_id,p.account_id) AS account_id,
           COALESCE(c.debit_total,0)::numeric(18,2) AS expected_debit,
           COALESCE(p.debit_total,0)::numeric(18,2) AS actual_debit,
           COALESCE(c.credit_total,0)::numeric(18,2) AS expected_credit,
           COALESCE(p.credit_total,0)::numeric(18,2) AS actual_credit,
           (COALESCE(c.debit_total,0)-COALESCE(c.credit_total,0))::numeric(18,2) AS expected_balance,
           (COALESCE(p.debit_total,0)-COALESCE(p.credit_total,0))::numeric(18,2) AS actual_balance,
           (ABS(COALESCE(c.debit_total,0)-COALESCE(p.debit_total,0)) +
            ABS(COALESCE(c.credit_total,0)-COALESCE(p.credit_total,0)))::numeric(18,2) AS variance
      FROM canonical c FULL OUTER JOIN projection p
        ON p.organization_id=c.organization_id AND p.period_id=c.period_id AND p.account_id=c.account_id
     WHERE COALESCE(c.debit_total,0)<>COALESCE(p.debit_total,0)
        OR COALESCE(c.credit_total,0)<>COALESCE(p.credit_total,0)
     ORDER BY period_id, account_id
     LIMIT ${MAX_FINDINGS_PER_CHECK}`, params);
  return rows.map((row) => ({ checkCode: 'ledger_projection_matches_journals', severity: 'critical', entityType: 'ledger_account',
    entityId: row.account_id, accountId: row.account_id, expectedAmount: row.expected_balance,
    actualAmount: row.actual_balance, varianceAmount: row.variance,
    message: 'General-ledger projection differs from immutable posted journal history.',
    details: { periodId: row.period_id, expectedDebit: row.expected_debit, actualDebit: row.actual_debit,
      expectedCredit: row.expected_credit, actualCredit: row.actual_credit } }));
}

async function checkSourceDocumentLinks(client, { orgId, asOfDate }) {
  const { rows } = await client.query(`
    WITH sources AS (
      SELECT 'invoice'::text entity_type, i.id, i.invoice_no reference, i.journal_entry_id, i.status
        FROM invoices i WHERE i.organization_id=$1 AND i.status IN ('issued','paid') AND i.invoice_date <= $2::date
      UNION ALL
      SELECT 'bill', b.id, b.bill_no, b.journal_entry_id, b.status
        FROM bills b WHERE b.organization_id=$1 AND b.status IN ('issued','paid') AND b.bill_date <= $2::date
      UNION ALL
      SELECT 'customer_receipt', r.id, r.receipt_no, r.journal_entry_id, r.status
        FROM customer_receipts r WHERE r.organization_id=$1 AND r.status='posted' AND r.receipt_date <= $2::date
      UNION ALL
      SELECT 'vendor_payment', p.id, p.payment_no, p.journal_entry_id, p.status
        FROM vendor_payments p WHERE p.organization_id=$1 AND p.status='posted' AND p.payment_date <= $2::date
      UNION ALL
      SELECT 'inventory_transaction', t.id, COALESCE(t.reference,t.id::text), t.journal_entry_id, t.status
        FROM inventory_transactions t WHERE t.organization_id=$1 AND t.status='posted' AND t.txn_date <= $2::date
    )
    SELECT s.*, je.status AS journal_status
      FROM sources s
      LEFT JOIN journal_entries je ON je.id=s.journal_entry_id AND je.organization_id=$1
     WHERE s.journal_entry_id IS NULL OR je.id IS NULL OR je.status NOT IN ('posted','voided')
     LIMIT ${MAX_FINDINGS_PER_CHECK}`, [orgId, asOfDate]);
  return rows.map((row) => ({ checkCode: 'source_document_journal_link', severity: 'error', entityType: row.entity_type, entityId: row.id,
    message: `${row.entity_type} ${row.reference} is financially active but is not linked to a valid posted journal.`,
    details: { sourceStatus: row.status, journalEntryId: row.journal_entry_id, journalStatus: row.journal_status } }));
}

async function checkSubledgerControl(client, { orgId, asOfDate, baseCurrency, kind }) {
  const isAr = kind === 'ar';
  if (asOfDate !== today()) {
    return [{ checkCode: `${isAr ? 'ar' : 'ap'}_control_reconciliation_coverage`, severity: 'info', entityType: 'subledger', entityId: kind,
      message: `${isAr ? 'AR' : 'AP'} open-item reconciliation is current-state only and was skipped for a historical as-of date.`, details: { asOfDate } }];
  }
  const view = isAr ? 'reporting_ar_open_items' : 'reporting_ap_open_items';
  const partnerId = isAr ? 'customer_id' : 'vendor_id';
  const accountCol = isAr ? 'default_receivable_account_id' : 'default_payable_account_id';
  const glBalanceExpression = isAr
    ? "SUM(CASE WHEN jel.debit>0 THEN jel.amount_base ELSE 0 END) - SUM(CASE WHEN jel.credit>0 THEN jel.amount_base ELSE 0 END)"
    : "SUM(CASE WHEN jel.credit>0 THEN jel.amount_base ELSE 0 END) - SUM(CASE WHEN jel.debit>0 THEN jel.amount_base ELSE 0 END)";
  const code = isAr ? 'ar_control_reconciliation' : 'ap_control_reconciliation';

  const foreign = await client.query(`SELECT COUNT(*)::int AS count FROM ${view} WHERE organization_id=$1 AND currency_code<>$2 AND outstanding<>0`, [orgId, baseCurrency]);
  const { rows } = await client.query(`
    WITH sub AS (
      SELECT bp.${accountCol} AS account_id, ROUND(SUM(oi.outstanding),2)::numeric(18,2) AS expected
        FROM ${view} oi
        JOIN business_partners bp ON bp.id=oi.${partnerId} AND bp.organization_id=oi.organization_id
       WHERE oi.organization_id=$1 AND oi.currency_code=$2 AND bp.${accountCol} IS NOT NULL
       GROUP BY bp.${accountCol}
    ), gl AS (
      SELECT jel.account_id,
             ROUND(${glBalanceExpression},2)::numeric(18,2) AS actual
        FROM journal_entries je
        JOIN journal_entry_lines jel ON jel.journal_entry_id=je.id
       WHERE je.organization_id=$1 AND je.status IN ('posted','voided') AND je.entry_date <= $3::date
         AND jel.account_id IN (SELECT ${accountCol} FROM business_partners WHERE organization_id=$1 AND ${accountCol} IS NOT NULL)
       GROUP BY jel.account_id
    )
    SELECT COALESCE(s.account_id,g.account_id) AS account_id,
           COALESCE(s.expected,0)::numeric(18,2) AS expected,
           COALESCE(g.actual,0)::numeric(18,2) AS actual,
           (COALESCE(g.actual,0)-COALESCE(s.expected,0))::numeric(18,2) AS variance
      FROM sub s FULL OUTER JOIN gl g ON g.account_id=s.account_id
     WHERE COALESCE(s.expected,0)<>COALESCE(g.actual,0)
     LIMIT ${MAX_FINDINGS_PER_CHECK}`, [orgId, baseCurrency, asOfDate]);

  const severity = Number(foreign.rows[0]?.count || 0) > 0 ? 'warning' : 'error';
  const findings = rows.map((row) => ({ checkCode: code, severity, entityType: 'ledger_account', entityId: row.account_id, accountId: row.account_id,
    expectedAmount: row.expected, actualAmount: row.actual, varianceAmount: row.variance,
    message: `${isAr ? 'Accounts receivable' : 'Accounts payable'} open-item subledger does not reconcile to its control account.`,
    details: { baseCurrency, foreignCurrencyOpenItemsExcluded: Number(foreign.rows[0]?.count || 0) } }));
  if (Number(foreign.rows[0]?.count || 0) > 0) {
    findings.push({ checkCode: `${code}_coverage`, severity: 'info', entityType: 'subledger', entityId: kind,
      message: `${foreign.rows[0].count} foreign-currency open item(s) were excluded from direct control-account comparison because open-item views do not retain historical base-currency carrying amounts.`,
      details: { baseCurrency, foreignCurrencyOpenItemsExcluded: Number(foreign.rows[0].count) } });
  }
  return findings;
}

async function checkInventoryControl(client, { orgId, asOfDate }) {
  if (asOfDate !== today()) return [{ checkCode: 'inventory_control_reconciliation_coverage', severity: 'info', entityType: 'subledger', entityId: 'inventory',
    message: 'Inventory balance reconciliation is current-state only and was skipped for a historical as-of date.', details: { asOfDate } }];
  const { rows } = await client.query(`
    WITH sub AS (
      SELECT c.inventory_account_id AS account_id,
             ROUND(SUM(b.qty_on_hand*b.avg_unit_cost),2)::numeric(18,2) AS expected
        FROM inventory_balances b
        JOIN inventory_items i ON i.id=b.item_id AND i.organization_id=b.organization_id
        JOIN item_categories c ON c.id=i.category_id AND c.organization_id=i.organization_id
       WHERE b.organization_id=$1
       GROUP BY c.inventory_account_id
    ), gl AS (
      SELECT jel.account_id,
             ROUND(SUM(CASE WHEN jel.debit>0 THEN jel.amount_base ELSE 0 END)-
                   SUM(CASE WHEN jel.credit>0 THEN jel.amount_base ELSE 0 END),2)::numeric(18,2) AS actual
        FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id=je.id
       WHERE je.organization_id=$1 AND je.status IN ('posted','voided')
         AND jel.account_id IN (SELECT inventory_account_id FROM item_categories WHERE organization_id=$1)
       GROUP BY jel.account_id
    )
    SELECT COALESCE(s.account_id,g.account_id) AS account_id,
           COALESCE(s.expected,0)::numeric(18,2) expected,
           COALESCE(g.actual,0)::numeric(18,2) actual,
           (COALESCE(g.actual,0)-COALESCE(s.expected,0))::numeric(18,2) variance
      FROM sub s FULL OUTER JOIN gl g ON g.account_id=s.account_id
     WHERE COALESCE(s.expected,0)<>COALESCE(g.actual,0)
     LIMIT ${MAX_FINDINGS_PER_CHECK}`, [orgId]);
  return rows.map((row) => ({ checkCode: 'inventory_control_reconciliation', severity: 'error', entityType: 'ledger_account', entityId: row.account_id,
    accountId: row.account_id, expectedAmount: row.expected, actualAmount: row.actual, varianceAmount: row.variance,
    message: 'Inventory valuation subledger does not reconcile to its inventory control account.', details: {} }));
}

async function checkBankJournalCoverage(client, { orgId, asOfDate }) {
  const { rows } = await client.query(`
    SELECT ba.id AS bank_account_id, ba.gl_account_id,
           COUNT(*) FILTER (WHERE bt.journal_entry_id IS NULL)::int AS unlinked_count
      FROM bank_accounts ba
      LEFT JOIN bank_transactions bt ON bt.bank_account_id=ba.id AND bt.organization_id=ba.organization_id
        AND bt.txn_date <= $2::date AND bt.source_type='journal'
     WHERE ba.organization_id=$1 AND ba.is_active=true
     GROUP BY ba.id, ba.gl_account_id
    HAVING COUNT(*) FILTER (WHERE bt.id IS NOT NULL AND bt.journal_entry_id IS NULL) > 0`, [orgId, asOfDate]);
  return rows.map((row) => ({ checkCode: 'bank_transaction_journal_link', severity: 'warning', entityType: 'bank_account', entityId: row.bank_account_id,
    accountId: row.gl_account_id, message: `${row.unlinked_count} journal-origin bank transaction(s) are missing journal provenance.`,
    details: { unlinkedCount: row.unlinked_count } }));
}

async function checkPostingProvenanceCoverage(client, { orgId, asOfDate }) {
  const { rows } = await client.query(`
    SELECT COUNT(*)::int AS missing
      FROM journal_entries je
      LEFT JOIN journal_posting_provenance p ON p.journal_entry_id=je.id AND p.organization_id=je.organization_id
     WHERE je.organization_id=$1 AND je.status IN ('posted','voided') AND je.entry_date <= $2::date
       AND je.created_at >= (SELECT applied_at FROM schema_migrations WHERE id LIKE '162_%' ORDER BY applied_at DESC LIMIT 1)
       AND p.id IS NULL`, [orgId, asOfDate]);
  const missing = Number(rows[0]?.missing || 0);
  return missing ? [{ checkCode: 'posting_provenance_coverage', severity: 'error', entityType: 'journal_entry', entityId: null,
    message: `${missing} journal(s) created after Phase 2 lack immutable posting provenance.`, details: { missingCount: missing } }] : [];
}

async function persistFinding(client, runId, orgId, finding) {
  await client.query(`
    INSERT INTO financial_integrity_findings
      (organization_id, run_id, check_code, severity, entity_type, entity_id, account_id,
       expected_amount, actual_amount, variance_amount, message, details_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [orgId, runId, finding.checkCode, finding.severity, finding.entityType || null, finding.entityId || null,
      finding.accountId || null, finding.expectedAmount ?? null, finding.actualAmount ?? null, finding.varianceAmount ?? null,
      finding.message, JSON.stringify(finding.details || {})]);
}

async function runIntegrityChecks({ orgId, actorUserId = null, periodId = null, asOfDate = today(), persist = true, client: existingClient = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOfDate))) throw new AppError(422, 'asOfDate must be YYYY-MM-DD', null, 'validation_error');
  const client = existingClient || await pool.connect();
  const managesTx = !existingClient;
  let runId = null;
  try {
    if (managesTx) await client.query('BEGIN');
    if (periodId) {
      const period = await client.query('SELECT id FROM accounting_periods WHERE organization_id=$1 AND id=$2', [orgId, periodId]);
      if (!period.rows.length) throw new AppError(404, 'Accounting period not found', null, 'accounting_period_not_found');
    }
    const baseCurrency = await getBaseCurrency(client, orgId);
    if (persist) {
      const { rows } = await client.query(`INSERT INTO financial_integrity_runs(organization_id,period_id,as_of_date,status,triggered_by)
        VALUES ($1,$2,$3,'running',$4) RETURNING id`, [orgId, periodId, asOfDate, actorUserId]);
      runId = rows[0].id;
    }

    const checkResults = await Promise.all([
      checkPostedJournalBalance(client, { orgId, periodId, asOfDate }),
      checkPeriodDateIntegrity(client, { orgId, periodId, asOfDate }),
      checkLedgerProjection(client, { orgId, periodId }),
      checkSourceDocumentLinks(client, { orgId, asOfDate }),
      checkSubledgerControl(client, { orgId, asOfDate, baseCurrency, kind: 'ar' }),
      checkSubledgerControl(client, { orgId, asOfDate, baseCurrency, kind: 'ap' }),
      checkInventoryControl(client, { orgId, asOfDate }),
      checkBankJournalCoverage(client, { orgId, asOfDate }),
      checkPostingProvenanceCoverage(client, { orgId, asOfDate }),
    ]);
    const findings = checkResults.flat();
    const counts = { info: 0, warning: 0, error: 0, critical: 0 };
    for (const finding of findings) counts[finding.severity] += 1;
    const status = statusFromFindings(findings);
    const summary = { status, counts, findingCount: findings.length, checksRun: 9, periodId, asOfDate, baseCurrency };

    if (persist) {
      for (const finding of findings) await persistFinding(client, runId, orgId, finding);
      await client.query(`UPDATE financial_integrity_runs SET status=$3, summary_json=$4::jsonb, completed_at=NOW()
        WHERE organization_id=$1 AND id=$2`, [orgId, runId, status, JSON.stringify(summary)]);
      await writeAudit({ organizationId: orgId, actorUserId, action: 'accounting.integrity.run', entityType: 'financial_integrity_runs',
        entityId: runId, after: summary, client });
    }
    if (managesTx) await client.query('COMMIT');
    return { runId, ...summary, findings };
  } catch (error) {
    if (managesTx) { try { await client.query('ROLLBACK'); } catch (_) {} }
    throw error;
  } finally {
    if (managesTx) client.release();
  }
}

async function getRun({ orgId, runId, client = pool }) {
  const { rows } = await client.query('SELECT * FROM financial_integrity_runs WHERE organization_id=$1 AND id=$2', [orgId, runId]);
  if (!rows.length) throw new AppError(404, 'Integrity run not found', null, 'integrity_run_not_found');
  const findings = await client.query(`SELECT * FROM financial_integrity_findings WHERE organization_id=$1 AND run_id=$2
    ORDER BY CASE severity WHEN 'critical' THEN 4 WHEN 'error' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC, check_code, created_at`, [orgId, runId]);
  return { ...rows[0], findings: findings.rows };
}

async function getLatestRun({ orgId, client = pool }) {
  const { rows } = await client.query('SELECT id FROM financial_integrity_runs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1', [orgId]);
  return rows.length ? getRun({ orgId, runId: rows[0].id, client }) : null;
}

module.exports = { runIntegrityChecks, getRun, getLatestRun, statusFromFindings };
