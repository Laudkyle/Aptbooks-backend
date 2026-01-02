const repo = require("./reconciliations.repository");
const { AppError } = require("../../../shared/errors/AppError");
const { pool } = require("../../../db/pool");

async function reconcile(orgId, userId, payload) {
  const req=["bankAccountId","periodId"];
  for (const k of req) if (!payload?.[k]) throw new AppError(400, `${k} is required`);
  // Ensure period open or closed allowed? We'll allow open only.
  const { rows: p } = await pool.query(
    `SELECT status FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, payload.periodId]
  );
  if (!p.length) throw new AppError(404, "Period not found");
  if (p[0].status !== "open") throw new AppError(409, "Period not open");
  return repo.create(orgId, userId, payload);
}

module.exports = { reconcile };
