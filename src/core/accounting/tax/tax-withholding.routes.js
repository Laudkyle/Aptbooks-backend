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

router.get('/ghana/withholding/remittances', requirePermission('tax.read'), async (req,res,next)=>{
  try { res.json({ data: await ghWithholdingSvc.listRemittances({ orgId:getOrganizationId(req), query:req.query }) }); } catch (e) { next(e); }
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
