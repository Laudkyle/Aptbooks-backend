
const { createOpsDocRouter } = require("../_shared/opsDocs.routes");
const svc = require("./returns.service");
const { returnSchema, voidSchema } = require("../../../shared/validators/phase1.transactions.validators");

module.exports = createOpsDocRouter({
  service: svc,
  createSchema: returnSchema,
  voidSchema,
  permissionPrefix: "transactions.return",
  entityType: "return",
  entityLabel: "Return",
  finalAction: "post"
});
