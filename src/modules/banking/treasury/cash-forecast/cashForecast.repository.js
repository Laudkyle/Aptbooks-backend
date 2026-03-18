
const { pool } = require('../../../../db/pool');

async function getCurrentBalances(orgId, bankAccountIds = null, client = pool) {
  const params = [orgId];
  let accountFilter = '';
  if (Array.isArray(bankAccountIds) && bankAccountIds.length) {
    params.push(bankAccountIds);
    accountFilter = ` AND ba.id = ANY($2::uuid[])`;
  }
  const { rows } = await client.query(
    `SELECT ba.id AS bank_account_id, ba.code, ba.name, ba.currency_code,
            COALESCE(SUM(bt.amount), 0) AS current_balance
       FROM bank_accounts ba
       LEFT JOIN bank_transactions bt ON bt.organization_id = ba.organization_id AND bt.bank_account_id = ba.id
      WHERE ba.organization_id=$1 ${accountFilter}
      GROUP BY ba.id, ba.code, ba.name, ba.currency_code
      ORDER BY ba.code`,
    params
  );
  return rows;
}

async function getPlannedOutflows(orgId, dateTo, client = pool) {
  const { rows } = await client.query(
    `SELECT 'payment_run' AS item_type, pr.id AS item_id, pr.bank_account_id, pr.execution_date AS txn_date,
            COALESCE(SUM(prl.amount), 0) * -1 AS amount, pr.code AS reference, pr.status
       FROM payment_runs pr
       JOIN payment_run_lines prl ON prl.payment_run_id = pr.id
      WHERE pr.organization_id=$1
        AND pr.status IN ('submitted','approved')
        AND pr.execution_date <= $2
      GROUP BY pr.id
      UNION ALL
     SELECT 'bank_transfer' AS item_type, bt.id AS item_id, bt.from_bank_account_id AS bank_account_id,
            bt.transfer_date AS txn_date,
            (COALESCE(bt.amount, 0) + COALESCE(bt.fee_amount, 0)) * -1 AS amount,
            bt.code AS reference, bt.status
       FROM bank_transfers bt
      WHERE bt.organization_id=$1
        AND bt.status IN ('submitted','approved')
        AND bt.transfer_date <= $2
      UNION ALL
     SELECT 'cheque' AS item_type, c.id AS item_id, c.bank_account_id, c.issue_date AS txn_date,
            COALESCE(c.amount, 0) * -1 AS amount,
            c.cheque_no AS reference, c.status
       FROM cheques c
      WHERE c.organization_id=$1
        AND c.status = 'issued'
        AND c.issue_date IS NOT NULL
        AND c.issue_date <= $2
      ORDER BY txn_date ASC`,
    [orgId, dateTo]
  );
  return rows;
}

async function getPlannedInflows(orgId, dateTo, client = pool) {
  const { rows } = await client.query(
    `SELECT 'bank_transfer_in' AS item_type, bt.id AS item_id, bt.to_bank_account_id AS bank_account_id,
            bt.transfer_date AS txn_date,
            COALESCE(bt.amount, 0) AS amount,
            bt.code AS reference, bt.status
       FROM bank_transfers bt
      WHERE bt.organization_id=$1
        AND bt.status IN ('submitted','approved')
        AND bt.transfer_date <= $2
      ORDER BY txn_date ASC`,
    [orgId, dateTo]
  );
  return rows;
}

async function createSnapshot(orgId, payload, actorUserId, client = pool) {
  const { rows } = await client.query(
    `INSERT INTO cash_forecast_snapshots(
      organization_id, name, start_date, end_date, horizon_days, assumptions_json, generated_json, created_by_user_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *`,
    [orgId, payload.name || null, payload.startDate, payload.endDate, payload.horizonDays, JSON.stringify(payload.assumptionsJson || {}), JSON.stringify(payload.generatedJson || {}), actorUserId || null]
  );
  return rows[0];
}

async function listSnapshots(orgId) {
  const { rows } = await pool.query(`SELECT * FROM cash_forecast_snapshots WHERE organization_id=$1 ORDER BY created_at DESC`, [orgId]);
  return rows;
}

module.exports = { getCurrentBalances, getPlannedOutflows, getPlannedInflows, createSnapshot, listSnapshots };
