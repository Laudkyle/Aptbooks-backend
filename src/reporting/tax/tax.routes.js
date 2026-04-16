const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");
const svc = require("./tax.service");
const { AppError } = require('../../shared/errors/AppError');

const router = express.Router();
router.use(requirePermission("reporting.tax.read"));

router.get("/vat-summary", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { from, to } = req.query;
    res.json({ data: await svc.vatSummary({ orgId, fromDate: from, toDate: to }) });
  } catch (err) { next(err); }
});

router.get("/vat-return", async (req, res, next) => {
  try {
    const { organization_id: orgId, id: userId } = req.user;
    const { from, to, templateCode } = req.query;
    res.json({ data: await svc.vatReturn({ orgId, userId, fromDate: from, toDate: to, templateCode }) });
  } catch (err) { next(err); }
});

router.get('/jurisdiction-return', async (req, res, next) => {
  try {
    const { organization_id: orgId, id: userId } = req.user;
    const { from, to, templateCode, jurisdictionId } = req.query;
    res.json({ data: await svc.jurisdictionReturn({ orgId, userId, fromDate: from, toDate: to, templateCode, jurisdictionId: jurisdictionId || null }) });
  } catch (err) { next(err); }
});

router.get('/country-packs', async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.listCountryPacks({ orgId }) });
  } catch (err) { next(err); }
});

router.get('/filing-adapters', async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.listFilingAdapters({ orgId }) });
  } catch (err) { next(err); }
});

router.post('/filing-runs', requirePermission('tax.manage'), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    res.status(201).json({ data: await svc.queueFilingRun({ orgId, actorUserId, taxReturnId: req.body?.taxReturnId, adapterCode: req.body?.adapterCode }) });
  } catch (err) { next(err); }
});

router.get('/filing-runs', async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.listFilingRuns({ orgId, status: req.query.status || null }) });
  } catch (err) { next(err); }
});


router.get('/withholding-summary', async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { from, to } = req.query;
    const data = await svc.taxTransactions({ orgId, fromDate: from, toDate: to, taxType: 'WITHHOLDING' });
    const summary = data.reduce((acc, row) => {
      acc.totalTax += Number(row.signed_tax_amount || 0);
      acc.totalTaxable += Number(row.signed_taxable_amount || 0);
      return acc;
    }, { totalTax: 0, totalTaxable: 0, count: data.length, from, to, taxType: 'WITHHOLDING' });
    summary.totalTax = Number(summary.totalTax.toFixed(2));
    summary.totalTaxable = Number(summary.totalTaxable.toFixed(2));
    res.json({ data: summary });
  } catch (err) { next(err); }
});

router.get('/recoverability', async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { from, to } = req.query;
    const data = await svc.taxTransactions({ orgId, fromDate: from, toDate: to, taxType: req.query.taxType || 'VAT' });
    const rows = data.map((row) => ({
      ...row,
      recoverable_percent: row.recoverable_percent ?? 1,
      recoverable_tax_amount: Number((Number(row.signed_tax_amount || 0) * Number(row.recoverable_percent ?? 1)).toFixed(2)),
      non_recoverable_tax_amount: Number((Number(row.signed_tax_amount || 0) * (1 - Number(row.recoverable_percent ?? 1))).toFixed(2))
    }));
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.get('/einvoicing', async (req, res, next) => {
  try {
    res.json({ data: [] });
  } catch (err) { next(err); }
});

router.get('/jurisdiction-returns', async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { from, to, templateCode, jurisdictionId } = req.query;
    res.json({ data: await svc.jurisdictionReturn({ orgId, userId: req.user.id, fromDate: from, toDate: to, templateCode, jurisdictionId: jurisdictionId || null }) });
  } catch (err) { next(err); }
});

router.get('/realtime-filings', async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.listFilingRuns({ orgId, status: req.query.status || null }) });
  } catch (err) { next(err); }
});

router.get('/country-pack-readiness', async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const packs = await svc.listCountryPacks({ orgId });
    res.json({ data: packs.map((row) => ({ ...row, readiness: row.is_active ? 'ready' : 'not_ready' })) });
  } catch (err) { next(err); }
});

router.get("/transactions", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { from, to, taxType, direction, entityType } = req.query;
    res.json({ data: await svc.taxTransactions({ orgId, fromDate: from, toDate: to, taxType, direction, entityType }) });
  } catch (err) { next(err); }
});

router.get("/reconciliation", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { from, to, taxType } = req.query;
    res.json({ data: await svc.taxReconciliation({ orgId, fromDate: from, toDate: to, taxType }) });
  } catch (err) { next(err); }
});

router.get("/diagnostics", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { from, to } = req.query;
    res.json({ data: await svc.taxDiagnostics({ orgId, fromDate: from, toDate: to }) });
  } catch (err) { next(err); }
});

router.get("/returns/:returnId", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const data = await svc.getReturnById({ orgId, returnId: req.params.returnId });
    if (!data) throw new AppError(404, "The selected tax return could not be found.", { returnId: req.params.returnId }, "tax_return_not_found");
    res.json({ data });
  } catch (err) { next(err); }
});

router.post("/returns/:returnId/submit", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.submitReturnForApproval({ orgId, actorUserId, returnId: req.params.returnId });
    await writeAudit({ organizationId: orgId, actorUserId, action: "reporting.tax.return.submit", entityType: "tax_return", entityId: req.params.returnId, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: data });
    res.json({ data });
  } catch (err) { next(err); }
});

router.post("/returns/:returnId/approve", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.approveReturnWorkflow({ orgId, actorUserId, returnId: req.params.returnId, comment: req.body?.comment || null });
    await writeAudit({ organizationId: orgId, actorUserId, action: "reporting.tax.return.approve", entityType: "tax_return", entityId: req.params.returnId, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: data });
    res.json({ data });
  } catch (err) { next(err); }
});

router.post("/returns/:returnId/reject", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.rejectReturnWorkflow({ orgId, actorUserId, returnId: req.params.returnId, comment: req.body?.comment || null });
    await writeAudit({ organizationId: orgId, actorUserId, action: "reporting.tax.return.reject", entityType: "tax_return", entityId: req.params.returnId, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: data });
    res.json({ data });
  } catch (err) { next(err); }
});

router.post("/returns/:returnId/finalize", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.finalizeReturn({ orgId, actorUserId, returnId: req.params.returnId });
    await writeAudit({ organizationId: orgId, actorUserId, action: "reporting.tax.return.finalize", entityType: "tax_return", entityId: req.params.returnId, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: data });
    res.json({ data });
  } catch (err) { next(err); }
});

router.get("/returns", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { taxType, from, to } = req.query;
    res.json({ data: await svc.listReturns({ orgId, taxType, fromDate: from, toDate: to }) });
  } catch (err) { next(err); }
});

module.exports = router;
