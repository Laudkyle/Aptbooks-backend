const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");

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
      `SELECT id FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
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

async function listAccounts({ orgId }) {
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
    ORDER BY coa.code
    `,
    [orgId]
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
    const { rows: p } = await pool.query(
      `SELECT id FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.parentAccountId]
    );
    if (!p.length) throw new AppError(400, "Invalid parentAccountId");
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

module.exports = { createAccount, listAccounts, getAccount, updateAccount };
