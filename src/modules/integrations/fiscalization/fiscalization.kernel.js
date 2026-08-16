const crypto = require('crypto');
const { parseDecimalToBigInt, bigIntToDecimalString, divideAndRoundHalfUp } = require('../../../shared/utils/money');

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = stableObject(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableObject(value));
}

function payloadHash(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function sumMoney(values) {
  return bigIntToDecimalString((values || []).reduce((sum, v) => sum + parseDecimalToBigInt(v || '0', 2), 0n), 2);
}


function percentageRate(partAmount, wholeAmount, scale = 6) {
  const part = parseDecimalToBigInt(partAmount || '0', 2);
  const whole = parseDecimalToBigInt(wholeAmount || '0', 2);
  if (part <= 0n || whole <= 0n) return bigIntToDecimalString(0n, scale);
  const factor = 100n * (10n ** BigInt(scale));
  return bigIntToDecimalString(divideAndRoundHalfUp(part * factor, whole), scale);
}

function normalizeFiscalSecurityResponse(data = {}) {
  const pick = (...keys) => {
    for (const key of keys) if (data[key] !== undefined && data[key] !== null && data[key] !== '') return data[key];
    return null;
  };
  return {
    commissionerGeneralSignature: pick('commissionerGeneralSignature', 'commissioner_general_signature', 'cgSignature'),
    qrCode: pick('qrCode', 'qr_code', 'qr'),
    receiptSignature: pick('receiptSignature', 'receipt_signature'),
    invoiceSignature: pick('invoiceSignature', 'invoice_signature', 'signature'),
    verificationEngineId: pick('verificationEngineId', 'verification_engine_id'),
    encryptedData: pick('encryptedData', 'encrypted_data'),
    fiscalTimestamp: pick('fiscalTimestamp', 'fiscal_timestamp', 'timestamp'),
    serialNumber: pick('serialNumber', 'serial_number', 'serialNo'),
    receiptNumber: pick('receiptNumber', 'receipt_number', 'receiptNo', 'invoiceNumber'),
    machineRegistrationCode: pick('machineRegistrationCode', 'machine_registration_code', 'machineCode'),
    graReference: pick('graReference', 'gra_reference', 'reference', 'id')
  };
}

function validateFiscalPayload(payload, { requireCertifiedSecurity = false } = {}) {
  const errors = [];
  const seller = payload?.seller || {};
  const buyer = payload?.buyer || {};
  const lines = Array.isArray(payload?.lines) ? payload.lines : [];
  const totals = payload?.totals || {};

  if (!seller.name) errors.push('Seller name is required');
  if (!seller.address) errors.push('Seller address is required');
  if (!seller.taxId) errors.push('Seller TIN/VAT registration is required');
  if (!payload?.supplyAt) errors.push('Date/time of supply is required');
  if (!payload?.documentNumber) errors.push('Consecutive invoice/receipt number is required');
  if (!payload?.transactionType) errors.push('Transaction type is required');
  if (!payload?.currencyCode) errors.push('Currency is required');
  if (!lines.length) errors.push('At least one fiscal line is required');

  lines.forEach((line, index) => {
    if (!line.description) errors.push(`Line ${index + 1}: description is required`);
    if (line.quantity === undefined || line.quantity === null || line.quantity === '') errors.push(`Line ${index + 1}: quantity is required`);
    if (!line.unitOfMeasure) errors.push(`Line ${index + 1}: unit of measure is required`);
    if (line.taxExclusiveAmount === undefined || line.taxExclusiveAmount === null) errors.push(`Line ${index + 1}: tax-exclusive amount is required`);
  });

  if (totals.taxExclusiveAmount === undefined) errors.push('Tax-exclusive total is required');
  if (totals.totalTax === undefined) errors.push('Total tax is required');
  if (totals.taxInclusiveAmount === undefined) errors.push('Tax-inclusive total is required');

  if (payload?.buyerTaxIdRequiredForInputCredit && (!buyer.name || !buyer.taxId)) {
    errors.push('Buyer name and TIN/Ghana Card PIN are required for an input-tax-credit receipt');
  }

  if (requireCertifiedSecurity) {
    const security = payload.security || {};
    if (!security.qrCode) errors.push('GRA QR code is required');
    if (!security.signature) errors.push('GRA invoice/receipt signature is required');
    if (!security.verificationEngineId) errors.push('GRA verification engine ID is required');
    if (!security.timestamp) errors.push('GRA fiscal timestamp is required');
  }

  return { valid: errors.length === 0, errors };
}

function nextRetryAt(attemptCount, now = new Date()) {
  const attempt = Math.max(1, Number(attemptCount || 1));
  const minutes = Math.min(240, 2 ** Math.min(attempt - 1, 7));
  return new Date(now.getTime() + minutes * 60 * 1000);
}

function offlineDeadline(recordedAt, windowHours = 24) {
  const start = recordedAt instanceof Date ? recordedAt : new Date(recordedAt);
  const hours = Math.max(1, Math.min(24, Number(windowHours || 24)));
  return new Date(start.getTime() + hours * 60 * 60 * 1000);
}

function buildSimulationCertification(payload) {
  const hash = payloadHash(payload);
  const now = new Date().toISOString();
  return {
    simulation: true,
    accepted: true,
    commissionerGeneralSignature: `SIM-CG-${hash.slice(0, 20).toUpperCase()}`,
    qrCode: `APTBOOKS-EVAT-SIM:${hash}`,
    receiptSignature: `SIM-RSIG-${hash.slice(20, 44).toUpperCase()}`,
    invoiceSignature: `SIM-ISIG-${hash.slice(44, 64).toUpperCase()}`,
    verificationEngineId: 'APTBOOKS-GRA-EVAT-SIM',
    encryptedData: `SIM:${Buffer.from(hash).toString('base64')}`,
    fiscalTimestamp: now,
    serialNumber: `SIM-${hash.slice(0, 12).toUpperCase()}`,
    receiptNumber: payload.documentNumber,
    machineRegistrationCode: payload.device?.machineRegistrationCode || 'SIM-MACHINE',
    graReference: `SIM-${hash.slice(0, 24).toUpperCase()}`
  };
}

module.exports = {
  stableStringify,
  payloadHash,
  sumMoney,
  percentageRate,
  normalizeFiscalSecurityResponse,
  validateFiscalPayload,
  nextRetryAt,
  offlineDeadline,
  buildSimulationCertification
};
