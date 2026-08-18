const express = require("express");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const { validate } = require("../../../shared/validators/validate");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");

function createOpsDocRouter(config) {
  const router = express.Router();
  const {
    service,
    createSchema,
    voidSchema,
    permissionPrefix,
    entityType,
    finalAction = "issue"
  } = config;

  router.use(authRequired);

  router.post("/", idempotency({ required: true }), requirePermission(`${permissionPrefix}.manage`), async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const payload = validate(createSchema, req.body || {});
      const created = await service.createDraft({ orgId, actorUserId, payload });
      await writeAudit({ organizationId: orgId, actorUserId, action: `${entityType}.created`, entityType, entityId: created.id, after: created, ip: req.audit?.ip, userAgent: req.audit?.userAgent });
      res.status(201).json(created);
    } catch (e) { next(e); }
  });

  router.get("/", requirePermission(`${permissionPrefix}.read`), async (req, res, next) => {
    try {
      res.json(await service.list({ orgId: req.user.organization_id, query: req.query }));
    } catch (e) { next(e); }
  });

  router.get("/:id", requirePermission(`${permissionPrefix}.read`), async (req, res, next) => {
    try {
      res.json(await service.getDetails({ orgId: req.user.organization_id, documentId: req.params.id, currentUserId: req.user.id }));
    } catch (e) { next(e); }
  });

  router.post("/:id/submit-for-approval", idempotency({ required: true }), requirePermission(`${permissionPrefix}.manage`), async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const out = await service.submitForApproval({ orgId, actorUserId, documentId: req.params.id });
      await writeAudit({ organizationId: orgId, actorUserId, action: `${entityType}.submitted_for_approval`, entityType, entityId: req.params.id, after: out.document, ip: req.audit?.ip, userAgent: req.audit?.userAgent });
      res.json(out);
    } catch (e) { next(e); }
  });

  router.post("/:id/approve", idempotency({ required: true }), requirePermission("approvals.act"), async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const out = await service.approveWorkflow({ orgId, actorUserId, documentId: req.params.id, comment: req.body?.comment });
      await writeAudit({ organizationId: orgId, actorUserId, action: `${entityType}.approved`, entityType, entityId: req.params.id, after: out.document, ip: req.audit?.ip, userAgent: req.audit?.userAgent });
      res.json(out);
    } catch (e) { next(e); }
  });

  router.post("/:id/reject", idempotency({ required: true }), requirePermission("approvals.act"), async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const out = await service.rejectWorkflow({ orgId, actorUserId, documentId: req.params.id, comment: req.body?.comment });
      await writeAudit({ organizationId: orgId, actorUserId, action: `${entityType}.rejected`, entityType, entityId: req.params.id, after: out.document, ip: req.audit?.ip, userAgent: req.audit?.userAgent });
      res.json(out);
    } catch (e) { next(e); }
  });

  router.post(`/:id/${finalAction}`, idempotency({ required: true }), requirePermission(`${permissionPrefix}.${finalAction}`), async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const out = await service.finalize({ orgId, actorUserId, documentId: req.params.id });
      res.json(out);
    } catch (e) { next(e); }
  });

  router.post("/:id/void", idempotency({ required: true }), requirePermission(`${permissionPrefix}.void`), async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const payload = validate(voidSchema, req.body || {});
      const out = await service.voidDocument({ orgId, actorUserId, documentId: req.params.id, reason: payload.reason });
      res.json(out);
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = {
  createOpsDocRouter
};
