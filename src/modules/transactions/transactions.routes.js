const router = require("express").Router();

router.use("/invoices", require("./invoices/invoices.routes"));

router.use("/bills", require("./bills/bills.routes"));
router.use("/vendor-payments", require("./payments/vendor-payments/vendorPayments.routes"));

module.exports = router;
