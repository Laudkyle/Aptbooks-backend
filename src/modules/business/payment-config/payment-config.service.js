const paymentIF = require("../../../interfaces/paymentConfig.interface"); 

async function listPaymentTerms({ orgId }) {
  return paymentIF.listPaymentTerms({ orgId }); 
}

async function createPaymentTerm({ orgId, payload }) {
  return paymentIF.createPaymentTerm({ orgId, payload }); 
}

async function updatePaymentTerm({ orgId, id, payload }) {
  return paymentIF.updatePaymentTerm({ orgId, id, payload }); 
}

async function deletePaymentTerm({ orgId, id }) {
  return paymentIF.deletePaymentTerm({ orgId, id }); 
}

async function listPaymentMethods({ orgId }) {
  return paymentIF.listPaymentMethods({ orgId }); 
}

async function getPaymentSettings({ orgId }) {
  return paymentIF.getPaymentSettings({ orgId }); 
}

async function upsertPaymentSettings({ orgId, payload }) {
  return paymentIF.upsertPaymentSettings({ orgId, payload }); 
}

module.exports = {
  listPaymentTerms,
  createPaymentTerm,
  updatePaymentTerm,
  deletePaymentTerm,
  listPaymentMethods,
  getPaymentSettings,
  upsertPaymentSettings
}; 
