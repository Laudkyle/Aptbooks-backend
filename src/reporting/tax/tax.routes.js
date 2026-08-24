const { createModuleBodyContract } = require("../../shared/http/requestValidation");
const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");
const svc = require("./tax.service");
const { AppError } = require('../../shared/errors/AppError');
const Decimal = require("decimal.js");

const router = express.Router();
router.use(createModuleBodyContract(['adapterCode', 'boxes', 'comment', 'from', 'includeGhanaComponents', 'jurisdictionId', 'jurisdiction_template', 'minus', 'taxReturnId', 'tax_type', 'template', 'templateCode', 'to', 'totals', 'transactions']));
const { resolveOrgId } = require("../_util");
router.use(requirePermission("reporting.tax.read"));

function getOrganizationId(req) {
  const user = req.user || {};
  const orgId = user.organization_id || user.organizationId || user.org_id || user.orgId;
  if (!orgId) throw new AppError(401, 'Organization context is required for tax reporting');
  return orgId;
}

function getActorUserId(req) {
  return req.user?.id || req.user?.user_id || req.user?.userId || null;
}

router.get("/vat-summary", async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { from, to } = req.query;
    res.json({ data: await svc.vatSummary({ orgId, fromDate: from, toDate: to }) });
  } catch (err) { next(err); }
});

router.get("/vat-return", async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { from, to, templateCode } = req.query;
    res.json({ data: await svc.vatReturn({ orgId, fromDate: from, toDate: to, templateCode }) });
  } catch (err) { next(err); }
});

router.post("/vat-returns", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const userId = getActorUserId(req);
    const { from, to, templateCode, jurisdictionId, includeGhanaComponents } = req.body || {};
    res.status(201).json({ data: await svc.createVatReturn({ orgId, userId, fromDate: from, toDate: to, templateCode, jurisdictionId: jurisdictionId || null, includeGhanaComponents: Boolean(includeGhanaComponents) }) });
  } catch (err) { next(err); }
});

router.get('/jurisdiction-return', async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { from, to, templateCode, jurisdictionId } = req.query;
    res.json({ data: await svc.jurisdictionReturn({ orgId, fromDate: from, toDate: to, templateCode, jurisdictionId: jurisdictionId || null }) });
  } catch (err) { next(err); }
});

router.post('/jurisdiction-returns', idempotency({ required: true }), requirePermission('tax.manage'), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const userId = getActorUserId(req);
    const { from, to, templateCode, jurisdictionId } = req.body || {};
    res.status(201).json({ data: await svc.createJurisdictionReturn({ orgId, userId, fromDate: from, toDate: to, templateCode, jurisdictionId: jurisdictionId || null }) });
  } catch (err) { next(err); }
});

router.get('/country-packs', async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json({ data: await svc.listCountryPacks({ orgId }) });
  } catch (err) { next(err); }
});

router.get('/filing-adapters', async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json({ data: await svc.listFilingAdapters({ orgId }) });
  } catch (err) { next(err); }
});

router.post('/filing-runs', requirePermission('tax.manage'), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const actorUserId = getActorUserId(req);
    res.status(201).json({ data: await svc.queueFilingRun({ orgId, actorUserId, taxReturnId: req.body?.taxReturnId, adapterCode: req.body?.adapterCode }) });
  } catch (err) { next(err); }
});

router.get('/filing-runs', async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json({ data: await svc.listFilingRuns({ orgId, status: req.query.status || null }) });
  } catch (err) { next(err); }
});


router.get('/withholding-summary', async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { from, to } = req.query;
    res.json({ data: await svc.withholdingReport({ orgId, fromDate: from, toDate: to, mode: 'summary' }) });
  } catch (err) { next(err); }
});

router.get('/withholding/payable', async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { from, to } = req.query;
    res.json({ data: await svc.withholdingReport({ orgId, fromDate: from, toDate: to, mode: 'payable' }) });
  } catch (err) { next(err); }
});

router.get('/withholding/receivable', async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { from, to } = req.query;
    res.json({ data: await svc.withholdingReport({ orgId, fromDate: from, toDate: to, mode: 'receivable' }) });
  } catch (err) { next(err); }
});

router.get('/withholding/open-items', async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { from, to } = req.query;
    res.json({ data: await svc.withholdingReport({ orgId, fromDate: from, toDate: to, mode: 'open_items' }) });
  } catch (err) { next(err); }
});

router.get('/withholding/reconciliation', async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { from, to } = req.query;
    res.json({ data: await svc.withholdingReconciliation({ orgId, fromDate: from, toDate: to }) });
  } catch (err) { next(err); }
});

router.get('/recoverability', async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { from, to } = req.query;
    const data = await svc.taxTransactions({ orgId, fromDate: from, toDate: to, taxType: req.query.taxType || 'VAT' });
    const rows = data.map((row) => ({
      ...row,
      recoverable_tax_amount: row.signed_recoverable_amount,
      non_recoverable_tax_amount: row.signed_nonrecoverable_amount,
      recovery_basis: row.recovery_basis || 'not_applicable'
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
    const orgId = getOrganizationId(req);
    const { from, to, templateCode, jurisdictionId } = req.query;
    res.json({ data: await svc.jurisdictionReturn({ orgId, fromDate: from, toDate: to, templateCode, jurisdictionId: jurisdictionId || null }) });
  } catch (err) { next(err); }
});

router.get('/realtime-filings', async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    res.json({ data: await svc.listFilingRuns({ orgId, status: req.query.status || null }) });
  } catch (err) { next(err); }
});

router.get('/country-pack-readiness', async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const packs = await svc.listCountryPacks({ orgId });
    res.json({ data: packs });
  } catch (err) { next(err); }
});

router.get('/ghana/vat-return', async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { from, to, templateCode } = req.query;
    res.json({ data: await svc.ghanaVatReturn({ orgId, fromDate: from, toDate: to, templateCode }) });
  } catch (err) { next(err); }
});

router.get('/ghana/vat-transactions', async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { from, to } = req.query;
    res.json({ data: await svc.ghanaVatTransactions({ orgId, fromDate: from, toDate: to }) });
  } catch (err) { next(err); }
});

router.get('/ghana/vat-reconciliation', async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { from, to } = req.query;
    res.json({ data: await svc.ghanaVatReconciliation({ orgId, fromDate: from, toDate: to }) });
  } catch (err) { next(err); }
});

router.get('/ghana/imported-services-summary', async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { from, to } = req.query;
    res.json({ data: await svc.importedServicesVatSummary({ orgId, fromDate: from, toDate: to }) });
  } catch (err) { next(err); }
});

router.get("/transactions", async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { from, to, taxType, direction, entityType } = req.query;
    res.json({ data: await svc.taxTransactions({ orgId, fromDate: from, toDate: to, taxType, direction, entityType }) });
  } catch (err) { next(err); }
});

router.get("/reconciliation", async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { from, to, taxType } = req.query;
    res.json({ data: await svc.taxReconciliation({ orgId, fromDate: from, toDate: to, taxType }) });
  } catch (err) { next(err); }
});

router.get("/diagnostics", async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { from, to } = req.query;
    res.json({ data: await svc.taxDiagnostics({ orgId, fromDate: from, toDate: to }) });
  } catch (err) { next(err); }
});

router.get("/returns/:returnId", async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const data = await svc.getReturnById({ orgId, returnId: req.params.returnId });
    if (!data) throw new AppError(404, "The selected tax return could not be found.", { returnId: req.params.returnId }, "tax_return_not_found");
    res.json({ data });
  } catch (err) { next(err); }
});

router.post("/returns/:returnId/submit", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const actorUserId = getActorUserId(req);
    const data = await svc.submitReturnForApproval({ orgId, actorUserId, returnId: req.params.returnId });
    await writeAudit({ organizationId: orgId, actorUserId, action: "reporting.tax.return.submit", entityType: "tax_return", entityId: req.params.returnId, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: data });
    res.json({ data });
  } catch (err) { next(err); }
});

router.post("/returns/:returnId/approve", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const actorUserId = getActorUserId(req);
    const data = await svc.approveReturnWorkflow({ orgId, actorUserId, returnId: req.params.returnId, comment: req.body?.comment || null });
    await writeAudit({ organizationId: orgId, actorUserId, action: "reporting.tax.return.approve", entityType: "tax_return", entityId: req.params.returnId, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: data });
    res.json({ data });
  } catch (err) { next(err); }
});

router.post("/returns/:returnId/reject", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const actorUserId = getActorUserId(req);
    const data = await svc.rejectReturnWorkflow({ orgId, actorUserId, returnId: req.params.returnId, comment: req.body?.comment || null });
    await writeAudit({ organizationId: orgId, actorUserId, action: "reporting.tax.return.reject", entityType: "tax_return", entityId: req.params.returnId, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: data });
    res.json({ data });
  } catch (err) { next(err); }
});

router.post("/returns/:returnId/finalize", idempotency({ required: true }), requirePermission("tax.manage"), async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const actorUserId = getActorUserId(req);
    const data = await svc.finalizeReturn({ orgId, actorUserId, returnId: req.params.returnId });
    await writeAudit({ organizationId: orgId, actorUserId, action: "reporting.tax.return.finalize", entityType: "tax_return", entityId: req.params.returnId, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: data });
    res.json({ data });
  } catch (err) { next(err); }
});

router.get("/returns", async (req, res, next) => {
  try {
    const orgId = getOrganizationId(req);
    const { taxType, from, to } = req.query;
    res.json({ data: await svc.listReturns({ orgId, taxType, fromDate: from, toDate: to }) });
  } catch (err) { next(err); }
});

module.exports = router;
