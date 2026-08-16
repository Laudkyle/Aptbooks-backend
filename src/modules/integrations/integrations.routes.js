const express = require("express");

const router = express.Router();

router.use("/payments", require("./payments/payments.routes"));
router.use("/einvoicing", require("./einvoicing/einvoicing.routes"));
router.use("/fiscalization", require("./fiscalization/fiscalization.routes"));
router.use("/tax-forms", require("./tax-forms/taxForms.routes"));
router.use("/connections", require("./connections/connections.routes"));

module.exports = router;
