const {pool}=require('../../../../db/pool');
const forecastSvc=require('../cash-forecast/cashForecast.service');
async function getDashboard(orgId){
  const [{rows:balances},{rows:pending},{rows:liquidity},{rows:cheques},{rows:exceptions},forecast]=await Promise.all([
    pool.query(`SELECT ba.id AS bank_account_id,ba.code,ba.name,ba.currency_code,ba.minimum_balance,ba.overdraft_limit,
      COALESCE(SUM(CASE WHEN je.status='posted' AND COALESCE(jel.currency_code,ba.currency_code)=ba.currency_code THEN COALESCE(jel.debit,0)-COALESCE(jel.credit,0) ELSE 0 END),0) AS balance
      FROM bank_accounts ba LEFT JOIN journal_entry_lines jel ON jel.organization_id=ba.organization_id AND jel.account_id=ba.gl_account_id
      LEFT JOIN journal_entries je ON je.organization_id=jel.organization_id AND je.id=jel.journal_entry_id
      WHERE ba.organization_id=$1 AND ba.is_active=true GROUP BY ba.id ORDER BY ba.code`,[orgId]),
    pool.query(`SELECT
      (SELECT COUNT(*) FROM payment_runs WHERE organization_id=$1 AND status IN('submitted','approved')) AS pending_payment_runs,
      (SELECT COUNT(*) FROM bank_transfers WHERE organization_id=$1 AND status IN('submitted','approved')) AS pending_bank_transfers,
      (SELECT COUNT(*) FROM payment_approval_batches WHERE organization_id=$1 AND status IN('draft','submitted')) AS open_approval_batches`,[orgId]),
    pool.query(`SELECT currency_code,
      COALESCE(SUM(payment_runs),0) AS payment_runs,COALESCE(SUM(transfers),0) AS bank_transfers,COALESCE(SUM(cheques),0) AS outstanding_cheques
      FROM (
       SELECT pr.currency_code,COALESCE(SUM(prl.amount),0) payment_runs,0::numeric transfers,0::numeric cheques FROM payment_runs pr JOIN payment_run_lines prl ON prl.payment_run_id=pr.id WHERE pr.organization_id=$1 AND pr.status='approved' GROUP BY pr.currency_code
       UNION ALL SELECT source_currency_code,0,COALESCE(SUM(amount+fee_amount),0),0 FROM bank_transfers WHERE organization_id=$1 AND status='approved' GROUP BY source_currency_code
       UNION ALL SELECT currency_code,0,0,COALESCE(SUM(amount),0) FROM cheques WHERE organization_id=$1 AND status='issued' GROUP BY currency_code
      ) x WHERE currency_code IS NOT NULL GROUP BY currency_code ORDER BY currency_code`,[orgId]),
    pool.query(`SELECT currency_code,COUNT(*) AS outstanding_cheques,COALESCE(SUM(amount),0) AS outstanding_cheque_amount,
      COUNT(*) FILTER(WHERE issue_date<CURRENT_DATE-30) AS stale_cheques FROM cheques WHERE organization_id=$1 AND status='issued' GROUP BY currency_code ORDER BY currency_code`,[orgId]),
    pool.query(`SELECT
      (SELECT COUNT(*) FROM bank_reconciliations WHERE organization_id=$1 AND NOT is_locked AND ABS(COALESCE(difference,0))>COALESCE(tolerance_amount,0.01)) AS reconciliation_exceptions,
      (SELECT COUNT(*) FROM bank_statements bs WHERE organization_id=$1 AND status<>'locked' AND EXISTS(SELECT 1 FROM bank_statement_lines l WHERE l.statement_id=bs.id AND NOT EXISTS(SELECT 1 FROM bank_matches m WHERE m.organization_id=bs.organization_id AND m.bank_statement_line_id=l.id))) AS statements_with_unmatched_lines`,[orgId]),
    forecastSvc.generate(orgId,{horizonDays:30})
  ]);
  return {balances,pending:pending[0]||{},liquidityByCurrency:liquidity,outstandingChequesByCurrency:cheques,exceptions:exceptions[0]||{},forecast30d:forecast};
}
module.exports={getDashboard};
