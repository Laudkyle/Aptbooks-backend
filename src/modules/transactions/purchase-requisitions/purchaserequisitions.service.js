
const { createOpsDocService } = require("../_shared/opsDocs.service");

module.exports = createOpsDocService({
  moduleCode: "purchase_requisition",
  entityType: "purchase_requisition",
  prefix: "PRQ",
  partnerRole: null,
  finalAction: "issue",
  defaultMeta: () => ({})
});
