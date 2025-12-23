const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { validate } = require("../../../shared/validators/validate");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");

const svc = require("./partners.service");
const {
  createPartnerSchema,
  updatePartnerSchema,
  listPartnersQuerySchema
} = require("../../../shared/validators/business/partners.validators");

router.use(authRequired);

router.post("/", requirePermission("partners.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(createPartnerSchema, req.body);
    const created = await svc.createPartner({ orgId, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "partner.created",
      entityType: "business_partners",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) {
    if (e?.code === "23505") return next(new AppError(409, "Partner already exists"));
    next(e);
  }
});

router.get("/", requirePermission("partners.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const query = validate(listPartnersQuerySchema, req.query);
    res.json(await svc.listPartners({ orgId, query }));
  } catch (e) { next(e); }
});

router.get("/:id", requirePermission("partners.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getPartnerDetails({ orgId, partnerId: req.params.id }));
  } catch (e) { next(e); }
});

router.patch("/:id", requirePermission("partners.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(updatePartnerSchema, req.body);
    const out = await svc.updatePartner({ orgId, partnerId: req.params.id, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "partner.updated",
      entityType: "business_partners",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: out.before,
      after: out.after
    });

    res.json(out.after);
  } catch (e) {
    if (e?.code === "23505") return next(new AppError(409, "Partner already exists"));
    next(e);
  }
});

module.exports = router;
