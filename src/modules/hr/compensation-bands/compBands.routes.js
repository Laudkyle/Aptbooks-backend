const router = require("express").Router(); 

const { authRequired } = require("../../../middleware/auth.middleware"); 
const { requirePermission } = require("../../../middleware/permission.middleware"); 
const { idempotency } = require("../../../middleware/idempotency.middleware"); 
const { validate } = require("../../../shared/validators/validate"); 
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service"); 

const { createCompBandSchema, updateCompBandSchema } = require("../../../shared/validators/hr.validators"); 
const svc = require("./compBands.service"); 

router.use(authRequired); 

router.post("/", idempotency({ required: true }), requirePermission("hr.compensation_bands.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    const payload = validate(createCompBandSchema, req.body); 
    res.status(201).json(await svc.createBand({ orgId, actorUserId, payload, audit: req.audit, writeAudit })); 
  } catch (e) { next(e);  }
}); 

router.get("/", requirePermission("hr.compensation_bands.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    res.json(await svc.listBands({ orgId, query: req.query })); 
  } catch (e) { next(e);  }
}); 

// Bulk export (CSV)
router.get("/export", requirePermission("hr.compensation_bands.export"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const csv = await svc.exportBandsCsv({ orgId, query: req.query }); 
    res.setHeader("Content-Type", "text/csv;  charset=utf-8"); 
    res.setHeader("Content-Disposition", "attachment;  filename=compensation_bands.csv"); 
    res.status(200).send(csv); 
  } catch (e) { next(e);  }
}); 

// Bulk import (JSON array)
router.post("/import", idempotency({ required: true }), requirePermission("hr.compensation_bands.import"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    const { bands, mode } = req.body || {}; 
    res.status(200).json(await svc.importBands({ orgId, actorUserId, bands, mode, audit: req.audit, writeAudit })); 
  } catch (e) { next(e);  }
}); 

// Bulk import (CSV body)
router.post(
  "/import/csv",
  idempotency({ required: true }),
  requirePermission("hr.compensation_bands.import_csv"),
  require("express").text({ type: ["text/csv","application/csv","application/vnd.ms-excel"], limit: "5mb" }),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id; 
      const actorUserId = req.user.id; 
      const csvText = req.body; 
      const { mode } = req.query || {}; 
      res.status(200).json(await svc.importBandsCsv({ orgId, actorUserId, csvText, mode, audit: req.audit, writeAudit })); 
    } catch (e) { next(e);  }
  }
); 

router.get("/:id", requirePermission("hr.compensation_bands.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    res.json(await svc.getBand({ orgId, bandId: req.params.id })); 
  } catch (e) { next(e);  }
}); 

router.put("/:id", requirePermission("hr.compensation_bands.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    const payload = validate(updateCompBandSchema, req.body); 
    res.json(await svc.updateBand({ orgId, actorUserId, bandId: req.params.id, payload, audit: req.audit, writeAudit })); 
  } catch (e) { next(e);  }
}); 

router.delete("/:id", requirePermission("hr.compensation_bands.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    res.json(await svc.deactivateBand({ orgId, actorUserId, bandId: req.params.id, audit: req.audit, writeAudit })); 
  } catch (e) { next(e);  }
}); 

module.exports = router; 
