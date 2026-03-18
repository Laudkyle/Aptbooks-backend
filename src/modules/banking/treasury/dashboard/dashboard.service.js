
const { pool } = require('../../../../db/pool');
const forecastSvc = require('../cash-forecast/cashForecast.service');

async function getDashboard(orgId) {
  const [{ rows: balances }, { rows: pending }, { rows: cheques }, { rows: runs }, { rows: transfers }, forecast] = await Promise.all([
    pool.query(
      `SELECT ba.id AS bank_account_id, ba.code, ba.name, ba.currency_code, COALESCE(SUM(bt.amount), 0) AS balance
         FROM bank_accounts ba
         LEFT JOIN bank_transactions bt ON bt.organization_id = ba.organization_id AND bt.bank_account_id = ba.id
        WHERE ba.organization_id=$1
        GROUP BY ba.id, ba.code, ba.name, ba.currency_code
        ORDER BY ba.code`,
      [orgId]
    ),
    pool.query(
      `SELECT
          (SELECT COUNT(*) FROM payment_runs WHERE organization_id=$1 AND status IN ('submitted','approved')) AS pending_payment_runs,
          (SELECT COUNT(*) FROM bank_transfers WHERE organization_id=$1 AND status IN ('submitted','approved')) AS pending_bank_transfers,
          (SELECT COUNT(*) FROM payment_approval_batches WHERE organization_id=$1 AND status IN ('draft','submitted')) AS open_approval_batches`,
      [orgId]
    ),
    pool.query(`SELECT COUNT(*) AS outstanding_cheques, COALESCE(SUM(amount),0) AS outstanding_cheque_amount FROM cheques WHERE organization_id=$1 AND status='issued'`, [orgId]),
    pool.query(`SELECT COALESCE(SUM(prl.amount),0) AS approved_run_amount FROM payment_runs pr JOIN payment_run_lines prl ON prl.payment_run_id=pr.id WHERE pr.organization_id=$1 AND pr.status='approved'`, [orgId]),
    pool.query(`SELECT COALESCE(SUM(amount + fee_amount),0) AS approved_transfer_outflow FROM bank_transfers WHERE organization_id=$1 AND status='approved'`, [orgId]),
    forecastSvc.generate(orgId, { horizonDays: 30 })
  ]);
  return {
    balances,
    pending: pending[0] || {},
    outstandingCheques: cheques[0] || {},
    approvedLiquidityNeeds: {
      paymentRuns: Number(runs[0]?.approved_run_amount || 0),
      bankTransfers: Number(transfers[0]?.approved_transfer_outflow || 0)
    },
    forecast30d: forecast
  };
}

module.exports = { getDashboard };
