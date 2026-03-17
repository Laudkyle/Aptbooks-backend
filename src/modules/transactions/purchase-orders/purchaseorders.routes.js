
const { createOpsDocRouter } = require("../_shared/opsDocs.routes");
const svc = require("./purchaseorders.service");
const { purchaseOrderSchema, voidSchema } = require("../../../shared/validators/phase1.transactions.validators");

module.exports = createOpsDocRouter({
  service: svc,
  createSchema: purchaseOrderSchema,
  voidSchema,
  permissionPrefix: "transactions.purchase_order",
  entityType: "purchase_order",
  entityLabel: "Purchase order",
  finalAction: "issue"
});
