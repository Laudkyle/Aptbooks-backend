const router = require("express").Router();

const partnersRoutes = require("./partners/partners.routes");
const paymentConfigRoutes = require("./payment-config/payment-config.routes");

router.use("/partners", partnersRoutes);
router.use("/payment-config", paymentConfigRoutes);

module.exports = router;
