
const { createOpsDocService } = require("../_shared/opsDocs.service");

module.exports = createOpsDocService({
  moduleCode: "petty_cash",
  entityType: "petty_cash",
  prefix: "PC",
  partnerRole: null,
  finalAction: "post",
  defaultMeta: () => ({})
});
