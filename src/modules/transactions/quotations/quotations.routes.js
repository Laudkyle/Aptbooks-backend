
const { createOpsDocRouter } = require("../_shared/opsDocs.routes");
const svc = require("./quotations.service");
const { quotationSchema, voidSchema } = require("../../../shared/validators/phase1.transactions.validators");

module.exports = createOpsDocRouter({
  service: svc,
  createSchema: quotationSchema,
  voidSchema,
  permissionPrefix: "transactions.quotation",
  entityType: "quotation",
  entityLabel: "Quotation",
  finalAction: "issue"
});
