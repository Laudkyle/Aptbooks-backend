const express = require("express");

const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const { validate } = require("../../../shared/validators/validate");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../../foundation/audit-logs/audit.service");

const svc = require("./tax.service");
const {
  createJurisdictionSchema,
  updateJurisdictionSchema,
  createTaxCodeSchema,
  updateTaxCodeSchema,
  setTaxSettingsSchema,
  createTaxAdjustmentSchema,
  voidTaxAdjustmentSchema,
  setTaxCodeComponentsSchema
} = require("./tax.validators");

const router = express.Router();
router.use(authRequired);

// Admin CRUD for VAT/GST tax setup
router.use(requirePermission("tax.read"));

// Jurisdictions
router.get("/jurisdictions", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json({ data: await svc.listJurisdictions({ orgId }) });
  } catch (e) { next(e); }
});

router.post("/jurisdictions", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(createJurisdictionSchema, req.body);
    const created = await svc.createJurisdiction({ orgId, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.jurisdiction.created",
      entityType: "tax_jurisdictions",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) {
    if (e?.code === "23505") return next(new AppError(409, "Tax jurisdiction already exists"));
    next(e);
  }
});

router.patch("/jurisdictions/:id", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(updateJurisdictionSchema, req.body);
    const out = await svc.updateJurisdiction({ orgId, jurisdictionId: req.params.id, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.jurisdiction.updated",
      entityType: "tax_jurisdictions",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: out.before,
      after: out.after
    });

    res.json(out.after);
  } catch (e) {
    if (e?.code === "23505") return next(new AppError(409, "Tax jurisdiction already exists"));
    next(e);
  }
});

router.delete("/jurisdictions/:id", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await svc.deleteJurisdiction({ orgId, jurisdictionId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.jurisdiction.deleted",
      entityType: "tax_jurisdictions",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e); }
});

// Tax Codes
router.get("/codes", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const query = {
      status: req.query.status,
      taxType: req.query.taxType,
      jurisdictionId: req.query.jurisdictionId
    };
    res.json({ data: await svc.listTaxCodes({ orgId, query }) });
  } catch (e) { next(e); }
});

router.post("/codes", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(createTaxCodeSchema, req.body);
    const created = await svc.createTaxCode({ orgId, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.code.created",
      entityType: "tax_codes",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) {
    if (e?.code === "23505") return next(new AppError(409, "Tax code already exists"));
    next(e);
  }
});

router.patch("/codes/:id", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(updateTaxCodeSchema, req.body);
    const out = await svc.updateTaxCode({ orgId, taxCodeId: req.params.id, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.code.updated",
      entityType: "tax_codes",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: out.before,
      after: out.after
    });

    res.json(out.after);
  } catch (e) {
    if (e?.code === "23505") return next(new AppError(409, "Tax code already exists"));
    next(e);
  }
});

router.delete("/codes/:id", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await svc.deleteTaxCode({ orgId, taxCodeId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.code.deleted",
      entityType: "tax_codes",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e); }
});


router.get("/codes/:id/components", requirePermission("tax.component.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const data = await svc.listTaxCodeComponents({ orgId, taxCodeId: req.params.id });
    res.json({ data });
  } catch (e) { next(e); }
});

router.put("/codes/:id/components", requirePermission("tax.component.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(setTaxCodeComponentsSchema, req.body);
    const data = await svc.setTaxCodeComponents({ orgId, taxCodeId: req.params.id, payload });
    res.json({ data });
  } catch (e) { next(e); }
});

// Settings
router.get("/settings", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json({ data: await svc.getTaxSettings({ orgId }) });
  } catch (e) { next(e); }
});

router.put("/settings", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(setTaxSettingsSchema, req.body);
    const updated = await svc.setTaxSettings({ orgId, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.settings.updated",
      entityType: "tax_settings",
      entityId: orgId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: updated
    });

    res.json(updated);
  } catch (e) { next(e); }
});


// Tax adjustments
router.get("/adjustments", requirePermission("tax.adjustment.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const data = await svc.listTaxAdjustments({
      orgId,
      query: {
        status: req.query.status,
        taxType: req.query.taxType,
        direction: req.query.direction,
        fromDate: req.query.from,
        toDate: req.query.to
      }
    });
    res.json({ data });
  } catch (e) { next(e); }
});

router.post("/adjustments", idempotency({ required: true }), requirePermission("tax.adjustment.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(createTaxAdjustmentSchema, req.body);
    const created = await svc.createTaxAdjustment({ orgId, actorUserId: req.user.id, payload });
    await writeAudit({
      organizationId: orgId, actorUserId: req.user.id, action: "tax.adjustment.created",
      entityType: "tax_adjustment", entityId: created.id, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: created
    });
    res.status(201).json({ data: created });
  } catch (e) { next(e); }
});

router.post("/adjustments/:id/post", idempotency({ required: true }), requirePermission("tax.adjustment.post"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const data = await svc.postTaxAdjustment({ orgId, actorUserId: req.user.id, adjustmentId: req.params.id });
    await writeAudit({
      organizationId: orgId, actorUserId: req.user.id, action: "tax.adjustment.posted",
      entityType: "tax_adjustment", entityId: data.id, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: data
    });
    res.json({ data });
  } catch (e) { next(e); }
});

router.post("/adjustments/:id/void", idempotency({ required: true }), requirePermission("tax.adjustment.void"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(voidTaxAdjustmentSchema, req.body);
    const data = await svc.voidTaxAdjustment({ orgId, actorUserId: req.user.id, adjustmentId: req.params.id, reason: payload.reason });
    await writeAudit({
      organizationId: orgId, actorUserId: req.user.id, action: "tax.adjustment.voided",
      entityType: "tax_adjustment", entityId: data.id, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: data
    });
    res.json({ data });
  } catch (e) { next(e); }
});

module.exports = router;
