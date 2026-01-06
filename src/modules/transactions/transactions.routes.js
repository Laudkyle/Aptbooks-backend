const router = require("express").Router();

router.use("/invoices", require("./invoices/invoices.routes"));

router.use("/bills", require("./bills/bills.routes"));
router.use("/vendor-payments", require("./payments/vendor-payments/vendorPayments.routes"));

// Tier 3 (A/R) customer receipts + allocations
router.use("/customer-receipts", require("./receipts/customer-receipts/customerReceipts.routes"));

module.exports = router;
