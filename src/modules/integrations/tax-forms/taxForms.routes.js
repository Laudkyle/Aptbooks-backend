const router = require("express").Router(); 
const { authRequired } = require("../../../middleware/auth.middleware"); 
const { requirePermission } = require("../../../middleware/permission.middleware"); 
const { validate } = require("../../../shared/validators/validate"); 
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service"); 
const { AppError } = require("../../../shared/errors/AppError"); 

const svc = require("./taxForms.service"); 
const { upsertVendorTaxProfileSchema, createTaxFormRunSchema } = require("./taxForms.validators"); 

router.use(authRequired); 

router.put("/vendors/:vendorId/profile", requirePermission("taxforms.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    const payload = validate(upsertVendorTaxProfileSchema, req.body || {}); 
    const out = await svc.upsertVendorTaxProfile({ orgId, vendorId: Number(req.params.vendorId), payload }); 
    await writeAudit({ organizationId: orgId, actorUserId, action: "taxforms.vendor_profile_upserted", entityType: "vendor_tax_profiles", entityId: out.id, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: out }); 
    res.json(out); 
  } catch (e) { next(e);  }
}); 

router.get("/vendors/:vendorId/profile", requirePermission("taxforms.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const out = await svc.getVendorTaxProfile({ orgId, vendorId: Number(req.params.vendorId) }); 
    if (!out) throw new AppError(404, "Vendor tax profile not found"); 
    res.json(out); 
  } catch (e) { next(e);  }
}); 

router.post("/runs", requirePermission("taxforms.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    const body = validate(createTaxFormRunSchema, req.body || {}); 
    const run = await svc.createRun({ orgId, actorUserId, taxYear: body.taxYear, formType: body.formType }); 
    await writeAudit({ organizationId: orgId, actorUserId, action: "taxforms.run_created", entityType: "tax_form_runs", entityId: run.id, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: run }); 
    res.status(201).json(run); 
  } catch (e) { next(e);  }
}); 

router.post("/runs/:runId/generate", requirePermission("taxforms.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    const out = await svc.generateRun({ orgId, runId: req.params.runId }); 
    await writeAudit({ organizationId: orgId, actorUserId, action: "taxforms.run_generated", entityType: "tax_form_runs", entityId: req.params.runId, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: out }); 
    res.json(out); 
  } catch (e) { next(e);  }
}); 

router.get("/runs/:runId/forms", requirePermission("taxforms.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    res.json(await svc.listRunForms({ orgId, runId: req.params.runId })); 
  } catch (e) { next(e);  }
}); 

router.get("/runs/:runId/export.csv", requirePermission("taxforms.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const csv = await svc.exportRunCsv({ orgId, runId: req.params.runId }); 
    res.setHeader("Content-Type", "text/csv"); 
    res.send(csv); 
  } catch (e) { next(e);  }
}); 

module.exports = router; 
