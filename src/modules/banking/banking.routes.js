const router = require("express").Router();

router.use("/accounts", require("./bank-accounts/bankAccounts.routes"));
router.use("/statements", require("./statements/statements.routes"));
router.use("/reconciliations", require("./reconciliations/reconciliations.routes"));

router.use("/cashbook", require("./cashbook/cashbook.routes"));
router.use("/matching", require("./matching/matching.routes"));

router.use("/payment-runs", require("./treasury/payment-runs/paymentRuns.routes"));
router.use("/bank-transfers", require("./treasury/bank-transfers/bankTransfers.routes"));
router.use("/approval-batches", require("./treasury/approval-batches/approvalBatches.routes"));
router.use("/cheques", require("./treasury/cheques/cheques.routes"));
router.use("/cash-forecast", require("./treasury/cash-forecast/cashForecast.routes"));
router.use("/treasury-dashboard", require("./treasury/dashboard/dashboard.routes"));

module.exports = router;
