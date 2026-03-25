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
  createTaxRegistrationSchema,
  updateTaxRegistrationSchema,
  createTaxCodeSchema,
  updateTaxCodeSchema,
  createTaxRuleSchema,
  updateTaxRuleSchema,
  setTaxSettingsSchema,
  createTaxAdjustmentSchema,
  voidTaxAdjustmentSchema,
  setTaxCodeComponentsSchema,
  installCountryPackSchema,
  upsertTaxAutomationRuleSchema
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

// Tax Registrations
router.get("/registrations", requirePermission("tax.registration.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const query = {
      registrationType: req.query.registrationType,
      jurisdictionId: req.query.jurisdictionId,
      isPrimary: req.query.isPrimary,
      activeOn: req.query.activeOn
    };
    res.json({ data: await svc.listTaxRegistrations({ orgId, query }) });
  } catch (e) { next(e); }
});

router.post("/registrations", idempotency({ required: true }), requirePermission("tax.registration.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(createTaxRegistrationSchema, req.body);
    const created = await svc.createTaxRegistration({ orgId, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.registration.created",
      entityType: "tax_registrations",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) {
    if (e?.code === "23505") return next(new AppError(409, "Tax registration already exists"));
    next(e);
  }
});

router.patch("/registrations/:id", requirePermission("tax.registration.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(updateTaxRegistrationSchema, req.body);
    const out = await svc.updateTaxRegistration({ orgId, registrationId: req.params.id, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.registration.updated",
      entityType: "tax_registrations",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: out.before,
      after: out.after
    });

    res.json(out.after);
  } catch (e) {
    if (e?.code === "23505") return next(new AppError(409, "Tax registration already exists"));
    next(e);
  }
});

router.delete("/registrations/:id", requirePermission("tax.registration.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await svc.deleteTaxRegistration({ orgId, registrationId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.registration.deleted",
      entityType: "tax_registrations",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e); }
});


// Tax Rules
router.get("/rules", requirePermission("tax.rule.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const query = {
      status: req.query.status,
      documentType: req.query.documentType,
      partnerType: req.query.partnerType,
      transactionScope: req.query.transactionScope,
      jurisdictionId: req.query.jurisdictionId,
      taxCodeId: req.query.taxCodeId,
      activeOn: req.query.activeOn
    };
    res.json({ data: await svc.listTaxRules({ orgId, query }) });
  } catch (e) { next(e); }
});

router.post("/rules", idempotency({ required: true }), requirePermission("tax.rule.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(createTaxRuleSchema, req.body);
    const created = await svc.createTaxRule({ orgId, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.rule.created",
      entityType: "tax_rules",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) {
    if (e?.code === "23505") return next(new AppError(409, "Tax rule already exists"));
    next(e);
  }
});

router.patch("/rules/:id", requirePermission("tax.rule.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(updateTaxRuleSchema, req.body);
    const out = await svc.updateTaxRule({ orgId, ruleId: req.params.id, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.rule.updated",
      entityType: "tax_rules",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: out.before,
      after: out.after
    });

    res.json(out.after);
  } catch (e) {
    if (e?.code === "23505") return next(new AppError(409, "Tax rule already exists"));
    next(e);
  }
});

router.delete("/rules/:id", requirePermission("tax.rule.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await svc.deleteTaxRule({ orgId, ruleId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.rule.deleted",
      entityType: "tax_rules",
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



router.get("/country-packs", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json({ data: await svc.listCountryPacks({ orgId }) });
  } catch (e) { next(e); }
});

router.post("/country-packs/install", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(installCountryPackSchema, req.body);
    const out = await svc.installCountryPack({ orgId, actorUserId: req.user.id, payload });
    res.json(out);
  } catch (e) { next(e); }
});

router.get("/automation-rules", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json({ data: await svc.listAutomationRules({ orgId }) });
  } catch (e) { next(e); }
});

router.put("/automation-rules", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(upsertTaxAutomationRuleSchema, req.body);
    const out = await svc.upsertAutomationRule({ orgId, actorUserId: req.user.id, payload });
    res.json(out);
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
