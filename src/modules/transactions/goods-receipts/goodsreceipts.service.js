
const { createOpsDocService } = require("../_shared/opsDocs.service");

module.exports = createOpsDocService({
  moduleCode: "goods_receipt",
  entityType: "goods_receipt",
  prefix: "GRN",
  partnerRole: null,
  finalAction: "post",
  defaultMeta: () => ({})
});
