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
router.use(authRequired);

// Admin CRUD for VAT/GST tax setup
router.use(requirePermission("tax.read"));

// ==================== JURISDICTIONS ====================
router.get("/jurisdictions", async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json({ data: await svc.listJurisdictions({ orgId }) });
  } catch (e) { next(e); }
});

router.post("/jurisdictions", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
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
    const orgId = getOrganizationId(req);
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
    const orgId = getOrganizationId(req);
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

// ==================== TAX REGISTRATIONS ====================
router.get("/registrations", requirePermission("tax.registration.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
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
    const orgId = getOrganizationId(req);
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
    const orgId = getOrganizationId(req);
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
    const orgId = getOrganizationId(req);
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

// ==================== TAX RULES ====================
router.get("/rules", requirePermission("tax.rule.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const query = {
      status: req.query.status,
      documentType: req.query.documentType,
      partnerType: req.query.partnerType,
      supplyType: req.query.supplyType,
      placeOfSupplyBasis: req.query.placeOfSupplyBasis,
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
    const orgId = getOrganizationId(req);
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
    const orgId = getOrganizationId(req);
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
    const orgId = getOrganizationId(req);
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

// ==================== TAX CATALOG PROFILES ====================
router.get('/catalog-profiles', requirePermission('tax.read'), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json({ data: await svc.listTaxCatalogProfiles({ orgId, query: req.query }) });
  } catch (e) { next(e); }
});

router.get('/catalog-profiles/:id', requirePermission('tax.read'), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json({ data: await svc.getTaxCatalogProfileById({ orgId, profileId: req.params.id }) });
  } catch (e) { next(e); }
});

router.post('/catalog-profiles', idempotency({ required: true }), requirePermission('tax.manage'), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(createTaxCatalogProfileSchema, req.body);
    const created = await svc.createTaxCatalogProfile({ orgId, payload });
    await writeAudit({
      organizationId: orgId, actorUserId: req.user.id, action: 'tax.catalog.created',
      entityType: 'tax_catalog_profiles', entityId: created.id,
      ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: created
    });
    res.status(201).json({ data: created });
  } catch (e) {
    if (e?.code === '23505') return next(new AppError(409, 'Tax catalog profile code already exists'));
    next(e);
  }
});

router.patch('/catalog-profiles/:id', requirePermission('tax.manage'), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(updateTaxCatalogProfileSchema, req.body);
    const out = await svc.updateTaxCatalogProfile({ orgId, profileId: req.params.id, payload });
    await writeAudit({
      organizationId: orgId, actorUserId: req.user.id, action: 'tax.catalog.updated',
      entityType: 'tax_catalog_profiles', entityId: req.params.id,
      ip: req.audit?.ip, userAgent: req.audit?.userAgent, before: out.before, after: out.after
    });
    res.json({ data: out.after });
  } catch (e) {
    if (e?.code === '23505') return next(new AppError(409, 'Tax catalog profile code already exists'));
    next(e);
  }
});

router.delete('/catalog-profiles/:id', requirePermission('tax.manage'), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const out = await svc.deleteTaxCatalogProfile({ orgId, profileId: req.params.id });
    await writeAudit({
      organizationId: orgId, actorUserId: req.user.id, action: out.deactivated ? 'tax.catalog.deactivated' : 'tax.catalog.deleted',
      entityType: 'tax_catalog_profiles', entityId: req.params.id,
      ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: out
    });
    res.json(out);
  } catch (e) { next(e); }
});

router.get('/ledger', requirePermission('tax.read'), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json({ data: await svc.listTaxLedgerEntries({ orgId, query: req.query }) });
  } catch (e) { next(e); }
});

// ==================== TAX CODES ====================
router.get("/codes", async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
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
    const orgId = getOrganizationId(req);
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
    const orgId = getOrganizationId(req);
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
    const orgId = getOrganizationId(req);
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

// ==================== TAX CODE COMPONENTS ====================
router.get("/codes/:id/components", requirePermission("tax.component.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.listTaxCodeComponents({ orgId, taxCodeId: req.params.id });
    res.json({ data });
  } catch (e) { next(e); }
});

router.put("/codes/:id/components", requirePermission("tax.component.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(setTaxCodeComponentsSchema, req.body);
    const data = await svc.setTaxCodeComponents({ orgId, taxCodeId: req.params.id, payload });
    res.json({ data });
  } catch (e) { next(e); }
});

// ==================== COUNTRY PACKS ====================
router.get("/country-packs", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json({ data: await svc.listCountryPacks({ orgId }) });
  } catch (e) { next(e); }
});

router.post("/country-packs/install", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(installCountryPackSchema, req.body);
    const out = await svc.installCountryPack({ orgId, actorUserId: req.user.id, payload });
    res.json(out);
  } catch (e) { next(e); }
});


// ==================== GHANA TAX WORKSPACE ====================
router.get("/ghana/setup-checklist", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json({ data: await svc.getGhanaSetupChecklist({ orgId }) });
  } catch (e) { next(e); }
});

router.get("/ghana/diagnostics", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json({ data: await svc.getGhanaTaxDiagnostics({ orgId }) });
  } catch (e) { next(e); }
});

router.post("/ghana/calculate", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json({ data: await svc.calculateGhanaTax({ orgId, payload: req.body || {} }) });
  } catch (e) { next(e); }
});

router.post("/ghana/install-workflows", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json({ data: await svc.installGhanaTaxWorkflows({ orgId, actorUserId: req.user.id }) });
  } catch (e) { next(e); }
});


// ==================== GHANA CIT + CAPITAL ALLOWANCES + INDUSTRY READINESS (GRA-6) ====================
router.get('/ghana/cit/settings', requirePermission('tax.ghana.cit.read'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.getSettings({orgId:getOrganizationId(req)})}); } catch(e){ next(e); }
});
router.put('/ghana/cit/settings', requirePermission('tax.ghana.cit.manage'), async (req,res,next)=>{
  try { const orgId=getOrganizationId(req); const out=await ghCitSvc.updateSettings({orgId,actorUserId:req.user.id,payload:req.body||{}}); await writeAudit({organizationId:orgId,actorUserId:req.user.id,action:'tax.ghana.cit.settings.updated',entityType:'ghana_cit_settings',entityId:orgId,ip:req.audit?.ip,userAgent:req.audit?.userAgent,after:out}); res.json({data:out}); } catch(e){ next(e); }
});
router.get('/ghana/cit/rates', requirePermission('tax.ghana.cit.read'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.listRateVersions({asOfDate:req.query.asOfDate||null})}); } catch(e){ next(e); }
});
router.get('/ghana/cit/computations', requirePermission('tax.ghana.cit.read'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.listComputations({orgId:getOrganizationId(req),query:req.query||{}})}); } catch(e){ next(e); }
});
router.get('/ghana/cit/computations/:id', requirePermission('tax.ghana.cit.read'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.getComputation({orgId:getOrganizationId(req),id:req.params.id})}); } catch(e){ next(e); }
});
router.post('/ghana/cit/computations', idempotency({required:true}), requirePermission('tax.ghana.cit.manage'), async (req,res,next)=>{
  try { const orgId=getOrganizationId(req); const out=await ghCitSvc.prepareComputation({orgId,actorUserId:req.user.id,payload:req.body||{}}); await writeAudit({organizationId:orgId,actorUserId:req.user.id,action:'tax.ghana.cit.computation.prepared',entityType:'ghana_cit_computations',entityId:out.id,ip:req.audit?.ip,userAgent:req.audit?.userAgent,after:out}); res.status(201).json({data:out}); } catch(e){ next(e); }
});
router.post('/ghana/cit/computations/:id/adjustments', requirePermission('tax.ghana.cit.manage'), async (req,res,next)=>{
  try { const orgId=getOrganizationId(req); const out=await ghCitSvc.addComputationAdjustment({orgId,actorUserId:req.user.id,computationId:req.params.id,payload:req.body||{}}); res.status(201).json({data:out}); } catch(e){ next(e); }
});
router.post('/ghana/cit/computations/:id/finalize', idempotency({required:true}), requirePermission('tax.ghana.cit.file'), async (req,res,next)=>{
  try { const orgId=getOrganizationId(req); const out=await ghCitSvc.finalizeComputation({orgId,actorUserId:req.user.id,id:req.params.id}); await writeAudit({organizationId:orgId,actorUserId:req.user.id,action:'tax.ghana.cit.return.finalized',entityType:'ghana_cit_computations',entityId:out.id,ip:req.audit?.ip,userAgent:req.audit?.userAgent,after:out}); res.json({data:out}); } catch(e){ next(e); }
});
router.post('/ghana/cit/computations/:id/filed', idempotency({required:true}), requirePermission('tax.ghana.cit.file'), async (req,res,next)=>{
  try { const orgId=getOrganizationId(req); const out=await ghCitSvc.markComputationFiled({orgId,actorUserId:req.user.id,id:req.params.id,graReference:req.body?.graReference}); await writeAudit({organizationId:orgId,actorUserId:req.user.id,action:'tax.ghana.cit.return.filed',entityType:'ghana_cit_computations',entityId:out.id,ip:req.audit?.ip,userAgent:req.audit?.userAgent,after:out}); res.json({data:out}); } catch(e){ next(e); }
});
router.get('/ghana/cit/self-assessments', requirePermission('tax.ghana.cit.read'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.listSelfAssessments({orgId:getOrganizationId(req),taxYear:req.query.taxYear||null})}); } catch(e){ next(e); }
});
router.post('/ghana/cit/self-assessments', idempotency({required:true}), requirePermission('tax.ghana.cit.manage'), async (req,res,next)=>{
  try { const orgId=getOrganizationId(req); const out=await ghCitSvc.createSelfAssessment({orgId,actorUserId:req.user.id,payload:req.body||{}}); await writeAudit({organizationId:orgId,actorUserId:req.user.id,action:'tax.ghana.cit.self_assessment.prepared',entityType:'ghana_cit_self_assessments',entityId:out.id,ip:req.audit?.ip,userAgent:req.audit?.userAgent,after:out}); res.status(201).json({data:out}); } catch(e){ next(e); }
});
router.post('/ghana/cit/self-assessments/:id/finalize', idempotency({required:true}), requirePermission('tax.ghana.cit.file'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.finalizeSelfAssessment({orgId:getOrganizationId(req),actorUserId:req.user.id,id:req.params.id})}); } catch(e){ next(e); }
});
router.post('/ghana/cit/self-assessments/:id/filed', idempotency({required:true}), requirePermission('tax.ghana.cit.file'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.markSelfAssessmentFiled({orgId:getOrganizationId(req),actorUserId:req.user.id,id:req.params.id,graReference:req.body?.graReference})}); } catch(e){ next(e); }
});
router.post('/ghana/cit/self-assessments/:id/payments', idempotency({required:true}), requirePermission('tax.ghana.cit.manage'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.recordSelfAssessmentPayment({orgId:getOrganizationId(req),id:req.params.id,payload:req.body||{}})}); } catch(e){ next(e); }
});

router.get('/ghana/capital-allowances/classes', requirePermission('tax.ghana.cit.read'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.listTaxAssetClasses()}); } catch(e){ next(e); }
});
router.get('/ghana/capital-allowances/assets', requirePermission('tax.ghana.cit.read'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.listTaxAssets({orgId:getOrganizationId(req),query:req.query||{}})}); } catch(e){ next(e); }
});
router.post('/ghana/capital-allowances/assets', idempotency({required:true}), requirePermission('tax.ghana.cit.manage'), async (req,res,next)=>{
  try { const orgId=getOrganizationId(req); const out=await ghCitSvc.createTaxAsset({orgId,actorUserId:req.user.id,payload:req.body||{}}); await writeAudit({organizationId:orgId,actorUserId:req.user.id,action:'tax.ghana.capital_allowance.asset.created',entityType:'ghana_tax_assets',entityId:out.id,ip:req.audit?.ip,userAgent:req.audit?.userAgent,after:out}); res.status(201).json({data:out}); } catch(e){ next(e); }
});
router.post('/ghana/capital-allowances/assets/:id/dispose', idempotency({required:true}), requirePermission('tax.ghana.cit.manage'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.disposeTaxAsset({orgId:getOrganizationId(req),id:req.params.id,payload:req.body||{}})}); } catch(e){ next(e); }
});
router.get('/ghana/capital-allowances/runs', requirePermission('tax.ghana.cit.read'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.listCapitalAllowanceRuns({orgId:getOrganizationId(req),taxYear:req.query.taxYear||null})}); } catch(e){ next(e); }
});
router.get('/ghana/capital-allowances/runs/:id', requirePermission('tax.ghana.cit.read'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.getCapitalAllowanceRun({orgId:getOrganizationId(req),id:req.params.id})}); } catch(e){ next(e); }
});
router.post('/ghana/capital-allowances/runs', idempotency({required:true}), requirePermission('tax.ghana.cit.manage'), async (req,res,next)=>{
  try { const orgId=getOrganizationId(req); const out=await ghCitSvc.prepareCapitalAllowanceRun({orgId,actorUserId:req.user.id,payload:req.body||{}}); await writeAudit({organizationId:orgId,actorUserId:req.user.id,action:'tax.ghana.capital_allowance.prepared',entityType:'ghana_capital_allowance_runs',entityId:out.id,ip:req.audit?.ip,userAgent:req.audit?.userAgent,after:out}); res.status(201).json({data:out}); } catch(e){ next(e); }
});
router.post('/ghana/capital-allowances/runs/:id/finalize', idempotency({required:true}), requirePermission('tax.ghana.cit.file'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.finalizeCapitalAllowanceRun({orgId:getOrganizationId(req),actorUserId:req.user.id,id:req.params.id})}); } catch(e){ next(e); }
});

router.get('/ghana/industry-profiles', requirePermission('tax.read'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.listIndustryProfiles({orgId:getOrganizationId(req)})}); } catch(e){ next(e); }
});
router.post('/ghana/industry-profiles/:code/install', idempotency({required:true}), requirePermission('tax.ghana.industry.manage'), async (req,res,next)=>{
  try { const orgId=getOrganizationId(req); const out=await ghCitSvc.installIndustryProfile({orgId,actorUserId:req.user.id,profileCode:req.params.code,settings:req.body?.settings||{}}); await writeAudit({organizationId:orgId,actorUserId:req.user.id,action:'tax.ghana.industry_profile.installed',entityType:'organization_industry_profiles',entityId:orgId,ip:req.audit?.ip,userAgent:req.audit?.userAgent,after:out}); res.json({data:out}); } catch(e){ next(e); }
});
router.post('/ghana/industry-profiles/review', requirePermission('tax.ghana.industry.manage'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.reviewIndustryProfile({orgId:getOrganizationId(req),actorUserId:req.user.id,settings:req.body?.settings||{}})}); } catch(e){ next(e); }
});
router.get('/ghana/readiness', requirePermission('tax.ghana.readiness.read'), async (req,res,next)=>{
  try { res.json({data:await ghCitSvc.getReadiness({orgId:getOrganizationId(req),actorUserId:req.user.id,persist:String(req.query.persist||'false')==='true'})}); } catch(e){ next(e); }
});

// ==================== AUTOMATION RULES ====================
router.get("/automation-rules", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json({ data: await svc.listAutomationRules({ orgId }) });
  } catch (e) { next(e); }
});

router.put("/automation-rules", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(upsertTaxAutomationRuleSchema, req.body);
    const out = await svc.upsertAutomationRule({ orgId, actorUserId: req.user.id, payload });
    res.json(out);
  } catch (e) { next(e); }
});

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
// Add these to your tax.router.js file after the existing routes

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
// ==================== GHANA WITHHOLDING (GRA-3) ====================
router.get('/ghana/withholding/dashboard', requirePermission('tax.read'), async (req,res,next)=>{
  try { res.json({ data: await ghWithholdingSvc.getDashboard({ orgId:getOrganizationId(req), fromDate:req.query.fromDate || null, toDate:req.query.toDate || null }) }); } catch (e) { next(e); }
});

router.get('/ghana/withholding/reconciliation', requirePermission('tax.read'), async (req,res,next)=>{
  try { res.json({ data: await ghWithholdingSvc.getReconciliation({ orgId:getOrganizationId(req), toDate:req.query.toDate || null }) }); } catch (e) { next(e); }
});

router.get('/ghana/withholding/rates', requirePermission('tax.read'), async (req,res,next)=>{
  try { res.json({ data: await ghWithholdingSvc.listRateCatalog({ orgId: getOrganizationId(req) }) }); } catch (e) { next(e); }
});

router.get('/ghana/withholding/threshold-position', requirePermission('tax.read'), async (req,res,next)=>{
  try {
    const orgId = getOrganizationId(req);
    if (!req.query.partnerId) throw new AppError(400, 'partnerId is required');
    const data = await ghWithholdingSvc.getThresholdPosition({ orgId, partnerId:req.query.partnerId, categoryCode:req.query.categoryCode || null, date:req.query.date || new Date().toISOString().slice(0,10) });
    res.json({ data });
  } catch (e) { next(e); }
});

router.post('/ghana/withholding/preview', requirePermission('tax.read'), async (req,res,next)=>{
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(ghWithholdingPreviewSchema, req.body);
    if (!payload.eventDate) payload.eventDate = new Date().toISOString().slice(0,10);
    res.json({ data: await ghWithholdingSvc.preview({ orgId, payload }) });
  } catch (e) { next(e); }
});

router.get('/ghana/withholding/events', requirePermission('tax.read'), async (req,res,next)=>{
  try { res.json({ data: await ghWithholdingSvc.listEvents({ orgId:getOrganizationId(req), query:req.query }) }); } catch (e) { next(e); }
});

router.post('/ghana/withholding/events', idempotency({ required:true }), requirePermission('tax.manage'), async (req,res,next)=>{
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(ghWithholdingEventSchema, req.body);
    const data = await ghWithholdingSvc.recordEvent({ orgId, actorUserId:req.user.id, payload });
    await writeAudit({ organizationId:orgId, actorUserId:req.user.id, action:'tax.ghana.withholding.event.created', entityType:'ghana_withholding_events', entityId:data.id, ip:req.audit?.ip, userAgent:req.audit?.userAgent, after:data });
    res.status(201).json({ data });
  } catch (e) { next(e); }
});

router.post('/ghana/withholding/vendor-payments/:id/capture', idempotency({ required:true }), requirePermission('tax.manage'), async (req,res,next)=>{
  try {
    const orgId = getOrganizationId(req);
    const data = await ghWithholdingSvc.captureVendorPaymentWithholding({ orgId, actorUserId:req.user.id, vendorPaymentId:req.params.id });
    res.json({ data });
  } catch (e) { next(e); }
});

router.get('/ghana/withholding/certificates', requirePermission('tax.read'), async (req,res,next)=>{
  try { res.json({ data: await ghWithholdingSvc.listCertificates({ orgId:getOrganizationId(req), query:req.query }) }); } catch (e) { next(e); }
});

router.post('/ghana/withholding/certificates/received', idempotency({ required:true }), requirePermission('tax.manage'), async (req,res,next)=>{
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(ghReceivedWithholdingCertificateSchema, req.body);
    const data = await ghWithholdingSvc.recordReceivedCertificate({ orgId, actorUserId:req.user.id, payload });
    res.status(201).json({ data });
  } catch (e) { next(e); }
});

router.get('/ghana/withholding/returns', requirePermission('tax.read'), async (req,res,next)=>{
  try { res.json({ data: await ghWithholdingSvc.listReturns({ orgId:getOrganizationId(req), query:req.query }) }); } catch (e) { next(e); }
});

router.get('/ghana/withholding/returns/:id', requirePermission('tax.read'), async (req,res,next)=>{
  try { res.json({ data: await ghWithholdingSvc.getReturn({ orgId:getOrganizationId(req), returnId:req.params.id }) }); } catch (e) { next(e); }
});

router.post('/ghana/withholding/returns', idempotency({ required:true }), requirePermission('tax.manage'), async (req,res,next)=>{
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(ghWithholdingReturnSchema, req.body);
    const data = await ghWithholdingSvc.prepareReturn({ orgId, actorUserId:req.user.id, payload });
    res.status(201).json({ data });
  } catch (e) { next(e); }
});

router.post('/ghana/withholding/returns/:id/finalize', idempotency({ required:true }), requirePermission('tax.approve'), async (req,res,next)=>{
  try { res.json({ data: await ghWithholdingSvc.finalizeReturn({ orgId:getOrganizationId(req), returnId:req.params.id, actorUserId:req.user.id }) }); } catch (e) { next(e); }
});

router.post('/ghana/withholding/returns/:id/filed', idempotency({ required:true }), requirePermission('tax.manage'), async (req,res,next)=>{
  try {
    const payload = validate(ghWithholdingFiledSchema, req.body);
    res.json({ data: await ghWithholdingSvc.markReturnFiled({ orgId:getOrganizationId(req), returnId:req.params.id, actorUserId:req.user.id, graReference:payload.graReference }) });
  } catch (e) { next(e); }
});

router.post('/ghana/withholding/remittances', idempotency({ required:true }), requirePermission('tax.manage'), async (req,res,next)=>{
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(ghWithholdingRemittanceSchema, req.body);
    const data = await ghWithholdingSvc.createRemittanceFromEvents({ orgId, actorUserId:req.user.id, payload });
    res.status(201).json({ data });
  } catch (e) { next(e); }
});

router.post('/ghana/withholding/remittances/:id/post', idempotency({ required:true }), requirePermission('tax.manage'), async (req,res,next)=>{
  try {
    const payload = validate(ghWithholdingPostRemittanceSchema, req.body);
    res.json({ data: await ghWithholdingSvc.postRemittance({ orgId:getOrganizationId(req), remittanceId:req.params.id, actorUserId:req.user.id, payload }) });
  } catch (e) { next(e); }
});

router.post('/ghana/withholding/remittances/:id/void', idempotency({ required:true }), requirePermission('tax.manage'), async (req,res,next)=>{
  try {
    const payload = validate(voidWithholdingWorkflowSchema, req.body);
    res.json({ data: await ghWithholdingSvc.voidRemittance({ orgId:getOrganizationId(req), remittanceId:req.params.id, actorUserId:req.user.id, reason:payload.reason }) });
  } catch (e) { next(e); }
});

// ==================== WITHHOLDING REMITTANCES ====================
router.get("/withholding/remittances", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.listWithholdingRemittances({ orgId, query: req.query });
    res.json({ data });
  } catch (e) { next(e); }
});
// ==================== WITHHOLDING OPEN ITEMS ====================
router.get("/withholding/open-items", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const direction = req.query.direction || 'payable';
    const data = await svc.getOpenWithholdingItems({ orgId, direction, query: req.query });
    res.json({ data });
  } catch (e) { next(e); }
});
router.get("/withholding/remittances/:id", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.getWithholdingRemittance({ orgId, remittanceId: req.params.id });
    res.json({ data });
  } catch (e) { next(e); }
});

router.post("/withholding/remittances", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(createWithholdingRemittanceSchema, req.body);
    const created = await svc.createWithholdingRemittance({ orgId, actorUserId: req.user.id, payload });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.withholding.remittance.created",
      entityType: "withholding_remittances",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });
    
    res.status(201).json({ data: created });
  } catch (e) { next(e); }
});

router.patch("/withholding/remittances/:id", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(updateWithholdingRemittanceSchema, req.body);
    const updated = await svc.updateWithholdingRemittance({ orgId, remittanceId: req.params.id, payload, actorUserId: req.user.id });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.withholding.remittance.updated",
      entityType: "withholding_remittances",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: updated
    });
    
    res.json({ data: updated });
  } catch (e) { next(e); }
});

router.post("/withholding/remittances/:id/submit", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const result = await svc.submitWithholdingRemittanceForApproval({ orgId, remittanceId: req.params.id, actorUserId: req.user.id });
    res.json({ data: result });
  } catch (e) { next(e); }
});

router.post("/withholding/remittances/:id/approve", requirePermission("tax.approve"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const result = await svc.approveWithholdingRemittance({ orgId, remittanceId: req.params.id, actorUserId: req.user.id, comment: req.body.comment });
    res.json({ data: result });
  } catch (e) { next(e); }
});

router.post("/withholding/remittances/:id/reject", requirePermission("tax.approve"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const result = await svc.rejectWithholdingRemittance({ orgId, remittanceId: req.params.id, actorUserId: req.user.id, reason: req.body.reason });
    res.json({ data: result });
  } catch (e) { next(e); }
});

router.post("/withholding/remittances/:id/post", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(postWithholdingRemittanceSchema, req.body);
    const result = await svc.postWithholdingRemittance({ orgId, remittanceId: req.params.id, actorUserId: req.user.id, payload });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.withholding.remittance.posted",
      entityType: "withholding_remittances",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: result
    });
    
    res.json({ data: result });
  } catch (e) { next(e); }
});

router.post("/withholding/remittances/:id/void", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(voidWithholdingWorkflowSchema, req.body);
    const result = await svc.voidWithholdingRemittance({ orgId, remittanceId: req.params.id, actorUserId: req.user.id, reason: payload.reason });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.withholding.remittance.voided",
      entityType: "withholding_remittances",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: result
    });
    
    res.json({ data: result });
  } catch (e) { next(e); }
});

// ==================== WITHHOLDING CERTIFICATES ====================
router.get("/withholding/certificates", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.listWithholdingCertificates({ orgId, query: req.query });
    res.json({ data });
  } catch (e) { next(e); }
});

router.get("/withholding/certificates/:id", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.getWithholdingCertificate({ orgId, certificateId: req.params.id });
    res.json({ data });
  } catch (e) { next(e); }
});

router.post("/withholding/certificates", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(createWithholdingCertificateSchema, req.body);
    const created = await svc.createWithholdingCertificate({ orgId, actorUserId: req.user.id, payload });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.withholding.certificate.created",
      entityType: "withholding_certificates",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });
    
    res.status(201).json({ data: created });
  } catch (e) { next(e); }
});

router.patch("/withholding/certificates/:id", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(updateWithholdingCertificateSchema, req.body);
    const updated = await svc.updateWithholdingCertificate({ orgId, certificateId: req.params.id, payload, actorUserId: req.user.id });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.withholding.certificate.updated",
      entityType: "withholding_certificates",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: updated
    });
    
    res.json({ data: updated });
  } catch (e) { next(e); }
});

router.post("/withholding/certificates/:id/submit", requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const result = await svc.submitWithholdingCertificateForApproval({ orgId, certificateId: req.params.id, actorUserId: req.user.id });
    res.json({ data: result });
  } catch (e) { next(e); }
});

router.post("/withholding/certificates/:id/approve", requirePermission("tax.approve"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const result = await svc.approveWithholdingCertificate({ orgId, certificateId: req.params.id, actorUserId: req.user.id, comment: req.body.comment });
    res.json({ data: result });
  } catch (e) { next(e); }
});

router.post("/withholding/certificates/:id/reject", requirePermission("tax.approve"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const result = await svc.rejectWithholdingCertificate({ orgId, certificateId: req.params.id, actorUserId: req.user.id, reason: req.body.reason });
    res.json({ data: result });
  } catch (e) { next(e); }
});

router.post("/withholding/certificates/:id/post", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(postWithholdingCertificateSchema, req.body);
    const result = await svc.postWithholdingCertificate({ orgId, certificateId: req.params.id, actorUserId: req.user.id, payload });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.withholding.certificate.posted",
      entityType: "withholding_certificates",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: result
    });
    
    res.json({ data: result });
  } catch (e) { next(e); }
});

router.post("/withholding/certificates/:id/void", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const payload = validate(voidWithholdingWorkflowSchema, req.body);
    const result = await svc.voidWithholdingCertificate({ orgId, certificateId: req.params.id, actorUserId: req.user.id, reason: payload.reason });
    
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "tax.withholding.certificate.voided",
      entityType: "withholding_certificates",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: result
    });
    
    res.json({ data: result });
  } catch (e) { next(e); }
});

// ==================== WITHHOLDING DASHBOARD ====================
router.get("/withholding/dashboard", requirePermission("tax.read"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.getWithholdingDashboard({ orgId, query: req.query });
    res.json({ data });
  } catch (e) { next(e); }
});

module.exports = router;