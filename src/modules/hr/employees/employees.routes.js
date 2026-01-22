const express = require("express");
const router = express.Router();

const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const { validate } = require("../../../shared/validators/validate");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");

const { createEmployeeSchema, updateEmployeeSchema } = require("../../../shared/validators/hr.validators");

const svc = require("./employees.service");

router.use(authRequired);

router.post("/", idempotency({ required: true }), requirePermission("hr.employees.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(createEmployeeSchema, req.body);
    res.status(201).json(await svc.createEmployee({ orgId, actorUserId, payload, audit: req.audit, writeAudit }));
  } catch (e) { next(e); }
});

router.get("/", requirePermission("hr.employees.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listEmployees({ orgId, query: req.query }));
  } catch (e) { next(e); }
});

// Bulk export (CSV)
router.get("/export", requirePermission("hr.employees.export"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const csv = await svc.exportEmployeesCsv({ orgId, query: req.query });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=employees.csv");
    res.status(200).send(csv);
  } catch (e) { next(e); }
});

// Bulk import (JSON array)
router.post("/import", idempotency({ required: true }), requirePermission("hr.employees.import"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const { employees, mode } = req.body || {};
    res.status(200).json(await svc.importEmployees({ orgId, actorUserId, employees, mode, audit: req.audit, writeAudit }));
  } catch (e) { next(e); }
});

// Bulk import (CSV body: text/csv)
router.post("/import/csv", idempotency({ required: true }), requirePermission("hr.employees.import_csv"), express.text({ type: ["text/csv","application/csv","application/vnd.ms-excel"], limit: "5mb" }), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const csvText = req.body;
    const { mode } = req.query || {};
    res.status(200).json(await svc.importEmployeesCsv({ orgId, actorUserId, csvText, mode, audit: req.audit, writeAudit }));
  } catch (e) { next(e); }
});


router.get("/:id", requirePermission("hr.employees.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getEmployee({ orgId, employeeId: req.params.id }));
  } catch (e) { next(e); }
});

router.put("/:id", requirePermission("hr.employees.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(updateEmployeeSchema, req.body);
    res.json(await svc.updateEmployee({ orgId, actorUserId, employeeId: req.params.id, payload, audit: req.audit, writeAudit }));
  } catch (e) { next(e); }
});

// Convenience status endpoints (Stage 1 lifecycle hooks)
router.post("/:id/activate", idempotency({ required: true }), requirePermission("hr.employees.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    res.json(await svc.setStatus({ orgId, actorUserId, employeeId: req.params.id, status: "active", audit: req.audit, writeAudit }));
  } catch (e) { next(e); }
});

router.post("/:id/deactivate", idempotency({ required: true }), requirePermission("hr.employees.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    res.json(await svc.setStatus({ orgId, actorUserId, employeeId: req.params.id, status: "inactive", audit: req.audit, writeAudit }));
  } catch (e) { next(e); }
});

router.post("/:id/terminate", idempotency({ required: true }), requirePermission("hr.employees.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    res.json(await svc.setStatus({ orgId, actorUserId, employeeId: req.params.id, status: "terminated", audit: req.audit, writeAudit }));
  } catch (e) { next(e); }
});

module.exports = router;