const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");
const { trialBalance } = require("../financial-statements/financialStatements.service");

function parseDateParam(value, name) {
  if (!value) return null;
  const s = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new AppError(400, `${name} must be YYYY-MM-DD`);
  }
  return s;
}

async function listActivity({ orgId, query }) {
  const from = parseDateParam(query.from, "from");
  const to = parseDateParam(query.to, "to");
  const actorUserId = query.actorUserId || null;
  const actionPrefix = query.actionPrefix || null;
  const entityType = query.entityType || null;
  const limit = Math.min(Number(query.limit || 100) || 100, 500);

  const params = [orgId];
  let where = `WHERE organization_id=$1`;
  if (from) {
    params.push(from);
    where += ` AND created_at >= ($${params.length}::date)`;
  }
  if (to) {
    params.push(to);
    where += ` AND created_at < (($${params.length}::date) + INTERVAL '1 day')`;
  }
  if (actorUserId) {
    params.push(actorUserId);
    where += ` AND actor_user_id = $${params.length}`;
  }
  if (entityType) {
    params.push(entityType);
    where += ` AND entity_type = $${params.length}`;
  }
  if (actionPrefix) {
    params.push(String(actionPrefix) + "%");
    where += ` AND action LIKE $${params.length}`;
  }
  params.push(limit);

  const { rows } = await pool.query(
    `
    SELECT id, created_at, action, entity_type, entity_id, actor_user_id, ip, user_agent,
           before_json, after_json
    FROM audit_logs
    ${where}
    ORDER BY created_at DESC
    LIMIT $${params.length}
    `,
    params
  );
  return rows;
}

async function listDefinitionChanges({ orgId, query }) {
  const from = parseDateParam(query.from, "from");
  const to = parseDateParam(query.to, "to");
  const entityType = query.entityType || null;
  const limit = Math.min(Number(query.limit || 100) || 100, 500);

  const params = [orgId];
  let where = `WHERE organization_id=$1`;
  if (entityType) {
    params.push(entityType);
    where += ` AND entity_type = $${params.length}`;
  }
  if (from) {
    params.push(from);
    where += ` AND changed_at >= ($${params.length}::date)`;
  }
  if (to) {
    params.push(to);
    where += ` AND changed_at < (($${params.length}::date) + INTERVAL '1 day')`;
  }
  params.push(limit);

  const { rows } = await pool.query(
    `
    SELECT id, changed_at, entity_type, entity_id, action, old_row, new_row
    FROM reporting_definition_audit
    ${where}
    ORDER BY changed_at DESC
    LIMIT $${params.length}
    `,
    params
  );
  return rows;
}

async function periodCloseAudit({ orgId, periodId }) {
  if (!periodId) throw new AppError(400, "periodId is required");

  const { rows: pRows } = await pool.query(
    `SELECT id, code, start_date, end_date, status FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!pRows.length) throw new AppError(404, "Period not found");
  const period = pRows[0];

  const { rows: jRows } = await pool.query(
    `SELECT COUNT(*)::int AS posted_count
     FROM journal_entries
     WHERE organization_id=$1 AND period_id=$2 AND status='posted'`,
    [orgId, periodId]
  );

  const tb = await trialBalance({ orgId, periodId });
  const tbTotals = tb.reduce(
    (acc, r) => {
      acc.debit += Number(r.debit_total || 0);
      acc.credit += Number(r.credit_total || 0);
      return acc;
    },
    { debit: 0, credit: 0 }
  );

  const { rows: bankRows } = await pool.query(
    `
    SELECT ba.id AS bank_account_id, ba.name,
           COUNT(DISTINCT bs.id)::int AS statements,
           COUNT(DISTINCT br.id)::int AS reconciliations,
           BOOL_OR(br.is_locked) AS any_locked
    FROM bank_accounts ba
    LEFT JOIN bank_statements bs
      ON bs.bank_account_id=ba.id AND bs.organization_id=$1
     AND bs.statement_date BETWEEN $3 AND $4
    LEFT JOIN bank_reconciliations br
      ON br.bank_account_id=ba.id AND br.organization_id=$1 AND br.period_id=$2
    WHERE ba.organization_id=$1
    GROUP BY ba.id, ba.name
    ORDER BY ba.name
    `,
    [orgId, periodId, period.start_date, period.end_date]
  );

  const { rows: taxRows } = await pool.query(
    `
    SELECT COUNT(*)::int AS returns_count
    FROM tax_returns
    WHERE organization_id=$1
      AND period_start >= $2::date
      AND period_end <= $3::date
    `,
    [orgId, period.start_date, period.end_date]
  ).catch(() => ({ rows: [{ returns_count: 0 }] }));

  return {
    period,
    journals: { posted_count: jRows[0]?.posted_count || 0 },
    trial_balance_totals: {
      debit_total: tbTotals.debit,
      credit_total: tbTotals.credit,
      balanced: Math.abs(tbTotals.debit - tbTotals.credit) < 0.005
    },
    banking: bankRows,
    tax: { returns_count: taxRows[0]?.returns_count || 0 }
  };
}

module.exports = { listActivity, listDefinitionChanges, periodCloseAudit };
