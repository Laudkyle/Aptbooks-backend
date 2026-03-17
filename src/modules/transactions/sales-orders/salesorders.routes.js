
const { createOpsDocRouter } = require("../_shared/opsDocs.routes");
const svc = require("./salesorders.service");
const { salesOrderSchema, voidSchema } = require("../../../shared/validators/phase1.transactions.validators");

module.exports = createOpsDocRouter({
  service: svc,
  createSchema: salesOrderSchema,
  voidSchema,
  permissionPrefix: "transactions.sales_order",
  entityType: "sales_order",
  entityLabel: "Sales order",
  finalAction: "issue"
});
