
const { createOpsDocService } = require("../_shared/opsDocs.service");

module.exports = createOpsDocService({
  moduleCode: "quotation",
  entityType: "quotation",
  prefix: "QTN",
  partnerRole: "customer",
  finalAction: "issue",
  defaultMeta: () => ({})
});
