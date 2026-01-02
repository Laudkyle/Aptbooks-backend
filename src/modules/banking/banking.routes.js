const router = require("express").Router();

router.use("/accounts", require("./bank-accounts/bankAccounts.routes"));
router.use("/statements", require("./statements/statements.routes"));
router.use("/reconciliations", require("./reconciliations/reconciliations.routes"));

module.exports = router;
