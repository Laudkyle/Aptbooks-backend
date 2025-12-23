const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { AppError } = require("../../../shared/errors/AppError");
const { pool } = require("../../../db/pool");
const svc = require("./balances.service");

router.use(authRequired);

async function assertPeriod(orgId, periodId) {
  const { rows } = await pool.query(
    `SELECT id FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!rows.length) throw new AppError(400, "Invalid periodId");
}

router.get("/trial-balance", requirePermission("accounting.balances.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { periodId } = req.query;
    if (!periodId) throw new AppError(400, "periodId required");
    await assertPeriod(orgId, periodId);
    res.json(await svc.trialBalance({ orgId, periodId }));
  } catch (e) { next(e); }
});

router.get("/gl", requirePermission("accounting.balances.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { periodId } = req.query;
    if (!periodId) throw new AppError(400, "periodId required");
    await assertPeriod(orgId, periodId);
    res.json(await svc.glBalances({ orgId, periodId }));
  } catch (e) { next(e); }
});

router.get("/account-activity", requirePermission("accounting.balances.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { accountId, from, to } = req.query;
    if (!accountId || !from || !to) throw new AppError(400, "accountId, from, to are required");
    res.json(await svc.accountActivity({ orgId, accountId, fromDate: from, toDate: to }));
  } catch (e) { next(e); }
});

module.exports = router;
