const router = require("express").Router();
const treasuryRouter = require("express").Router();

const accountsRoutes = require("./bank-accounts/bankAccounts.routes");
const statementsRoutes = require("./statements/statements.routes");
const reconciliationsRoutes = require("./reconciliations/reconciliations.routes");
const cashbookRoutes = require("./cashbook/cashbook.routes");
const matchingRoutes = require("./matching/matching.routes");

const paymentRunsRoutes = require("./treasury/payment-runs/paymentRuns.routes");
const bankTransfersRoutes = require("./treasury/bank-transfers/bankTransfers.routes");
const approvalBatchesRoutes = require("./treasury/approval-batches/approvalBatches.routes");
const chequesRoutes = require("./treasury/cheques/cheques.routes");
const cashForecastRoutes = require("./treasury/cash-forecast/cashForecast.routes");
const treasuryDashboardRoutes = require("./treasury/dashboard/dashboard.routes");

router.use("/accounts", accountsRoutes);
router.use("/statements", statementsRoutes);
router.use("/reconciliations", reconciliationsRoutes);
router.use("/cashbook", cashbookRoutes);
router.use("/matching", matchingRoutes);

// Backward-compatible direct treasury mounts
router.use("/payment-runs", paymentRunsRoutes);
router.use("/bank-transfers", bankTransfersRoutes);
router.use("/approval-batches", approvalBatchesRoutes);
router.use("/cheques", chequesRoutes);
router.use("/cash-forecast", cashForecastRoutes);
router.use("/treasury-dashboard", treasuryDashboardRoutes);

// Frontend-compatible nested treasury mounts
treasuryRouter.use("/payment-runs", paymentRunsRoutes);
treasuryRouter.use("/bank-transfers", bankTransfersRoutes);
treasuryRouter.use("/approval-batches", approvalBatchesRoutes);
treasuryRouter.use("/cheques", chequesRoutes);
treasuryRouter.use("/cash-forecast", cashForecastRoutes);
treasuryRouter.use("/dashboard", treasuryDashboardRoutes);
router.use("/treasury", treasuryRouter);

module.exports = router;
