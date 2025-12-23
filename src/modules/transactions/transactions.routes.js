const router = require("express").Router();

const invoicesRoutes = require("./invoices/invoices.routes");

router.use("/invoices", invoicesRoutes);

module.exports = router;
