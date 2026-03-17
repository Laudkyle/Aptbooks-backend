
const { createOpsDocRouter } = require("../_shared/opsDocs.routes");
const svc = require("./purchaserequisitions.service");
const { purchaseRequisitionSchema, voidSchema } = require("../../../shared/validators/phase1.transactions.validators");

module.exports = createOpsDocRouter({
  service: svc,
  createSchema: purchaseRequisitionSchema,
  voidSchema,
  permissionPrefix: "transactions.purchase_requisition",
  entityType: "purchase_requisition",
  entityLabel: "Purchase requisition",
  finalAction: "issue"
});
