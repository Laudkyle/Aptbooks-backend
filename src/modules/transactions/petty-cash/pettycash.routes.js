
const { createOpsDocRouter } = require("../_shared/opsDocs.routes");
const svc = require("./pettycash.service");
const { pettyCashSchema, voidSchema } = require("../../../shared/validators/phase1.transactions.validators");

module.exports = createOpsDocRouter({
  service: svc,
  createSchema: pettyCashSchema,
  voidSchema,
  permissionPrefix: "transactions.petty_cash",
  entityType: "petty_cash",
  entityLabel: "Petty cash",
  finalAction: "post"
});
