const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");
const svc = require("./tax.service");
const { AppError } = require('../../shared/errors/AppError');

const router = express.Router();

router.use(requirePermission("reporting.tax.read"));

// VAT/GST summary for a date range.
router.get("/vat-summary", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { from, to } = req.query;
    const data = await svc.vatSummary({ orgId, fromDate: from, toDate: to });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// VAT/GST return (box-based)
router.get("/vat-return", async (req, res, next) => {
  try {
    const { organization_id: orgId, id: userId } = req.user;
    const { from, to, templateCode } = req.query;
    const data = await svc.vatReturn({ orgId, userId, fromDate: from, toDate: to, templateCode });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});


router.get("/transactions", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { from, to, taxType, direction, entityType } = req.query;
    const data = await svc.taxTransactions({ orgId, fromDate: from, toDate: to, taxType, direction, entityType });
    res.json({ data });
  } catch (err) { next(err); }
});

router.get("/reconciliation", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { from, to, taxType } = req.query;
    const data = await svc.taxReconciliation({ orgId, fromDate: from, toDate: to, taxType });
    res.json({ data });
  } catch (err) { next(err); }
});

router.get("/diagnostics", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { from, to } = req.query;
    const data = await svc.taxDiagnostics({ orgId, fromDate: from, toDate: to });
    res.json({ data });
  } catch (err) { next(err); }
});

router.get("/returns/:returnId", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const data = await svc.getReturnById({ orgId, returnId: req.params.returnId });
    if (!data) throw new AppError(404, "The selected tax return could not be found.", { returnId: req.params.returnId }, "tax_return_not_found");
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/returns/:returnId/submit", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.submitReturnForApproval({ orgId, actorUserId, returnId: req.params.returnId });
    await writeAudit({ organizationId: orgId, actorUserId, action: "reporting.tax.return.submit", entityType: "tax_return", entityId: req.params.returnId, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: data });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/returns/:returnId/approve", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.approveReturnWorkflow({ orgId, actorUserId, returnId: req.params.returnId, comment: req.body?.comment || null });
    await writeAudit({ organizationId: orgId, actorUserId, action: "reporting.tax.return.approve", entityType: "tax_return", entityId: req.params.returnId, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: data });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/returns/:returnId/reject", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.rejectReturnWorkflow({ orgId, actorUserId, returnId: req.params.returnId, comment: req.body?.comment || null });
    await writeAudit({ organizationId: orgId, actorUserId, action: "reporting.tax.return.reject", entityType: "tax_return", entityId: req.params.returnId, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: data });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/returns/:returnId/finalize", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.finalizeReturn({ orgId, actorUserId, returnId: req.params.returnId });
    await writeAudit({ organizationId: orgId, actorUserId, action: "reporting.tax.return.finalize", entityType: "tax_return", entityId: req.params.returnId, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: data });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/returns", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { taxType, from, to } = req.query;
    const data = await svc.listReturns({ orgId, taxType, fromDate: from, toDate: to });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
