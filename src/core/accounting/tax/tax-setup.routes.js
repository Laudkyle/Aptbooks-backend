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


module.exports = router;
