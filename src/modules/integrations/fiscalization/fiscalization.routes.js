const { createModuleBodyContract } = require("../../../shared/http/requestValidation");
const router = require('express').Router();
router.use(createModuleBodyContract(['adapterCode', 'adapterMode', 'adapter_code', 'adapter_mode', 'address', 'apiContractVersion', 'apiEndpoint', 'apiKey', 'apiSecret', 'api_contract_version', 'api_endpoint', 'autoPrepareInvoices', 'autoPreparePos', 'autoQueue', 'buyer', 'buyerTaxIdRequiredForInputCredit', 'code', 'currencyCode', 'device', 'deviceCode', 'deviceName', 'deviceSerialNumber', 'documentNumber', 'enabled', 'fiscalLocationId', 'graBranchReference', 'graGoLiveDate', 'gra_go_live_date', 'invoiceAt', 'limit', 'lines', 'machineRegistrationCode', 'metadata', 'name', 'offlineWindowHours', 'onboardingStatus', 'onboarding_status', 'posDeviceId', 'reason', 'registerId', 'requireCustomerTaxIdForInputCredit', 'security', 'seller', 'sourceId', 'sourceType', 'status', 'storeId', 'supplyAt', 'taxSummary', 'totals', 'transactionType', 'verificationEngineId']));
const { authRequired } = require('../../../middleware/auth.middleware');
const { requirePermission } = require('../../../middleware/permission.middleware');
const { idempotency } = require('../../../middleware/idempotency.middleware');
const { writeAudit } = require('../../../core/foundation/audit-logs/audit.service');
const { AppError } = require('../../../shared/errors/AppError');
const svc = require('./fiscalization.service');

router.use(authRequired);
const org = (req) => req.user.organization_id;

router.get('/settings', requirePermission('fiscalization.read'), async (req,res,next) => {
  try { res.json(await svc.getSettings({ orgId: org(req) })); } catch (e) { next(e); }
});
router.put('/settings', requirePermission('fiscalization.manage'), async (req,res,next) => {
  try {
    const out = await svc.saveSettings({ orgId: org(req), actorUserId: req.user.id, payload: req.body || {} });
    await writeAudit({ organizationId: org(req), actorUserId: req.user.id, action: 'fiscalization.settings.updated', entityType: 'fiscalization_settings', entityId: null, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: out });
    res.json(out);
  } catch (e) { next(e); }
});

router.get('/readiness', requirePermission('fiscalization.read'), async (req,res,next) => {
  try { res.json(await svc.readiness({ orgId: org(req) })); } catch (e) { next(e); }
});

router.get('/locations', requirePermission('fiscalization.read'), async (req,res,next) => {
  try { res.json(await svc.listLocations({ orgId: org(req) })); } catch (e) { next(e); }
});
router.post('/locations', idempotency({ required: true }), requirePermission('fiscalization.manage'), async (req,res,next) => {
  try { res.status(201).json(await svc.saveLocation({ orgId: org(req), payload: req.body || {} })); } catch (e) { next(e); }
});
router.get('/devices', requirePermission('fiscalization.read'), async (req,res,next) => {
  try { res.json(await svc.listDevices({ orgId: org(req) })); } catch (e) { next(e); }
});
router.post('/devices', idempotency({ required: true }), requirePermission('fiscalization.manage'), async (req,res,next) => {
  try { res.status(201).json(await svc.saveDevice({ orgId: org(req), payload: req.body || {} })); } catch (e) { next(e); }
});

router.get('/documents', requirePermission('fiscalization.read'), async (req,res,next) => {
  try { res.json(await svc.listDocuments({ orgId: org(req), query: req.query || {} })); } catch (e) { next(e); }
});
router.get('/documents/:id', requirePermission('fiscalization.read'), async (req,res,next) => {
  try { const out = await svc.getDocument({ orgId: org(req), id: req.params.id }); if (!out) throw new AppError(404,'Fiscal document not found'); res.json(out); } catch (e) { next(e); }
});
router.post('/documents/prepare', idempotency({ required: true }), requirePermission('fiscalization.operate'), async (req,res,next) => {
  try {
    const sourceType = req.body?.sourceType; const sourceId = req.body?.sourceId;
    if (!sourceType || !sourceId) throw new AppError(400, 'sourceType and sourceId are required');
    const out = await svc.prepareFiscalDocument({ orgId: org(req), actorUserId: req.user.id, sourceType, sourceId, force: true });
    res.status(201).json(out);
  } catch (e) { next(e); }
});
router.post('/invoices/:invoiceId/prepare', idempotency({ required: true }), requirePermission('fiscalization.operate'), async (req,res,next) => {
  try { res.status(201).json(await svc.prepareFiscalDocument({ orgId: org(req), actorUserId: req.user.id, sourceType: 'invoice', sourceId: req.params.invoiceId, force: true })); } catch (e) { next(e); }
});
router.post('/pos-sales/:saleId/prepare', idempotency({ required: true }), requirePermission('fiscalization.operate'), async (req,res,next) => {
  try { res.status(201).json(await svc.prepareFiscalDocument({ orgId: org(req), actorUserId: req.user.id, sourceType: 'pos_sale', sourceId: req.params.saleId, force: true })); } catch (e) { next(e); }
});
router.post('/documents/:id/queue', idempotency({ required: true }), requirePermission('fiscalization.operate'), async (req,res,next) => {
  try { res.status(201).json(await svc.queueFiscalDocument({ orgId: org(req), actorUserId: req.user.id, fiscalDocumentId: req.params.id })); } catch (e) { next(e); }
});
router.post('/documents/:id/offline', idempotency({ required: true }), requirePermission('fiscalization.operate'), async (req,res,next) => {
  try { res.json(await svc.markOffline({ orgId: org(req), actorUserId: req.user.id, fiscalDocumentId: req.params.id, reason: req.body?.reason || 'connectivity_unavailable' })); } catch (e) { next(e); }
});

router.get('/queue', requirePermission('fiscalization.read'), async (req,res,next) => {
  try { res.json(await svc.listQueue({ orgId: org(req), query: req.query || {} })); } catch (e) { next(e); }
});
router.post('/queue/process', requirePermission('fiscalization.retry'), async (req,res,next) => {
  try { res.json(await svc.processQueue({ orgId: org(req), workerId: `api:${req.user.id}`, limit: req.body?.limit || 10 })); } catch (e) { next(e); }
});
router.get('/logs/export.csv', requirePermission('fiscalization.read'), async (req,res,next) => {
  try {
    const csv = await svc.exportLogsCsv({ orgId: org(req) });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="gra-evat-system-logs.csv"');
    res.send(csv);
  } catch (e) { next(e); }
});
router.get('/logs', requirePermission('fiscalization.read'), async (req,res,next) => {
  try { res.json(await svc.listLogs({ orgId: org(req), query: req.query || {} })); } catch (e) { next(e); }
});

module.exports = router;
