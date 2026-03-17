
const { createOpsDocService } = require("../_shared/opsDocs.service");

module.exports = createOpsDocService({
  moduleCode: "refund",
  entityType: "refund",
  prefix: "RFD",
  partnerRole: null,
  finalAction: "post",
  defaultMeta: payload => ({ refundType: payload.refundType })
});
