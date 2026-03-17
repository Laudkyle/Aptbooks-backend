const router = require("express").Router();

router.use("/invoices", require("./invoices/invoices.routes"));

router.use("/bills", require("./bills/bills.routes"));
router.use("/vendor-payments", require("./payments/vendor-payments/vendorPayments.routes"));

// Phase 1 operational completion
router.use("/quotations", require("./quotations/quotations.routes"));
router.use("/sales-orders", require("./sales-orders/salesorders.routes"));
router.use("/purchase-requisitions", require("./purchase-requisitions/purchaserequisitions.routes"));
router.use("/purchase-orders", require("./purchase-orders/purchaseorders.routes"));
router.use("/goods-receipts", require("./goods-receipts/goodsreceipts.routes"));
router.use("/expenses", require("./expenses/expenses.routes"));
router.use("/petty-cash", require("./petty-cash/pettycash.routes"));
router.use("/advances", require("./advances/advances.routes"));
router.use("/returns", require("./returns/returns.routes"));
router.use("/refunds", require("./refunds/refunds.routes"));

// Stage 5: Credit/Debit Notes (AR/AP adjustments)
router.use("/credit-notes", require("./credit-notes/creditNotes.routes"));
router.use("/debit-notes", require("./debit-notes/debitNotes.routes"));

// Tier 3 (A/R) customer receipts + allocations
router.use("/customer-receipts", require("./receipts/customer-receipts/customerReceipts.routes"));

module.exports = router;
