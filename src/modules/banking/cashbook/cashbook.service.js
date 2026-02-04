const { AppError } = require("../../../shared/errors/AppError");
const { pool } = require("../../../db/pool");

async function listCashbook(orgId, query = {}) {
  const limit = Math.min(Number(query.limit || 200), 500);
  const offset = Math.max(Number(query.offset || 0), 0);
  const bankAccountId = query.bankAccountId || query.bank_account_id || null;
  const glAccountId = query.glAccountId || query.gl_account_id || null;
  const dateFrom = query.dateFrom || query.date_from || null;
  const dateTo = query.dateTo || query.date_to || null;
  const includeRunning = String(query.includeRunningBalance || query.include_running_balance || "false").toLowerCase() === "true";
  const sort = String(query.sort || "desc").toLowerCase() === "asc" ? "asc" : "desc";

  // If user passed a GL cash/bank account, resolve to bank_account_id when possible.
  let resolvedBankAccountId = bankAccountId;
  if (!resolvedBankAccountId && glAccountId) {
    const { rows } = await pool.query(
      `SELECT id FROM bank_accounts WHERE organization_id=$1 AND gl_account_id=$2 LIMIT 1`,
      [orgId, glAccountId]
    );
    if (rows.length) resolvedBankAccountId = rows[0].id;
  }

  if (resolvedBankAccountId) {
    const { rows } = await pool.query(
      `SELECT id FROM bank_accounts WHERE organization_id=$1 AND id=$2`,
      [orgId, resolvedBankAccountId]
    );
    if (!rows.length) throw new AppError(404, "Bank account not found");
  }

  // To behave like a real cashbook (running balances, opening/closing), the view must be scoped
  // to a single cash/bank account.
  if (!resolvedBankAccountId && !glAccountId) {
    throw new AppError(400, "bankAccountId or glAccountId is required for cashbook view");
  }

  // Two cashbook modes:
  // A) Bank cashbook: uses bank_transactions (statement + journal + manual)
  // B) Cash-on-hand cashbook: derives from posted journal lines for a GL cash account
  const mode = resolvedBankAccountId ? "bank" : (glAccountId ? "gl" : "bank");

  const wantAscForRunning = includeRunning && sort === "desc" && String(query.runningPrefersAsc || "true").toLowerCase() === "true";
  const effectiveSort = wantAscForRunning ? "asc" : sort;

  if (mode === "bank") {
    const params = [orgId];
    let where = "WHERE bt.organization_id=$1";

    if (resolvedBankAccountId) {
      params.push(resolvedBankAccountId);
      where += ` AND bt.bank_account_id=$${params.length}`;
    }
    if (dateFrom) {
      params.push(dateFrom);
      where += ` AND bt.txn_date >= $${params.length}`;
    }
    if (dateTo) {
      params.push(dateTo);
      where += ` AND bt.txn_date <= $${params.length}`;
    }

    // Opening balance = sum of all amounts strictly before dateFrom (per bank account filter).
    let openingBalance = 0;
    if (dateFrom) {
      const p2 = params.slice(0, 1);
      let w2 = "WHERE bt.organization_id=$1";
      if (resolvedBankAccountId) {
        p2.push(resolvedBankAccountId);
        w2 += ` AND bt.bank_account_id=$${p2.length}`;
      }
      p2.push(dateFrom);
      w2 += ` AND bt.txn_date < $${p2.length}`;
      const { rows: ob } = await pool.query(
        `SELECT COALESCE(SUM(bt.amount),0) AS opening FROM bank_transactions bt ${w2}`,
        p2
      );
      openingBalance = Number(ob[0]?.opening || 0);
    }

    // Totals for window.
    const p3 = params.slice(0, params.length);
    const { rows: tt } = await pool.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN bt.amount > 0 THEN bt.amount ELSE 0 END),0) AS total_in,
        COALESCE(SUM(CASE WHEN bt.amount < 0 THEN -bt.amount ELSE 0 END),0) AS total_out,
        COALESCE(SUM(bt.amount),0) AS net
      FROM bank_transactions bt
      ${where}
      `,
      params
    );
    const totalIn = Number(tt[0]?.total_in || 0);
    const totalOut = Number(tt[0]?.total_out || 0);
    const net = Number(tt[0]?.net || 0);
    const closingBalance = Number((openingBalance + net).toFixed(6));

    params.push(limit);
    params.push(offset);

    // Running balance should read in the same order as rows returned.
    // We compute a cumulative sum over the sorted result set, anchored at openingBalance.
    const runningExpr = includeRunning
      ? `, ($1::numeric + SUM(bt.amount) OVER (PARTITION BY bt.bank_account_id ORDER BY bt.txn_date ${effectiveSort.toUpperCase()}, bt.created_at ${effectiveSort.toUpperCase()}, bt.id ${effectiveSort.toUpperCase()} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS running_balance`
      : "";

    // Note: we add openingBalance as $1 (already orgId is $1 for where), so we embed openingBalance constant instead.
    const runningExpr2 = includeRunning
      ? `, (${openingBalance}::numeric + SUM(bt.amount) OVER (PARTITION BY bt.bank_account_id ORDER BY bt.txn_date ${effectiveSort.toUpperCase()}, bt.created_at ${effectiveSort.toUpperCase()}, bt.id ${effectiveSort.toUpperCase()} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS running_balance`
      : "";

    const { rows } = await pool.query(
      `
      SELECT
        bt.id,
        bt.bank_account_id,
        ba.code AS bank_account_code,
        ba.name AS bank_account_name,
        bt.txn_date,
        bt.amount,
        bt.description,
        bt.reference,
        bt.source_type,
        bt.source_id,
        bt.statement_line_id,
        bt.journal_entry_id,
        bt.external_id,
        bt.created_at,
        m.journal_entry_id AS matched_journal_entry_id,
        m.matched_at AS matched_at,
        m.matched_by AS matched_by
        ${runningExpr2}
      FROM bank_transactions bt
      JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      LEFT JOIN bank_matches m ON m.bank_statement_line_id = bt.statement_line_id
      ${where}
      ORDER BY bt.txn_date ${effectiveSort.toUpperCase()}, bt.created_at ${effectiveSort.toUpperCase()}
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );

    return {
      mode: "bank",
      data: rows,
      summary: { openingBalance, closingBalance, totalIn, totalOut, net },
      paging: { limit, offset, sort: effectiveSort },
    };
  }

  // GL cashbook mode: derive from posted journals for a specific GL cash account.
  if (!glAccountId) throw new AppError(400, "bankAccountId or glAccountId required");

  // Opening balance: sum(amount_base) before dateFrom.
  let openingBalance = 0;
  if (dateFrom) {
    const { rows: ob } = await pool.query(
      `
      SELECT COALESCE(SUM(COALESCE(jel.amount_base, (COALESCE(jel.debit,0) - COALESCE(jel.credit,0)))),0) AS opening
      FROM journal_entries je
      JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
      WHERE je.organization_id=$1
        AND je.status='posted'
        AND jel.account_id=$2
        AND je.entry_date < $3
      `,
      [orgId, glAccountId, dateFrom]
    );
    openingBalance = Number(ob[0]?.opening || 0);
  }

  const where = [];
  const params = [orgId, glAccountId];
  where.push("je.organization_id=$1");
  where.push("je.status='posted'");
  where.push("jel.account_id=$2");
  if (dateFrom) {
    params.push(dateFrom);
    where.push(`je.entry_date >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`je.entry_date <= $${params.length}`);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const { rows: tt } = await pool.query(
    `
    SELECT
      COALESCE(SUM(CASE WHEN (COALESCE(jel.amount_base, (COALESCE(jel.debit,0) - COALESCE(jel.credit,0)))) > 0
        THEN (COALESCE(jel.amount_base, (COALESCE(jel.debit,0) - COALESCE(jel.credit,0)))) ELSE 0 END),0) AS total_in,
      COALESCE(SUM(CASE WHEN (COALESCE(jel.amount_base, (COALESCE(jel.debit,0) - COALESCE(jel.credit,0)))) < 0
        THEN -(COALESCE(jel.amount_base, (COALESCE(jel.debit,0) - COALESCE(jel.credit,0)))) ELSE 0 END),0) AS total_out,
      COALESCE(SUM(COALESCE(jel.amount_base, (COALESCE(jel.debit,0) - COALESCE(jel.credit,0)))),0) AS net
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
    ${whereSql}
    `,
    params
  );
  const totalIn = Number(tt[0]?.total_in || 0);
  const totalOut = Number(tt[0]?.total_out || 0);
  const net = Number(tt[0]?.net || 0);
  const closingBalance = Number((openingBalance + net).toFixed(6));

  params.push(limit);
  params.push(offset);

  const runningExpr = includeRunning
    ? `, (${openingBalance}::numeric + SUM(COALESCE(jel.amount_base, (COALESCE(jel.debit,0) - COALESCE(jel.credit,0)))) OVER (ORDER BY je.entry_date ${effectiveSort.toUpperCase()}, je.created_at ${effectiveSort.toUpperCase()}, je.id ${effectiveSort.toUpperCase()} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS running_balance`
    : "";

  const { rows } = await pool.query(
    `
    SELECT
      je.id AS journal_entry_id,
      je.entry_date AS txn_date,
      (COALESCE(jel.amount_base, (COALESCE(jel.debit,0) - COALESCE(jel.credit,0)))) AS amount,
      COALESCE(jel.description, je.memo) AS description,
      je.id::text AS reference,
      'journal' AS source_type,
      je.id AS source_id,
      je.created_at
      ${runningExpr}
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
    ${whereSql}
    ORDER BY je.entry_date ${effectiveSort.toUpperCase()}, je.created_at ${effectiveSort.toUpperCase()}
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params
  );

  return {
    mode: "gl",
    glAccountId,
    data: rows,
    summary: { openingBalance, closingBalance, totalIn, totalOut, net },
    paging: { limit, offset, sort: effectiveSort },
  };
}

module.exports = { listCashbook };
