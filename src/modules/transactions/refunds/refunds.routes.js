
const { createOpsDocRouter } = require("../_shared/opsDocs.routes");
const svc = require("./refunds.service");
const { refundSchema, voidSchema } = require("../../../shared/validators/phase1.transactions.validators");

module.exports = createOpsDocRouter({
  service: svc,
  createSchema: refundSchema,
  voidSchema,
  permissionPrefix: "transactions.refund",
  entityType: "refund",
  entityLabel: "Refund",
  finalAction: "post"
});
