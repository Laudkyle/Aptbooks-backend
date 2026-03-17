
const { createOpsDocRouter } = require("../_shared/opsDocs.routes");
const svc = require("./advances.service");
const { advanceSchema, voidSchema } = require("../../../shared/validators/phase1.transactions.validators");

module.exports = createOpsDocRouter({
  service: svc,
  createSchema: advanceSchema,
  voidSchema,
  permissionPrefix: "transactions.advance",
  entityType: "advance",
  entityLabel: "Advance",
  finalAction: "post"
});
