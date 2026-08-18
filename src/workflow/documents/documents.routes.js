const express = require("express");
const router = express.Router();

const { authRequired } = require("../../middleware/auth.middleware");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const { validate } = require("../../shared/validators/validate");
const { AppError } = require("../../shared/errors/AppError");
const {
  writeAudit,
} = require("../../core/foundation/audit-logs/audit.service");
const { env } = require("../../config/env");
const entityResolver = require("../../interfaces/entityResolver.interface");
const svc = require("./documents.service");
const {
  createDocumentSchema,
  listDocumentsQuerySchema,
  submitDocumentSchema,
  approvalActionSchema,
  createDocumentTypeSchema,
  createApprovalLevelSchema,
  setDocumentTypeApprovalLevelsSchema,
  setApprovalLevelUsersSchema,
} = require("./documents.validators");

router.use(authRequired);

// Supported entity types for document linking (informational)
router.get(
  "/entity-types",
  requirePermission("documents.read"),
  async (req, res) => {
    res.json({ supported: entityResolver.listSupportedEntityTypes() });
  },
);

// -----------------------------------------------------------------------------
// Configuration (org-scoped)
// -----------------------------------------------------------------------------
router.post(
  "/types",
  idempotency({ required: true }),
  requirePermission("documents.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const payload = validate(createDocumentTypeSchema, req.body);
      const created = await svc.createDocumentType({ orgId, payload });
      await writeAudit({
        organizationId: orgId,
        actorUserId: req.user.id,
        action: "document_type.created",
        entityType: "document_types",
        entityId: created.id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: created,
      });
      res.status(201).json(created);
    } catch (e) {
      if (e?.code === "23505")
        return next(new AppError(409, "Document type already exists"));
      next(e);
    }
  },
);

router.get(
  "/types",
  requirePermission("documents.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      res.json(await svc.listDocumentTypes({ orgId }));
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/approval-levels",
  idempotency({ required: true }),
  requirePermission("documents.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const payload = validate(createApprovalLevelSchema, req.body);
      const created = await svc.createApprovalLevel({ orgId, payload });
      await writeAudit({
        organizationId: orgId,
        actorUserId: req.user.id,
        action: "approval_level.created",
        entityType: "approval_levels",
        entityId: created.id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: created,
      });
      res.status(201).json(created);
    } catch (e) {
      if (e?.code === "23505")
        return next(
          new AppError(409, "Approval level code/sequence already exists"),
        );
      next(e);
    }
  },
);

router.get(
  "/approval-levels",
  requirePermission("documents.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      res.json(await svc.listApprovalLevels({ orgId }));
    } catch (e) {
      next(e);
    }
  },
);

router.put(
  "/approval-levels/global",
  requirePermission("documents.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const body = validate(setDocumentTypeApprovalLevelsSchema, req.body);
      const result = await svc.setGlobalApprovalLevels({
        orgId,
        approvalLevelIds: body.approval_level_ids,
      });
      await writeAudit({
        organizationId: orgId,
        actorUserId: req.user.id,
        action: "document_workflow.global_approval_levels_set",
        entityType: "document_workflow",
        entityId: orgId,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: body,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/approval-levels/global",
  requirePermission("documents.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const ladder = await svc.getGlobalApprovalLadder({ orgId });
      res.json(ladder);
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/approval-levels/:levelId/users",
  requirePermission("documents.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const users = await svc.getApprovalLevelUsers({
        orgId,
        levelId: req.params.levelId,
      });
      res.json(users);
    } catch (e) {
      next(e);
    }
  },
);

router.put(
  "/approval-levels/:levelId/users",
  requirePermission("documents.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const body = validate(setApprovalLevelUsersSchema, req.body);
      const result = await svc.setApprovalLevelUsers({
        orgId,
        levelId: req.params.levelId,
        userIds: body.user_ids,
      });
      await writeAudit({
        organizationId: orgId,
        actorUserId: req.user.id,
        action: "approval_level.users_set",
        entityType: "approval_levels",
        entityId: req.params.levelId,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: body,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);
router.put(
  "/types/:typeId/approval-levels",
  requirePermission("documents.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const body = validate(setDocumentTypeApprovalLevelsSchema, req.body);
      const result = await svc.setDocumentTypeApprovalLevels({
        orgId,
        documentTypeId: req.params.typeId,
        approvalLevelIds: body.approval_level_ids,
      });
      await writeAudit({
        organizationId: orgId,
        actorUserId: req.user.id,
        action: "document_type.approval_levels_set",
        entityType: "document_types",
        entityId: req.params.typeId,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: body,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);
router.get(
  "/types/:typeId/approval-levels",
  requirePermission("documents.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const ladder = await svc.getDocumentTypeLadder({
        orgId,
        documentTypeId: req.params.typeId,
      });
      res.json(ladder);
    } catch (e) {
      next(e);
    }
  },
);
// Create document metadata (DRAFT)
router.post(
  "/",
  idempotency({ required: true }),
  requirePermission("documents.create"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const payload = validate(createDocumentSchema, req.body);
      const created = await svc.createDocument({
        orgId,
        userId: req.user.id,
        payload,
      });

      await writeAudit({
        organizationId: orgId,
        actorUserId: req.user.id,
        action: "document.created",
        entityType: "documents",
        entityId: created.id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: created,
      });

      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  },
);

// List documents (optionally by entity)
router.get("/", requirePermission("documents.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const query = validate(listDocumentsQuerySchema, req.query);
    res.json(await svc.listDocuments({ orgId, query }));
  } catch (e) {
    next(e);
  }
});

// Document details (versions + approvals)
router.get(
  "/:id",
  requirePermission("documents.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      res.json(
        await svc.getDocumentDetails({ orgId, documentId: req.params.id }),
      );
    } catch (e) {
      next(e);
    }
  },
);

// Upload new version (application/octet-stream)
router.post(
  "/:id/versions",
  idempotency({ required: true }),
  requirePermission("documents.create"),
  express.raw({
    type: "application/octet-stream",
    limit: `${env.FILE_UPLOAD_MAX_MB}mb`,
  }),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const documentId = req.params.id;
      const originalFilename = req.headers["x-filename"];
      const mimeType = req.headers["content-type"];
      if (!originalFilename)
        throw new AppError(400, "Missing x-filename header");
      if (!Buffer.isBuffer(req.body) || req.body.length === 0)
        throw new AppError(400, "Empty upload body");

      const result = await svc.addVersionFromBuffer({
        orgId,
        documentId,
        userId: req.user.id,
        originalFilename,
        mimeType,
        buffer: req.body,
      });

      await writeAudit({
        organizationId: orgId,
        actorUserId: req.user.id,
        action: "document.version_uploaded",
        entityType: "documents",
        entityId: documentId,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: {
          version_no: result.version.version_no,
          version_id: result.version.id,
        },
      });

      res.status(201).json(result.version);
    } catch (e) {
      next(e);
    }
  },
);

// Download a version
router.get(
  "/:id/versions/:versionId/download",
  requirePermission("documents.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const { version, stream } = await svc.getVersionStream({
        orgId,
        documentId: req.params.id,
        versionId: req.params.versionId,
      });
      res.setHeader(
        "Content-Type",
        version.mime_type || "application/octet-stream",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=\"${version.original_filename}\"`,
      );
      stream.on("error", (err) => next(err));
      stream.pipe(res);
    } catch (e) {
      next(e);
    }
  },
);

// Submit for approval (creates multi-level approval records)
router.post(
  "/:id/submit",
  idempotency({ required: true }),
  requirePermission("documents.create"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      validate(submitDocumentSchema, req.body || {});
      const result = await svc.submitDocument({
        orgId,
        documentId: req.params.id,
        actorUserId: req.user.id,
      });

      await writeAudit({
        organizationId: orgId,
        actorUserId: req.user.id,
        action: "document.submitted",
        entityType: "documents",
        entityId: req.params.id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: { state: "SUBMITTED" },
      });

      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

// Approve current level
router.post(
  "/:id/approve",
  idempotency({ required: true }),
  requirePermission("approvals.act"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const body = validate(approvalActionSchema, req.body || {});
      const result = await svc.approveDocument({
        orgId,
        documentId: req.params.id,
        userId: req.user.id,
        comment: body.comment,
      });

      await writeAudit({
        organizationId: orgId,
        actorUserId: req.user.id,
        action: "document.approved_step",
        entityType: "documents",
        entityId: req.params.id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: {
          approval_id: result.approval?.id,
          document_state: result.document?.workflow_state_code,
        },
      });

      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

// Reject current level
router.post(
  "/:id/reject",
  idempotency({ required: true }),
  requirePermission("approvals.act"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const body = validate(approvalActionSchema, req.body || {});
      const result = await svc.rejectDocument({
        orgId,
        documentId: req.params.id,
        userId: req.user.id,
        comment: body.comment,
      });

      await writeAudit({
        organizationId: orgId,
        actorUserId: req.user.id,
        action: "document.rejected_step",
        entityType: "documents",
        entityId: req.params.id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: {
          approval_id: result.approval?.id,
          document_state: result.document?.workflow_state_code,
        },
      });

      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

module.exports = router;
