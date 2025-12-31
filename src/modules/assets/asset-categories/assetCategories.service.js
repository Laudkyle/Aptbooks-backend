const repo = require("./assetCategories.repository");
const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");

async function assertPostableActiveAccount({ orgId, accountId, label }) {
  const { rows } = await pool.query(
    `SELECT is_postable, status FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(400, `Invalid ${label}`);
  if (!rows[0].is_postable) throw new AppError(400, `${label} must be postable`);
  if (rows[0].status !== "active") throw new AppError(400, `${label} must be active`);
}

async function createCategory({ orgId, actorUserId, payload }) {
  await assertPostableActiveAccount({ orgId, accountId: payload.assetAccountId, label: "assetAccountId" });
  await assertPostableActiveAccount({ orgId, accountId: payload.accumDeprAccountId, label: "accumDeprAccountId" });
  await assertPostableActiveAccount({ orgId, accountId: payload.deprExpenseAccountId, label: "deprExpenseAccountId" });

  return repo.createCategory({ orgId, payload });
}

async function listCategories({ orgId }) {
  return repo.listCategories({ orgId });
}

module.exports = { createCategory, listCategories };
