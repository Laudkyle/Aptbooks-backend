const fxSvc = require("../core/accounting/fx/fx.service"); 

async function createRateType({ orgId, code, name, actorUserId, req }) {
  // orgId kept for symmetry;  rate types are global but we audit against org
  return fxSvc.createRateType({ code, name, actorUserId, req }); 
}

async function listRateTypes() {
  return fxSvc.listRateTypes(); 
}

async function upsertRate({ orgId, rateTypeCode, fromCurrency, toCurrency, rate, effectiveDate, actorUserId, req }) {
  return fxSvc.upsertRate({ orgId, rateTypeCode, fromCurrency, toCurrency, rate, effectiveDate, actorUserId, req }); 
}

async function listRates({ orgId, rateTypeCode, fromCurrency, toCurrency, fromDate, toDate, limit }) {
  return fxSvc.listRates({ orgId, rateTypeCode, fromCurrency, toCurrency, fromDate, toDate, limit }); 
}

async function getEffectiveRate({ orgId, rateTypeCode, fromCurrency, toCurrency, asOfDate }) {
  return fxSvc.getEffectiveRate({ orgId, rateTypeCode, fromCurrency, toCurrency, asOfDate }); 
}

module.exports = { createRateType, listRateTypes, upsertRate, listRates, getEffectiveRate }; 
