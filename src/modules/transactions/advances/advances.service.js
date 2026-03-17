
const { createOpsDocService } = require("../_shared/opsDocs.service");

module.exports = createOpsDocService({
  moduleCode: "advance",
  entityType: "advance",
  prefix: "ADV",
  partnerRole: null,
  finalAction: "post",
  defaultMeta: payload => ({ advanceType: payload.advanceType })
});
