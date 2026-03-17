
const { createOpsDocService } = require("../_shared/opsDocs.service");

module.exports = createOpsDocService({
  moduleCode: "return",
  entityType: "return",
  prefix: "RTN",
  partnerRole: null,
  finalAction: "post",
  defaultMeta: payload => ({ returnType: payload.returnType })
});
