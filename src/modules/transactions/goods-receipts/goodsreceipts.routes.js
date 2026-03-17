
const { createOpsDocRouter } = require("../_shared/opsDocs.routes");
const svc = require("./goodsreceipts.service");
const { goodsReceiptSchema, voidSchema } = require("../../../shared/validators/phase1.transactions.validators");

module.exports = createOpsDocRouter({
  service: svc,
  createSchema: goodsReceiptSchema,
  voidSchema,
  permissionPrefix: "transactions.goods_receipt",
  entityType: "goods_receipt",
  entityLabel: "Goods receipt",
  finalAction: "post"
});
