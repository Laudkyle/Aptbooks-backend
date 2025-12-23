const paymentIF = require("../../../interfaces/paymentConfig.interface");

async function listPaymentTerms({ orgId }) {
  return paymentIF.listPaymentTerms({ orgId });
}

async function listPaymentMethods({ orgId }) {
  return paymentIF.listPaymentMethods({ orgId });
}

module.exports = { listPaymentTerms, listPaymentMethods };
