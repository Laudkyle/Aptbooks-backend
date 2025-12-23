const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { validate } = require("../../../shared/validators/validate");
const { coaCreateSchema, coaUpdateSchema } = require("../../../shared/validators/accounting.validators");
const svc = require("./coa.service");
const { writeAudit } = require("../../foundation/audit-logs/audit.service");

router.use(authRequired);

router.post("/", requirePermission("accounting.coa.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(coaCreateSchema, req.body);
    const created = await svc.createAccount({ orgId, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "coa.created",
      entityType: "chart_of_accounts",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) { next(e); }
});

router.get("/", requirePermission("accounting.journal.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listAccounts({ orgId }));
  } catch (e) { next(e); }
});

router.get("/:id", requirePermission("accounting.journal.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getAccount({ orgId, accountId: req.params.id }));
  } catch (e) { next(e); }
});

router.patch("/:id", requirePermission("accounting.coa.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(coaUpdateSchema, req.body);

    const { before, after } = await svc.updateAccount({ orgId, accountId: req.params.id, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "coa.updated",
      entityType: "chart_of_accounts",
      entityId: after.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before,
      after
    });

    res.json(after);
  } catch (e) { next(e); }
});

module.exports = router;
