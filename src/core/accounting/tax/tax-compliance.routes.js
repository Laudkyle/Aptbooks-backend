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

// ==================== GHANA VAT COMPLIANCE (GRA-2) ====================
router.get('/ghana/vat/registration-monitor', requirePermission('tax.read'), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json(await ghVatSvc.getVatRegistrationMonitor({ orgId, asOfDate: req.query.asOfDate || null }));
  } catch (e) { next(e); }
});

router.get('/ghana/vat/apportionments', requirePermission('tax.read'), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json({ data: await ghVatSvc.listInputApportionments({ orgId, query: req.query || {} }) });
  } catch (e) { next(e); }
});

router.post('/ghana/vat/apportionments/calculate', requirePermission('tax.manage'), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(calculateInputApportionmentSchema, req.body);
    const out = await ghVatSvc.calculateInputApportionment({ orgId, actorUserId: req.user.id, payload });
    await writeAudit({ organizationId: orgId, actorUserId: req.user.id, action: 'tax.ghana.input_apportionment.calculated', entityType: 'tax_input_apportionment_periods', entityId: out.id, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: out });
    res.json(out);
  } catch (e) { next(e); }
});

router.post('/ghana/vat/apportionments/:id/post', idempotency({ required: true }), requirePermission('tax.manage'), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(postInputApportionmentSchema, req.body || {});
    const out = await ghVatSvc.postInputApportionment({ orgId, actorUserId: req.user.id, apportionmentId: req.params.id, payload });
    await writeAudit({ organizationId: orgId, actorUserId: req.user.id, action: 'tax.ghana.input_apportionment.posted', entityType: 'tax_input_apportionment_periods', entityId: out.id, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: out });
    res.json(out);
  } catch (e) { next(e); }
});

router.post('/ghana/vat/apportionments/:id/void', idempotency({ required: true }), requirePermission('tax.manage'), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(voidInputApportionmentSchema, req.body || {});
    const out = await ghVatSvc.voidInputApportionment({ orgId, actorUserId: req.user.id, apportionmentId: req.params.id, reason: payload.reason });
    await writeAudit({ organizationId: orgId, actorUserId: req.user.id, action: 'tax.ghana.input_apportionment.voided', entityType: 'tax_input_apportionment_periods', entityId: out.id, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: out });
    res.json(out);
  } catch (e) { next(e); }
});

router.get('/ghana/imported-services', requirePermission('tax.read'), async (req, res, next) => {
  try { res.json({ data: await ghVatSvc.listImportedServices({ orgId: getOrganizationId(req), query: req.query || {} }) }); }
  catch (e) { next(e); }
});
router.get('/ghana/imported-services/:id', requirePermission('tax.read'), async (req, res, next) => {
  try { res.json(await ghVatSvc.getImportedService({ orgId: getOrganizationId(req), importedServiceId: req.params.id })); }
  catch (e) { next(e); }
});
router.post('/ghana/imported-services', idempotency({ required: true }), requirePermission('tax.manage'), async (req, res, next) => {
  try {
    const orgId=getOrganizationId(req); const payload=validate(createImportedServiceSchema, req.body);
    const out=await ghVatSvc.createImportedService({ orgId, actorUserId:req.user.id, payload });
    await writeAudit({ organizationId:orgId, actorUserId:req.user.id, action:'tax.ghana.imported_service.created', entityType:'imported_service_transactions', entityId:out.id, ip:req.audit?.ip, userAgent:req.audit?.userAgent, after:out });
    res.status(201).json(out);
  } catch(e){ next(e); }
});
router.patch('/ghana/imported-services/:id', requirePermission('tax.manage'), async (req,res,next)=>{
  try { const orgId=getOrganizationId(req); const payload=validate(updateImportedServiceSchema,req.body); const out=await ghVatSvc.updateImportedService({orgId,importedServiceId:req.params.id,payload}); res.json(out); }
  catch(e){next(e);}
});
router.post('/ghana/imported-services/:id/post', idempotency({ required:true }), requirePermission('tax.manage'), async (req,res,next)=>{
  try { const orgId=getOrganizationId(req); const out=await ghVatSvc.postImportedService({orgId,actorUserId:req.user.id,importedServiceId:req.params.id}); await writeAudit({organizationId:orgId,actorUserId:req.user.id,action:'tax.ghana.imported_service.posted',entityType:'imported_service_transactions',entityId:out.id,ip:req.audit?.ip,userAgent:req.audit?.userAgent,after:out}); res.json(out); }
  catch(e){next(e);}
});
router.post('/ghana/imported-services/:id/void', idempotency({ required:true }), requirePermission('tax.manage'), async (req,res,next)=>{
  try { const orgId=getOrganizationId(req); const payload=validate(voidImportedServiceSchema,req.body); const out=await ghVatSvc.voidImportedService({orgId,actorUserId:req.user.id,importedServiceId:req.params.id,reason:payload.reason}); await writeAudit({organizationId:orgId,actorUserId:req.user.id,action:'tax.ghana.imported_service.voided',entityType:'imported_service_transactions',entityId:out.id,ip:req.audit?.ip,userAgent:req.audit?.userAgent,after:out}); res.json(out); }
  catch(e){next(e);}
});

// ==================== TAX SETTINGS ====================
router.get("/settings", async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json({ data: await svc.getTaxSettings({ orgId }) });
  } catch (e) { next(e); }
});

router.put("/settings", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
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

// ==================== TAX ADJUSTMENTS ====================
router.get("/adjustments", requirePermission("tax.adjustment.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
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
    const orgId = getOrganizationId(req);
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
    const orgId = getOrganizationId(req);
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
    const orgId = getOrganizationId(req);
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
