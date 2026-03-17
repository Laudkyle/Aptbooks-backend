
const { createOpsDocRouter } = require("../_shared/opsDocs.routes");
const svc = require("./expenses.service");
const { expenseSchema, voidSchema } = require("../../../shared/validators/phase1.transactions.validators");

module.exports = createOpsDocRouter({
  service: svc,
  createSchema: expenseSchema,
  voidSchema,
  permissionPrefix: "transactions.expense",
  entityType: "expense",
  entityLabel: "Expense",
  finalAction: "post"
});
