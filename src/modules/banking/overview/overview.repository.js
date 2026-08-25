const { pool } = require('../../../db/pool');

async function getWorkspaceRows(orgId, client = null) {
  const db = client || pool;
  const [accounts, statements, recon, recent] = await Promise.all([
    db.query(`SELECT COUNT(*) FILTER (WHERE is_active) AS active_accounts,
                     COUNT(*) FILTER (WHERE NOT is_active) AS inactive_accounts,
                     COUNT(*) AS total_accounts
                FROM bank_accounts WHERE organization_id=$1`, [orgId]),
    db.query(`SELECT COUNT(*) FILTER (WHERE status='draft') AS draft_statements,
                     COUNT(*) FILTER (WHERE status='validated') AS validated_statements,
                     COUNT(*) FILTER (WHERE status='locked') AS locked_statements,
                     COALESCE(SUM(CASE WHEN status<>'locked' THEN (SELECT COUNT(*) FROM bank_statement_lines bsl WHERE bsl.statement_id=bs.id AND NOT EXISTS(SELECT 1 FROM bank_matches bm WHERE bm.organization_id=bs.organization_id AND bm.bank_statement_line_id=bsl.id)) ELSE 0 END),0) AS unmatched_lines
                FROM bank_statements bs WHERE organization_id=$1`, [orgId]),
    db.query(`SELECT COUNT(*) FILTER (WHERE NOT is_locked) AS open_reconciliations,
                     COUNT(*) FILTER (WHERE is_locked) AS closed_reconciliations,
                     COUNT(*) FILTER (WHERE NOT is_locked AND ABS(COALESCE(difference,0))>COALESCE(tolerance_amount,0.01)) AS reconciliation_exceptions
                FROM bank_reconciliations WHERE organization_id=$1`, [orgId]),
    db.query(`SELECT bs.id,bs.statement_no,bs.statement_date,bs.status,bs.line_count,bs.control_difference,
                     ba.code AS bank_code,ba.name AS bank_name,ba.currency_code
                FROM bank_statements bs JOIN bank_accounts ba ON ba.organization_id=bs.organization_id AND ba.id=bs.bank_account_id
               WHERE bs.organization_id=$1 ORDER BY bs.statement_date DESC,bs.created_at DESC LIMIT 8`, [orgId])
  ]);
  return { accounts: accounts.rows[0] || {}, statements: statements.rows[0] || {}, reconciliations: recon.rows[0] || {}, recentStatements: recent.rows };
}

module.exports = { getWorkspaceRows };
