
const { createOpsDocService } = require("../_shared/opsDocs.service");

module.exports = createOpsDocService({
  moduleCode: "expense",
  entityType: "expense",
  prefix: "EXP",
  partnerRole: null,
  finalAction: "post",
  defaultMeta: () => ({})
});
