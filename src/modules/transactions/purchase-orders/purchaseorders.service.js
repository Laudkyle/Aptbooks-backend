
const { createOpsDocService } = require("../_shared/opsDocs.service");

module.exports = createOpsDocService({
  moduleCode: "purchase_order",
  entityType: "purchase_order",
  prefix: "PO",
  partnerRole: "vendor",
  finalAction: "issue",
  defaultMeta: () => ({})
});
