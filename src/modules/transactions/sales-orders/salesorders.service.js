
const { createOpsDocService } = require("../_shared/opsDocs.service");

module.exports = createOpsDocService({
  moduleCode: "sales_order",
  entityType: "sales_order",
  prefix: "SO",
  partnerRole: "customer",
  finalAction: "issue",
  defaultMeta: () => ({})
});
