const { createModuleBodyContract } = require("../../shared/http/requestValidation");
const router = require('express').Router();
router.use(createModuleBodyContract(['address', 'amount', 'batchNo', 'cartId', 'cashOverShortAccountId', 'channel', 'channelCode', 'closingCashAmount', 'code', 'cogsAccountId', 'config', 'countedAmount', 'currencyCode', 'currency_code', 'customerId', 'defaultCashAccountId', 'deviceCode', 'deviceLabel', 'deviceName', 'discountAccountId', 'discountValue', 'displayName', 'disposition', 'effectiveFrom', 'effectiveTo', 'email', 'endsAt', 'event', 'eventId', 'expectedAmount', 'id', 'idempotencyKey', 'inventoryAccountId', 'isDefault', 'itemId', 'lines', 'maxDiscountAmount', 'memo', 'metadata', 'minSpendAmount', 'movementType', 'name', 'note', 'notes', 'openingCashAmount', 'orderDate', 'orderId', 'orderNo', 'payments', 'phone', 'points', 'price', 'promotionId', 'promotionType', 'provider', 'providerId', 'providerPayload', 'providerType', 'reason', 'reference', 'registerId', 'requiresApproval', 'returnNo', 'rows', 'saleDate', 'saleId', 'saleNo', 'salesReturnsAccountId', 'salesRevenueAccountId', 'shiftId', 'sourceOrderId', 'startsAt', 'status', 'storeId', 'subtotal', 'taxCodeId', 'taxInclusive', 'type', 'usageLimit', 'warehouseId']));
const { authRequired } = require('../../middleware/auth.middleware');
const { requirePermission } = require('../../middleware/permission.middleware');
const { idempotency } = require('../../middleware/idempotency.middleware');
const svc = require('./commerce.service');

function orgId(req) {
  const id = req.user?.organization_id || req.user?.organizationId || req.user?.org_id || req.user?.orgId;
  if (!id) {
    const { AppError } = require('../../shared/errors/AppError');
    throw new AppError(401, 'Missing organization context');
  }
  return id;
}

router.use(authRequired);

// Existing master data exposed for POS/e-commerce without duplicating products/customers.
router.get('/catalog/products', requirePermission('commerce.catalog.read'), async (req, res, next) => {
  try { res.json(await svc.listProducts({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/catalog/prices', requirePermission('commerce.catalog.read'), async (req, res, next) => {
  try { res.json(await svc.catalogPrices({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/catalog/products/:id', requirePermission('commerce.catalog.read'), async (req, res, next) => {
  try { res.json(await svc.getProduct({ orgId: orgId(req), itemId: req.params.id })); } catch (e) { next(e); }
});
router.get('/customers', requirePermission('commerce.customers.read'), async (req, res, next) => {
  try { res.json(await svc.listCustomers({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/customers/:id/purchase-history', requirePermission('commerce.customers.read'), async (req, res, next) => {
  try { res.json(await svc.customerPurchaseHistory({ orgId: orgId(req), customerId: req.params.id })); } catch (e) { next(e); }
});

// Price lists reference existing inventory items.
router.get('/price-lists', requirePermission('commerce.catalog.read'), async (req, res, next) => {
  try { res.json(await svc.listPriceLists({ orgId: orgId(req) })); } catch (e) { next(e); }
});
router.post('/price-lists', idempotency({ required: true }), requirePermission('commerce.catalog.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createPriceList({ orgId: orgId(req), actorUserId: req.user.id, payload: req.body })); } catch (e) { next(e); }
});
router.put('/price-lists/:id', idempotency({ required: true }), requirePermission('commerce.catalog.manage'), async (req, res, next) => {
  try { res.json(await svc.updatePriceList({ orgId: orgId(req), priceListId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/price-lists/:id/items', idempotency({ required: true }), requirePermission('commerce.catalog.manage'), async (req, res, next) => {
  try { res.json(await svc.upsertPriceListItem({ orgId: orgId(req), priceListId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.put('/price-lists/:id/items', idempotency({ required: true }), requirePermission('commerce.catalog.manage'), async (req, res, next) => {
  try { res.json(await svc.upsertPriceListItem({ orgId: orgId(req), priceListId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});

// POS setup
router.get('/pos/stores', requirePermission('pos.setup.read'), async (req, res, next) => {
  try { res.json(await svc.listStores({ orgId: orgId(req) })); } catch (e) { next(e); }
});
router.post('/pos/stores', idempotency({ required: true }), requirePermission('pos.setup.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createStore({ orgId: orgId(req), payload: req.body })); } catch (e) { next(e); }
});
router.put('/pos/stores/:id', idempotency({ required: true }), requirePermission('pos.setup.manage'), async (req, res, next) => {
  try { res.json(await svc.updateStore({ orgId: orgId(req), storeId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.patch('/pos/stores/:id', idempotency({ required: true }), requirePermission('pos.setup.manage'), async (req, res, next) => {
  try { res.json(await svc.updateStore({ orgId: orgId(req), storeId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.get('/pos/registers', requirePermission('pos.setup.read'), async (req, res, next) => {
  try { res.json(await svc.listRegisters({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.post('/pos/registers', idempotency({ required: true }), requirePermission('pos.setup.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createRegister({ orgId: orgId(req), payload: req.body })); } catch (e) { next(e); }
});
router.put('/pos/registers/:id', idempotency({ required: true }), requirePermission('pos.setup.manage'), async (req, res, next) => {
  try { res.json(await svc.updateRegister({ orgId: orgId(req), registerId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.patch('/pos/registers/:id', idempotency({ required: true }), requirePermission('pos.setup.manage'), async (req, res, next) => {
  try { res.json(await svc.updateRegister({ orgId: orgId(req), registerId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});

router.get('/pos/shifts', requirePermission('pos.setup.read'), async (req, res, next) => {
  try { res.json(await svc.listShifts({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/pos/devices', requirePermission('pos.setup.read'), async (req, res, next) => {
  try { res.json(await svc.listDevices({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/pos/accounting-profiles', requirePermission('pos.setup.read'), async (req, res, next) => {
  try { res.json(await svc.listAccountingProfiles({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.post('/pos/accounting-profiles', idempotency({ required: true }), requirePermission('pos.setup.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.saveAccountingProfile({ orgId: orgId(req), payload: req.body })); } catch (e) { next(e); }
});
router.get('/payment-methods', requirePermission('pos.setup.read'), async (req, res, next) => {
  try { res.json(await svc.listPaymentMethods({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/payment-providers', requirePermission('pos.setup.read'), async (req, res, next) => {
  try { res.json(await svc.listPaymentProviders({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.post('/payment-providers', idempotency({ required: true }), requirePermission('pos.setup.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.savePaymentProvider({ orgId: orgId(req), payload: req.body })); } catch (e) { next(e); }
});

// POS shifts and cash control
router.post('/pos/shifts/open', idempotency({ required: true }), requirePermission('pos.shift.open'), async (req, res, next) => {
  try { res.status(201).json(await svc.openShift({ orgId: orgId(req), actorUserId: req.user.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/pos/shifts/:id/close', idempotency({ required: true }), requirePermission('pos.shift.close'), async (req, res, next) => {
  try { res.json(await svc.closeShift({ orgId: orgId(req), actorUserId: req.user.id, shiftId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.get('/pos/shifts/:id/summary', requirePermission('pos.reports.view'), async (req, res, next) => {
  try { res.json(await svc.shiftSummary({ orgId: orgId(req), shiftId: req.params.id })); } catch (e) { next(e); }
});
router.get('/cash/movements', requirePermission('pos.cash.manage'), async (req, res, next) => {
  try { res.json(await svc.listCashMovements({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.post('/cash/movements', idempotency({ required: true }), requirePermission('pos.cash.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.recordCashMovement({ orgId: orgId(req), actorUserId: req.user.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/cash/movement', idempotency({ required: true }), requirePermission('pos.cash.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.recordCashMovement({ orgId: orgId(req), actorUserId: req.user.id, payload: req.body })); } catch (e) { next(e); }
});

// Sales
router.post('/pos/tax-preview', requirePermission('pos.sale.create'), async (req, res, next) => {
  try { res.json(await svc.taxPreview({ orgId: orgId(req), payload: req.body })); } catch (e) { next(e); }
});
router.post('/pos/sales', idempotency({ required: true }), requirePermission('pos.sale.create'), async (req, res, next) => {
  try { res.status(201).json(await svc.createSale({ orgId: orgId(req), actorUserId: req.user.id, payload: req.body })); } catch (e) { next(e); }
});
router.get('/pos/sales', requirePermission('pos.sale.read'), async (req, res, next) => {
  try { res.json(await svc.listSales({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/pos/sales/:id', requirePermission('pos.sale.read'), async (req, res, next) => {
  try { res.json(await svc.getSale({ orgId: orgId(req), saleId: req.params.id })); } catch (e) { next(e); }
});
router.post('/pos/sales/:id/complete', idempotency({ required: true }), requirePermission('pos.sale.create'), async (req, res, next) => {
  try { res.json(await svc.completeSale({ orgId: orgId(req), actorUserId: req.user.id, saleId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/pos/sales/:id/post', idempotency({ required: true }), requirePermission('pos.sale.post'), async (req, res, next) => {
  try { res.json(await svc.postSale({ orgId: orgId(req), actorUserId: req.user.id, saleId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/pos/sales/:id/void', idempotency({ required: true }), requirePermission('pos.sale.void'), async (req, res, next) => {
  try { res.json(await svc.voidSale({ orgId: orgId(req), actorUserId: req.user.id, saleId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/pos/sales/:id/refund', idempotency({ required: true }), requirePermission('pos.sale.refund'), async (req, res, next) => {
  try { res.json(await svc.refundSale({ orgId: orgId(req), actorUserId: req.user.id, saleId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/pos/sales/:id/email-receipt', idempotency({ required: true }), requirePermission('pos.sale.read'), async (req, res, next) => {
  try { res.json(await svc.emailReceipt({ orgId: orgId(req), saleId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/pos/sales/:id/whatsapp-receipt', idempotency({ required: true }), requirePermission('pos.sale.read'), async (req, res, next) => {
  try { res.json(await svc.whatsappReceipt({ orgId: orgId(req), saleId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.get('/pos/sales/:id/receipt', requirePermission('pos.sale.read'), async (req, res, next) => {
  try { res.json(await svc.receiptData({ orgId: orgId(req), saleId: req.params.id })); } catch (e) { next(e); }
});

// E-commerce order foundation. Orders reference existing customers and inventory items.
router.get('/orders', requirePermission('commerce.orders.read'), async (req, res, next) => {
  try { res.json(await svc.listOrders({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/orders/:id', requirePermission('commerce.orders.read'), async (req, res, next) => {
  try { res.json(await svc.getOrder({ orgId: orgId(req), orderId: req.params.id })); } catch (e) { next(e); }
});
router.post('/cart', idempotency({ required: true }), requirePermission('commerce.orders.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createCart({ orgId: orgId(req), actorUserId: req.user.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/cart/:id/items', idempotency({ required: true }), requirePermission('commerce.orders.manage'), async (req, res, next) => {
  try { res.json(await svc.addCartItem({ orgId: orgId(req), cartId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/checkout', idempotency({ required: true }), requirePermission('commerce.orders.manage'), async (req, res, next) => {
  try { res.json(await svc.checkout({ orgId: orgId(req), actorUserId: req.user.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/orders', idempotency({ required: true }), requirePermission('commerce.orders.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createOrder({ orgId: orgId(req), actorUserId: req.user.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/orders/:id/pay', idempotency({ required: true }), requirePermission('commerce.orders.manage'), async (req, res, next) => {
  try { res.json(await svc.markOrderPaid({ orgId: orgId(req), orderId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/orders/:id/cancel', idempotency({ required: true }), requirePermission('commerce.orders.manage'), async (req, res, next) => {
  try { res.json(await svc.cancelOrder({ orgId: orgId(req), orderId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/orders/:id/refund', idempotency({ required: true }), requirePermission('commerce.orders.manage'), async (req, res, next) => {
  try { res.json(await svc.refundOrder({ orgId: orgId(req), orderId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/orders/:id/fulfill', idempotency({ required: true }), requirePermission('commerce.orders.manage'), async (req, res, next) => {
  try { res.json(await svc.fulfillOrderToSale({ orgId: orgId(req), actorUserId: req.user.id, orderId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});



// Returns and refunds
router.get('/returns', requirePermission('pos.return.manage'), async (req, res, next) => {
  try { res.json(await svc.listReturns({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/refunds', requirePermission('pos.refund.manage'), async (req, res, next) => {
  try { res.json(await svc.listRefunds({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.post('/returns', idempotency({ required: true }), requirePermission('pos.return.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createReturn({ orgId: orgId(req), actorUserId: req.user.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/returns/:id/approve', idempotency({ required: true }), requirePermission('pos.return.manage'), async (req, res, next) => {
  try { res.json(await svc.approveReturn({ orgId: orgId(req), actorUserId: req.user.id, returnId: req.params.id })); } catch (e) { next(e); }
});
router.post('/returns/:id/reject', idempotency({ required: true }), requirePermission('pos.return.manage'), async (req, res, next) => {
  try { res.json(await svc.rejectReturn({ orgId: orgId(req), actorUserId: req.user.id, returnId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/returns/:id/receive', idempotency({ required: true }), requirePermission('pos.return.manage'), async (req, res, next) => {
  try { res.json(await svc.receiveReturn({ orgId: orgId(req), actorUserId: req.user.id, returnId: req.params.id })); } catch (e) { next(e); }
});
router.post('/refunds', idempotency({ required: true }), requirePermission('pos.refund.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createRefund({ orgId: orgId(req), actorUserId: req.user.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/refunds/:id/approve', idempotency({ required: true }), requirePermission('pos.refund.manage'), async (req, res, next) => {
  try { res.json(await svc.approveRefund({ orgId: orgId(req), refundId: req.params.id })); } catch (e) { next(e); }
});
router.post('/refunds/:id/post', idempotency({ required: true }), requirePermission('pos.refund.manage'), async (req, res, next) => {
  try { res.json(await svc.postRefund({ orgId: orgId(req), actorUserId: req.user.id, refundId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});

// Promotions, coupons, loyalty and store credit
router.get('/promotions', requirePermission('commerce.promotions.manage'), async (req, res, next) => {
  try { res.json(await svc.listPromotions({ orgId: orgId(req) })); } catch (e) { next(e); }
});
router.post('/promotions', idempotency({ required: true }), requirePermission('commerce.promotions.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createPromotion({ orgId: orgId(req), payload: req.body })); } catch (e) { next(e); }
});
router.put('/promotions/:id', idempotency({ required: true }), requirePermission('commerce.promotions.manage'), async (req, res, next) => {
  try { res.json(await svc.updatePromotion({ orgId: orgId(req), promotionId: req.params.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/promotions/apply-preview', requirePermission('commerce.promotions.manage'), async (req, res, next) => {
  try { res.json(await svc.applyPromotionPreview({ orgId: orgId(req), payload: req.body })); } catch (e) { next(e); }
});
router.get('/coupons', requirePermission('commerce.promotions.manage'), async (req, res, next) => {
  try { res.json(await svc.listCoupons({ orgId: orgId(req) })); } catch (e) { next(e); }
});
router.post('/coupons', idempotency({ required: true }), requirePermission('commerce.promotions.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createCoupon({ orgId: orgId(req), payload: req.body })); } catch (e) { next(e); }
});
router.post('/coupons/validate', requirePermission('commerce.promotions.manage'), async (req, res, next) => {
  try { res.json(await svc.validateCoupon({ orgId: orgId(req), payload: req.body })); } catch (e) { next(e); }
});
router.get('/customers/:customerId/loyalty', requirePermission('commerce.loyalty.manage'), async (req, res, next) => {
  try { res.json(await svc.getLoyalty({ orgId: orgId(req), customerId: req.params.customerId })); } catch (e) { next(e); }
});
router.post('/customers/:customerId/loyalty/adjust', idempotency({ required: true }), requirePermission('commerce.loyalty.manage'), async (req, res, next) => {
  try { res.json(await svc.adjustLoyalty({ orgId: orgId(req), actorUserId: req.user.id, customerId: req.params.customerId, payload: req.body })); } catch (e) { next(e); }
});
router.get('/customers/:customerId/store-credit', requirePermission('commerce.loyalty.manage'), async (req, res, next) => {
  try { res.json(await svc.getStoreCredit({ orgId: orgId(req), customerId: req.params.customerId })); } catch (e) { next(e); }
});
router.post('/customers/:customerId/store-credit/adjust', idempotency({ required: true }), requirePermission('commerce.loyalty.manage'), async (req, res, next) => {
  try { res.json(await svc.adjustStoreCredit({ orgId: orgId(req), actorUserId: req.user.id, customerId: req.params.customerId, payload: req.body })); } catch (e) { next(e); }
});

// Cash count/deposit, devices, offline sync and payment providers
router.get('/cash/counts', requirePermission('pos.cash.manage'), async (req, res, next) => {
  try { res.json(await svc.listCashCounts({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/cash/deposits', requirePermission('pos.cash.manage'), async (req, res, next) => {
  try { res.json(await svc.listCashDeposits({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/cash/shift-summary', requirePermission('pos.cash.manage'), async (req, res, next) => {
  try { res.json(await svc.cashShiftSummary({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.post('/cash/counts', idempotency({ required: true }), requirePermission('pos.cash.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.recordCashCount({ orgId: orgId(req), actorUserId: req.user.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/cash/deposits', idempotency({ required: true }), requirePermission('pos.cash.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createCashDeposit({ orgId: orgId(req), actorUserId: req.user.id, payload: req.body })); } catch (e) { next(e); }
});
router.post('/pos/devices/register', idempotency({ required: true }), requirePermission('pos.setup.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.registerDevice({ orgId: orgId(req), payload: req.body })); } catch (e) { next(e); }
});
router.post('/pos/sync', idempotency({ required: true }), requirePermission('pos.sale.create'), async (req, res, next) => {
  try { res.json(await svc.syncOfflineBatch({ orgId: orgId(req), actorUserId: req.user.id, payload: req.body })); } catch (e) { next(e); }
});
router.get('/pos/sync/:batchId/status', requirePermission('pos.sale.read'), async (req, res, next) => {
  try { res.json(await svc.syncStatus({ orgId: orgId(req), batchId: req.params.batchId })); } catch (e) { next(e); }
});
router.post('/payments/initialize', idempotency({ required: true }), requirePermission('pos.sale.create'), async (req, res, next) => {
  try { res.status(201).json(await svc.initializePayment({ orgId: orgId(req), payload: req.body })); } catch (e) { next(e); }
});
router.post('/payments/confirm', idempotency({ required: true }), requirePermission('pos.sale.create'), async (req, res, next) => {
  try { res.json(await svc.confirmPayment({ orgId: orgId(req), payload: req.body })); } catch (e) { next(e); }
});
router.post('/payments/refund', idempotency({ required: true }), requirePermission('pos.refund.manage'), async (req, res, next) => {
  try { res.json(await svc.refundPayment({ orgId: orgId(req), payload: req.body })); } catch (e) { next(e); }
});
router.post('/payments/webhooks/:provider', async (req, res, next) => {
  try { res.json(await svc.recordPaymentWebhook({ orgId: req.user ? orgId(req) : null, provider: req.params.provider, payload: req.body, signatureValid: null })); } catch (e) { next(e); }
});
router.get('/payments/:id/status', requirePermission('pos.sale.read'), async (req, res, next) => {
  try { res.json(await svc.paymentStatus({ orgId: orgId(req), paymentId: req.params.id })); } catch (e) { next(e); }
});

// Reports
router.get('/reports/daily-sales', requirePermission('pos.reports.view'), async (req, res, next) => {
  try { res.json(await svc.dailySalesReport({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/reports/shift-summary', requirePermission('pos.reports.view'), async (req, res, next) => {
  try { res.json(await svc.shiftSummaryReport({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/reports/cashier-sales', requirePermission('pos.reports.view'), async (req, res, next) => {
  try { res.json(await svc.cashierSalesReport({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/reports/product-sales', requirePermission('pos.reports.view'), async (req, res, next) => {
  try { res.json(await svc.productSalesReport({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/reports/payment-reconciliation', requirePermission('pos.reports.view'), async (req, res, next) => {
  try { res.json(await svc.paymentReconciliationReport({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/reports/tax-summary', requirePermission('pos.reports.view'), async (req, res, next) => {
  try { res.json(await svc.taxSummaryReport({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});


router.get('/reports/category-sales', requirePermission('pos.reports.view'), async (req, res, next) => {
  try { res.json(await svc.categorySalesReport({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/reports/gross-margin', requirePermission('pos.reports.view'), async (req, res, next) => {
  try { res.json(await svc.grossMarginReport({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/reports/refunds-returns', requirePermission('pos.reports.view'), async (req, res, next) => {
  try { res.json(await svc.refundsReturnsReport({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/reports/discounts', requirePermission('pos.reports.view'), async (req, res, next) => {
  try { res.json(await svc.discountsReport({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/reports/customer-sales', requirePermission('pos.reports.view'), async (req, res, next) => {
  try { res.json(await svc.customerSalesReport({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});
router.get('/reports/ecommerce-orders', requirePermission('pos.reports.view'), async (req, res, next) => {
  try { res.json(await svc.ecommerceOrdersReport({ orgId: orgId(req), query: req.query })); } catch (e) { next(e); }
});

module.exports = router;
