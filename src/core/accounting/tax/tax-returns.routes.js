const express = require("express");

const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const { validate } = require("../../../shared/validators/validate");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../../foundation/audit-logs/audit.service");

const svc = require("./tax.service");
const ghVatSvc = require("./ghanaVat.service");
const ghWithholdingSvc = require("./ghanaWithholding.service");
const ghCitSvc = require("./ghanaCit.service");

function getOrganizationId(req) {
  const orgId = req.user?.organization_id || req.user?.organizationId || req.user?.org_id || req.user?.orgId || null;
  if (!orgId) throw new AppError(401, "Authenticated user is missing organization context");
  return orgId;
}
const {
  createJurisdictionSchema,
  updateJurisdictionSchema,
  createTaxRegistrationSchema,
  updateTaxRegistrationSchema,
  createTaxCodeSchema,
  updateTaxCodeSchema,
  createTaxRuleSchema,
  updateTaxRuleSchema,
  createTaxCatalogProfileSchema,
  updateTaxCatalogProfileSchema,
  setTaxSettingsSchema,
  createTaxAdjustmentSchema,
  voidTaxAdjustmentSchema,
  setTaxCodeComponentsSchema,
  installCountryPackSchema,
  upsertTaxAutomationRuleSchema,
  createPartnerTaxProfileSchema,
  updatePartnerTaxProfileSchema,
  createTaxReturnTemplateSchema,
  updateTaxReturnTemplateSchema,
  createTaxReturnSchema,
  submitTaxReturnSchema,
  updateTaxReturnConfigSchema,
  updateEinvoicingSettingsSchema,
  createFilingAdapterSchema,
  updateFilingAdapterSchema,
  createWithholdingRemittanceSchema,
  updateWithholdingRemittanceSchema,
  postWithholdingRemittanceSchema,
  createWithholdingCertificateSchema,
  updateWithholdingCertificateSchema,
  postWithholdingCertificateSchema,
  voidWithholdingWorkflowSchema,
  calculateInputApportionmentSchema,
  postInputApportionmentSchema,
  voidInputApportionmentSchema,
  createImportedServiceSchema,
  updateImportedServiceSchema,
  voidImportedServiceSchema,
  ghWithholdingPreviewSchema,
  ghWithholdingEventSchema,
  ghReceivedWithholdingCertificateSchema,
  ghWithholdingReturnSchema,
  ghWithholdingFiledSchema,
  ghWithholdingRemittanceSchema,
  ghWithholdingPostRemittanceSchema
} = require("./tax.validators");

const router = express.Router();

// ==================== PARTNER TAX PROFILES ====================
router.get("/partner-profiles", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.listPartnerTaxProfiles({ orgId, query: req.query });
    res.json({ data });
  } catch (e) { next(e); }
});

router.get("/partner-profiles/:id", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.getPartnerTaxProfile({ orgId, profileId: req.params.id });
    res.json({ data });
  } catch (e) { next(e); }
});

router.post("/partner-profiles", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(createPartnerTaxProfileSchema, req.body);
    const created = await svc.createPartnerTaxProfile({ orgId, actorUserId: req.user.id, payload });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.partner_profile.created",
      entityType: "partner_tax_profiles",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });
    
    res.status(201).json({ data: created });
  } catch (e) { next(e); }
});

router.patch("/partner-profiles/:id", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(updatePartnerTaxProfileSchema, req.body);
    const updated = await svc.updatePartnerTaxProfile({ orgId, profileId: req.params.id, payload, actorUserId: req.user.id });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.partner_profile.updated",
      entityType: "partner_tax_profiles",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: updated
    });
    
    res.json({ data: updated });
  } catch (e) { next(e); }
});

router.delete("/partner-profiles/:id", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const result = await svc.deletePartnerTaxProfile({ orgId, profileId: req.params.id });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.partner_profile.deleted",
      entityType: "partner_tax_profiles",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: result
    });
    
    res.json(result);
  } catch (e) { next(e); }
});

// ==================== TAX RETURN TEMPLATES ====================
router.get("/returns/templates", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.listTaxReturnTemplates({ orgId, query: req.query });
    res.json({ data });
  } catch (e) { next(e); }
});

router.get("/returns/templates/:id", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.getTaxReturnTemplate({ orgId, templateId: req.params.id });
    res.json({ data });
  } catch (e) { next(e); }
});

router.post("/returns/templates", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(createTaxReturnTemplateSchema, req.body);
    const created = await svc.createTaxReturnTemplate({ orgId, actorUserId: req.user.id, payload });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.return_template.created",
      entityType: "tax_return_templates",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });
    
    res.status(201).json({ data: created });
  } catch (e) { next(e); }
});

router.patch("/returns/templates/:id", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(updateTaxReturnTemplateSchema, req.body);
    const updated = await svc.updateTaxReturnTemplate({ orgId, templateId: req.params.id, payload, actorUserId: req.user.id });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.return_template.updated",
      entityType: "tax_return_templates",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: updated
    });
    
    res.json({ data: updated });
  } catch (e) { next(e); }
});

router.delete("/returns/templates/:id", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const result = await svc.deleteTaxReturnTemplate({ orgId, templateId: req.params.id });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.return_template.deleted",
      entityType: "tax_return_templates",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: result
    });
    
    res.json(result);
  } catch (e) { next(e); }
});

// ==================== TAX RETURN CONFIGURATION ====================
router.get("/returns/config", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.getTaxReturnConfig({ orgId });
    res.json({ data });
  } catch (e) { next(e); }
});

router.put("/returns/config", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(updateTaxReturnConfigSchema, req.body);
    const updated = await svc.updateTaxReturnConfig({ orgId, payload, actorUserId: req.user.id });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.return_config.updated",
      entityType: "tax_return_config",
      entityId: orgId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: updated
    });
    
    res.json({ data: updated });
  } catch (e) { next(e); }
});

// ==================== TAX RETURNS ====================
router.get("/returns", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.listTaxReturns({ orgId, query: req.query });
    res.json({ data });
  } catch (e) { next(e); }
});

router.get("/returns/:id", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.getTaxReturn({ orgId, returnId: req.params.id });
    res.json({ data });
  } catch (e) { next(e); }
});

router.post("/returns", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(createTaxReturnSchema, req.body);
    const created = await svc.createTaxReturn({ orgId, actorUserId: req.user.id, payload });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.return.created",
      entityType: "tax_returns",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });
    
    res.status(201).json({ data: created });
  } catch (e) { next(e); }
});

router.post("/returns/:id/submit", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(submitTaxReturnSchema, req.body);
    const result = await svc.submitTaxReturn({ orgId, returnId: req.params.id, payload, actorUserId: req.user.id });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.return.submitted",
      entityType: "tax_returns",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: result
    });
    
    res.json({ data: result });
  } catch (e) { next(e); }
});

// ==================== E-INVOICING ====================
router.get("/einvoicing/settings", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.getEinvoicingSettings({ orgId });
    res.json({ data });
  } catch (e) { next(e); }
});

router.put("/einvoicing/settings", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(updateEinvoicingSettingsSchema, req.body);
    const updated = await svc.updateEinvoicingSettings({ orgId, payload, actorUserId: req.user.id });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.einvoicing.updated",
      entityType: "einvoicing_settings",
      entityId: orgId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: updated
    });
    
    res.json({ data: updated });
  } catch (e) { next(e); }
});

// ==================== FILING ADAPTERS ====================
router.get("/filing-adapters", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.listFilingAdapters({ orgId, query: req.query });
    res.json({ data });
  } catch (e) { next(e); }
});

router.get("/filing-adapters/:id", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.getFilingAdapter({ orgId, adapterId: req.params.id });
    res.json({ data });
  } catch (e) { next(e); }
});

router.post("/filing-adapters", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(createFilingAdapterSchema, req.body);
    const created = await svc.createFilingAdapter({ orgId, actorUserId: req.user.id, payload });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.filing_adapter.created",
      entityType: "filing_adapters",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });
    
    res.status(201).json({ data: created });
  } catch (e) { next(e); }
});

router.patch("/filing-adapters/:id", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(updateFilingAdapterSchema, req.body);
    const updated = await svc.updateFilingAdapter({ orgId, adapterId: req.params.id, payload, actorUserId: req.user.id });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.filing_adapter.updated",
      entityType: "filing_adapters",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: updated
    });
    
    res.json({ data: updated });
  } catch (e) { next(e); }
});

router.delete("/filing-adapters/:id", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const result = await svc.deleteFilingAdapter({ orgId, adapterId: req.params.id });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.filing_adapter.deleted",
      entityType: "filing_adapters",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: result
    });
    
    res.json(result);
  } catch (e) { next(e); }
});

router.post("/filing-adapters/:id/test", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const result = await svc.testFilingAdapter({ orgId, adapterId: req.params.id, actorUserId: req.user.id });
    res.json({ data: result });
  } catch (e) { next(e); }
});

module.exports = router;
