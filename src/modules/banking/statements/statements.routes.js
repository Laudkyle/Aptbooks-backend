const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const svc = require("./statements.service");

router.use(authRequired);

router.get("/", requirePermission("banking.statements.read"), async (req, res, next) => {
  try { res.json(await svc.listStatements(req.user.organization_id)); }
  catch (e) { next(e); }
});

router.post("/", idempotency({ required: true }), requirePermission("banking.statements.manage"), async (req, res, next) => {
  try {
    const created = await svc.createStatement(req.user.organization_id, req.user.id, req.body);
    res.status(201).json(created);
  } catch (e) { next(e); }
});

router.post("/:statementId/lines", idempotency({ required: true }), requirePermission("banking.statements.manage"), async (req, res, next) => {
  try {
    const lines = await svc.addLines(req.user.organization_id, req.user.id, req.params.statementId, req.body.lines);
    res.status(201).json(lines);
  } catch (e) { next(e); }
});

router.post("/lines/:lineId/match", idempotency({ required: true }), requirePermission("banking.reconciliation.run"), async (req, res, next) => {
  try {
    const updated = await svc.matchLine(req.user.organization_id, req.user.id, req.params.lineId, req.body);
    res.json(updated);
  } catch (e) { next(e); }
});

module.exports = router;
