const { pool } = require("../../../db/pool");
const { enqueueEvent } = require("../../../modules/webhooks/webhooks.service");
const { AppError } = require("../../../shared/errors/AppError");
const { parseDecimalToBigInt, bigIntToDecimalString } = require("../../../shared/utils/money");

async function getAccountTypeIdByCode(code) {
  const { rows } = await pool.query(`SELECT id FROM account_types WHERE code=$1`, [code]);
  if (!rows.length) throw new AppError(400, "Invalid account type code");
  return rows[0].id;
}

async function upsertCategory(orgId, categoryName) {
  if (!categoryName) return null;
  const { rows } = await pool.query(
    `
    INSERT INTO account_categories(organization_id, name)
    VALUES ($1,$2)
    ON CONFLICT (organization_id, name) DO UPDATE SET name=EXCLUDED.name
    RETURNING id
    `,
    [orgId, categoryName]
  );
  return rows[0].id;
}

async function createAccount({ orgId, payload }) {
  const typeId = await getAccountTypeIdByCode(payload.accountTypeCode);
  const categoryId = await upsertCategory(orgId, payload.categoryName);

  // Validate parent belongs to org if provided
  if (payload.parentAccountId) {
    const { rows: p } = await pool.query(
      `SELECT id FROM chart_of_accounts WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL`,
      [orgId, payload.parentAccountId]
    );
    if (!p.length) throw new AppError(400, "Invalid parentAccountId");
  }

  const { rows } = await pool.query(
    `
    INSERT INTO chart_of_accounts
      (organization_id, code, name, account_type_id, category_id, parent_account_id, is_postable, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id, code, name, is_postable, status
    `,
    [
      orgId,
      payload.code,
      payload.name,
      typeId,
      categoryId,
      payload.parentAccountId || null,
      payload.isPostable ?? true,
      payload.status || "active"
    ]
  );
  return rows[0];
}

async function listAccounts({ orgId, includeArchived = false }) {
  const { rows } = await pool.query(
    `
    SELECT
      coa.*,
      at.code AS account_type_code,
      ac.name AS category_name
    FROM chart_of_accounts coa
    JOIN account_types at ON at.id = coa.account_type_id
    LEFT JOIN account_categories ac ON ac.id = coa.category_id
    WHERE coa.organization_id=$1
      AND ($2::boolean = TRUE OR coa.archived_at IS NULL)
    ORDER BY coa.code
    `,
    [orgId, includeArchived]
  );
  return rows;
}

async function getAccount({ orgId, accountId }) {
  const { rows } = await pool.query(
    `
    SELECT
      coa.*,
      at.code AS account_type_code,
      ac.name AS category_name
    FROM chart_of_accounts coa
    JOIN account_types at ON at.id = coa.account_type_id
    LEFT JOIN account_categories ac ON ac.id = coa.category_id
    WHERE coa.organization_id=$1 AND coa.id=$2
    `,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(404, "Account not found");
  return rows[0];
}

async function updateAccount({ orgId, accountId, payload }) {
  // Validate parent if present
  if (payload.parentAccountId !== undefined && payload.parentAccountId !== null) {
    if (String(payload.parentAccountId) === String(accountId)) {
      throw new AppError(400, "Account cannot be its own parent");
    }
    const { rows: p } = await pool.query(
      `SELECT id FROM chart_of_accounts WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL`,
      [orgId, payload.parentAccountId]
    );
    if (!p.length) throw new AppError(400, "Invalid parentAccountId");

    // Prevent circular references: parent cannot be a descendant of this account
    const { rows: cycle } = await pool.query(
      `
      WITH RECURSIVE descendants AS (
        SELECT id, parent_account_id
        FROM chart_of_accounts
        WHERE organization_id=$1 AND id=$2
        UNION ALL
        SELECT c.id, c.parent_account_id
        FROM chart_of_accounts c
        JOIN descendants d ON c.parent_account_id = d.id
        WHERE c.organization_id=$1
      )
      SELECT 1 AS bad
      FROM descendants
      WHERE id=$3
      LIMIT 1
      `,
      [orgId, accountId, payload.parentAccountId]
    );
    if (cycle.length) throw new AppError(400, "Circular parent reference not allowed");
  }
  const categoryId = payload.categoryName ? await upsertCategory(orgId, payload.categoryName) : undefined;

  const { rows: existing } = await pool.query(
    `SELECT * FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!existing.length) throw new AppError(404, "Account not found");

  const next = {
    name: payload.name ?? existing[0].name,
    category_id: categoryId === undefined ? existing[0].category_id : categoryId,
    parent_account_id: payload.parentAccountId === undefined ? existing[0].parent_account_id : payload.parentAccountId,
    is_postable: payload.isPostable ?? existing[0].is_postable,
    status: payload.status ?? existing[0].status
  };

  const { rows } = await pool.query(
    `
    UPDATE chart_of_accounts
    SET name=$3, category_id=$4, parent_account_id=$5, is_postable=$6, status=$7, updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING id, code, name, is_postable, status
    `,
    [orgId, accountId, next.name, next.category_id, next.parent_account_id, next.is_postable, next.status]
  );
  return { before: existing[0], after: rows[0] };
}

async function archiveAccount({ orgId, accountId, actorUserId }) {
  const { rows: beforeRows } = await pool.query(
    `SELECT * FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!beforeRows.length) throw new AppError(404, "Account not found");
  if (beforeRows[0].archived_at) throw new AppError(409, "Account already archived");

  // Do not allow archiving if it has active children (encourage archiving leaves first)
  const { rows: children } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM chart_of_accounts WHERE organization_id=$1 AND parent_account_id=$2 AND archived_at IS NULL`,
    [orgId, accountId]
  );
  if (children[0].n > 0) throw new AppError(409, "Cannot archive: account has active child accounts");

  const { rows: afterRows } = await pool.query(
    `
    UPDATE chart_of_accounts
    SET archived_at=NOW(), archived_by=$3, status='inactive', updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [orgId, accountId, actorUserId]
  );

  return { id: accountId, before: beforeRows[0], after: afterRows[0] };
}


async function getAccountReport({ orgId, accountId, months = 6 }) {
  const monthCount = Math.max(3, Math.min(Number.parseInt(String(months || 6), 10) || 6, 12));
  const { rows: accounts } = await pool.query(
    `SELECT coa.id, coa.code, coa.name, at.code AS account_type_code, at.normal_balance,
            o.base_currency_code
       FROM chart_of_accounts coa
       JOIN account_types at ON at.id=coa.account_type_id
       JOIN organizations o ON o.id=coa.organization_id
      WHERE coa.organization_id=$1 AND coa.id=$2
      LIMIT 1`,
    [orgId, accountId]
  );
  if (!accounts.length) throw new AppError(404, "Account not found");
  const account = accounts[0];

  const { rows: summaryRows } = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN jel.debit > 0 THEN jel.amount_base ELSE 0 END),0)::NUMERIC(18,2) AS debit_total,
       COALESCE(SUM(CASE WHEN jel.credit > 0 THEN jel.amount_base ELSE 0 END),0)::NUMERIC(18,2) AS credit_total,
       COUNT(DISTINCT je.id)::BIGINT AS journal_count,
       MAX(je.entry_date) AS last_activity_date
     FROM journal_entry_lines jel
     JOIN journal_entries je ON je.id=jel.journal_entry_id
     WHERE je.organization_id=$1
       AND jel.account_id=$2
       AND je.status IN ('posted','voided')`,
    [orgId, accountId]
  );
  const summary = summaryRows[0];

  const { rows: trend } = await pool.query(
    `WITH month_series AS (
       SELECT generate_series(
         date_trunc('month', CURRENT_DATE) - (($3::int - 1) * interval '1 month'),
         date_trunc('month', CURRENT_DATE),
         interval '1 month'
       )::date AS month_start
     ), activity AS (
       SELECT date_trunc('month', je.entry_date)::date AS month_start,
              SUM(CASE WHEN jel.debit > 0 THEN jel.amount_base ELSE 0 END)::NUMERIC(18,2) AS debit_total,
              SUM(CASE WHEN jel.credit > 0 THEN jel.amount_base ELSE 0 END)::NUMERIC(18,2) AS credit_total,
              COUNT(DISTINCT je.id)::BIGINT AS journal_count
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id=jel.journal_entry_id
        WHERE je.organization_id=$1
          AND jel.account_id=$2
          AND je.status IN ('posted','voided')
          AND je.entry_date >= date_trunc('month', CURRENT_DATE) - (($3::int - 1) * interval '1 month')
        GROUP BY 1
     )
     SELECT ms.month_start,
            TO_CHAR(ms.month_start, 'Mon') AS month_label,
            COALESCE(a.debit_total,0)::NUMERIC(18,2) AS debit_total,
            COALESCE(a.credit_total,0)::NUMERIC(18,2) AS credit_total,
            CASE WHEN $4='credit'
              THEN (COALESCE(a.credit_total,0)-COALESCE(a.debit_total,0))::NUMERIC(18,2)
              ELSE (COALESCE(a.debit_total,0)-COALESCE(a.credit_total,0))::NUMERIC(18,2)
            END AS net_movement,
            COALESCE(a.journal_count,0)::BIGINT AS journal_count
       FROM month_series ms
       LEFT JOIN activity a ON a.month_start=ms.month_start
      ORDER BY ms.month_start`,
    [orgId, accountId, monthCount, account.normal_balance]
  );

  const { rows: recent } = await pool.query(
    `SELECT je.id AS journal_id, je.entry_no, je.entry_date, je.status,
            jel.line_no, jel.description,
            CASE WHEN jel.debit > 0 THEN jel.amount_base ELSE 0 END::NUMERIC(18,2) AS debit,
            CASE WHEN jel.credit > 0 THEN jel.amount_base ELSE 0 END::NUMERIC(18,2) AS credit,
            CASE WHEN $3='credit'
              THEN (CASE WHEN jel.credit > 0 THEN jel.amount_base ELSE 0 END) - (CASE WHEN jel.debit > 0 THEN jel.amount_base ELSE 0 END)
              ELSE (CASE WHEN jel.debit > 0 THEN jel.amount_base ELSE 0 END) - (CASE WHEN jel.credit > 0 THEN jel.amount_base ELSE 0 END)
            END::NUMERIC(18,2) AS natural_movement
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id=jel.journal_entry_id
      WHERE je.organization_id=$1
        AND jel.account_id=$2
        AND je.status IN ('posted','voided')
      ORDER BY je.entry_date DESC, je.created_at DESC, jel.line_no DESC
      LIMIT 8`,
    [orgId, accountId, account.normal_balance]
  );

  const debitCents = parseDecimalToBigInt(summary.debit_total || 0, 2);
  const creditCents = parseDecimalToBigInt(summary.credit_total || 0, 2);
  const naturalBalanceCents = account.normal_balance === 'credit' ? creditCents - debitCents : debitCents - creditCents;
  const periodDebitCents = trend.reduce((sum, row) => sum + parseDecimalToBigInt(row.debit_total || 0, 2), 0n);
  const periodCreditCents = trend.reduce((sum, row) => sum + parseDecimalToBigInt(row.credit_total || 0, 2), 0n);
  const periodNetCents = trend.reduce((sum, row) => sum + parseDecimalToBigInt(row.net_movement || 0, 2), 0n);

  return {
    account: {
      id: account.id,
      code: account.code,
      name: account.name,
      accountTypeCode: account.account_type_code,
      normalBalance: account.normal_balance,
      currencyCode: account.base_currency_code
    },
    summary: {
      currentBalance: bigIntToDecimalString(naturalBalanceCents, 2),
      debitTotal: bigIntToDecimalString(debitCents, 2),
      creditTotal: bigIntToDecimalString(creditCents, 2),
      journalCount: Number(summary.journal_count || 0),
      lastActivityDate: summary.last_activity_date || null,
      periodDebit: bigIntToDecimalString(periodDebitCents, 2),
      periodCredit: bigIntToDecimalString(periodCreditCents, 2),
      periodNet: bigIntToDecimalString(periodNetCents, 2),
      months: monthCount
    },
    trend,
    recent
  };
}

module.exports = { createAccount, listAccounts, getAccount, getAccountReport, updateAccount, archiveAccount };
