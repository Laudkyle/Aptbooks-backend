const { createModuleBodyContract } = require("../../../shared/http/requestValidation");
const router = require("express").Router();
router.use(createModuleBodyContract(['adapterCode']));
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");
const { AppError } = require("../../../shared/errors/AppError");
const svc = require("./einvoicing.service");

router.use(authRequired);

router.post("/invoices/:invoiceId/generate", requirePermission("einvoicing.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const out = await svc.generateInvoiceEInvoice({ orgId, actorUserId, invoiceId: req.params.invoiceId });
    await writeAudit({ organizationId: orgId, actorUserId, action: "einvoicing.generated", entityType: "e_invoices", entityId: out.id, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: out });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

router.get('/transmissions/list', requirePermission('einvoicing.read'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await svc.listTransmissions({ orgId, eInvoiceId: req.query.eInvoiceId || null });
    res.json(out);
  } catch (e) { next(e); }
});

router.get('/:id', requirePermission('einvoicing.read'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await svc.getEInvoice({ orgId, id: req.params.id });
    if (!out) throw new AppError(404, 'E-invoice not found');
    res.json(out);
  } catch (e) { next(e); }
});

router.get('/:id/payload', requirePermission('einvoicing.read'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await svc.getEInvoice({ orgId, id: req.params.id });
    if (!out) throw new AppError(404, 'E-invoice not found');
    res.json(out.payload_json || {});
  } catch (e) { next(e); }
});

router.post('/:id/queue', requirePermission('einvoicing.manage'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const out = await svc.queueTransmission({ orgId, actorUserId, eInvoiceId: req.params.id, adapterCode: req.body?.adapterCode || 'PEPPOL_SIM' });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

router.get('/:id/xml', requirePermission('einvoicing.read'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await svc.getEInvoice({ orgId, id: req.params.id });
    if (!out) throw new AppError(404, 'E-invoice not found');
    res.setHeader('Content-Type', 'application/xml');
    res.send(out.ubl_xml);
  } catch (e) { next(e); }
});

module.exports = router;
