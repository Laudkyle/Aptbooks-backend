const router = require("express").Router(); 

const { authRequired } = require("../../../middleware/auth.middleware"); 
const { requirePermission } = require("../../../middleware/permission.middleware"); 
const { idempotency } = require("../../../middleware/idempotency.middleware"); 
const { validate } = require("../../../shared/validators/validate"); 
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service"); 

const {
  createDepartmentSchema,
  updateDepartmentSchema,
} = require("../../../shared/validators/hr.validators"); 

const svc = require("./departments.service"); 

router.use(authRequired); 

router.post(
  "/",
  idempotency({ required: true }),
  requirePermission("hr.departments.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id; 
      const actorUserId = req.user.id; 
      const payload = validate(createDepartmentSchema, req.body); 
      res.status(201).json(await svc.createDepartment({ orgId, actorUserId, payload, audit: req.audit, writeAudit })); 
    } catch (e) { next(e);  }
  }
); 

router.get(
  "/",
  requirePermission("hr.departments.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id; 
      res.json(await svc.listDepartments({ orgId, query: req.query })); 
    } catch (e) { next(e);  }
  }
); 

// Bulk export (CSV)
router.get("/export", requirePermission("hr.departments.export"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const csv = await svc.exportDepartmentsCsv({ orgId, query: req.query }); 
    res.setHeader("Content-Type", "text/csv;  charset=utf-8"); 
    res.setHeader("Content-Disposition", "attachment;  filename=departments.csv"); 
    res.status(200).send(csv); 
  } catch (e) { next(e);  }
}); 

// Bulk import (JSON array)
router.post("/import", idempotency({ required: true }), requirePermission("hr.departments.import"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    const { departments, mode } = req.body || {}; 
    res.status(200).json(await svc.importDepartments({ orgId, actorUserId, departments, mode, audit: req.audit, writeAudit })); 
  } catch (e) { next(e);  }
}); 

// Bulk import (CSV body)
router.post(
  "/import/csv",
  idempotency({ required: true }),
  requirePermission("hr.departments.import_csv"),
  require("express").text({ type: ["text/csv","application/csv","application/vnd.ms-excel"], limit: "5mb" }),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id; 
      const actorUserId = req.user.id; 
      const csvText = req.body; 
      const { mode } = req.query || {}; 
      res.status(200).json(await svc.importDepartmentsCsv({ orgId, actorUserId, csvText, mode, audit: req.audit, writeAudit })); 
    } catch (e) { next(e);  }
  }
); 

router.get(
  "/:id",
  requirePermission("hr.departments.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id; 
      res.json(await svc.getDepartment({ orgId, departmentId: req.params.id })); 
    } catch (e) { next(e);  }
  }
); 

router.put(
  "/:id",
  requirePermission("hr.departments.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id; 
      const actorUserId = req.user.id; 
      const payload = validate(updateDepartmentSchema, req.body); 
      res.json(await svc.updateDepartment({ orgId, actorUserId, departmentId: req.params.id, payload, audit: req.audit, writeAudit })); 
    } catch (e) { next(e);  }
  }
); 

router.delete(
  "/:id",
  requirePermission("hr.departments.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id; 
      const actorUserId = req.user.id; 
      res.json(await svc.deactivateDepartment({ orgId, actorUserId, departmentId: req.params.id, audit: req.audit, writeAudit })); 
    } catch (e) { next(e);  }
  }
); 

module.exports = router; 
