const DEFAULT_ACCOUNTING_POLICY = Object.freeze({
  moneyScale: 2,
  exchangeRateScale: 6,
  inventoryValueScale: 6,
  roundingMode: 'HALF_UP',
  taxRoundingScope: 'LINE',
  postingDatePolicy: 'DOCUMENT_DATE',
  closedPeriodAdjustmentPolicy: 'REJECT',
  reversalPolicy: 'EXPLICIT_REVERSAL',
});

const SUPPORTED = Object.freeze({
  moneyScale: new Set([2]),
  exchangeRateScale: new Set([6]),
  inventoryValueScale: new Set([6]),
  roundingMode: new Set(['HALF_UP']),
  taxRoundingScope: new Set(['LINE']),
  postingDatePolicy: new Set(['DOCUMENT_DATE']),
  closedPeriodAdjustmentPolicy: new Set(['REJECT']),
  reversalPolicy: new Set(['EXPLICIT_REVERSAL']),
});

function normalizePolicy(input = {}) {
  const source = input || {};
  return {
    moneyScale: Number(source.moneyScale ?? source.money_scale ?? DEFAULT_ACCOUNTING_POLICY.moneyScale),
    exchangeRateScale: Number(source.exchangeRateScale ?? source.exchange_rate_scale ?? DEFAULT_ACCOUNTING_POLICY.exchangeRateScale),
    inventoryValueScale: Number(source.inventoryValueScale ?? source.inventory_value_scale ?? DEFAULT_ACCOUNTING_POLICY.inventoryValueScale),
    roundingMode: String(source.roundingMode ?? source.rounding_mode ?? DEFAULT_ACCOUNTING_POLICY.roundingMode).toUpperCase(),
    taxRoundingScope: String(source.taxRoundingScope ?? source.tax_rounding_scope ?? DEFAULT_ACCOUNTING_POLICY.taxRoundingScope).toUpperCase(),
    postingDatePolicy: String(source.postingDatePolicy ?? source.posting_date_policy ?? DEFAULT_ACCOUNTING_POLICY.postingDatePolicy).toUpperCase(),
    closedPeriodAdjustmentPolicy: String(source.closedPeriodAdjustmentPolicy ?? source.closed_period_adjustment_policy ?? DEFAULT_ACCOUNTING_POLICY.closedPeriodAdjustmentPolicy).toUpperCase(),
    reversalPolicy: String(source.reversalPolicy ?? source.reversal_policy ?? DEFAULT_ACCOUNTING_POLICY.reversalPolicy).toUpperCase(),
  };
}

function assertSupportedPolicy(input) {
  const policy = normalizePolicy(input);
  for (const [field, allowed] of Object.entries(SUPPORTED)) {
    if (!allowed.has(policy[field])) {
      const err = new Error(`Unsupported accounting policy ${field}: ${policy[field]}`);
      err.code = 'unsupported_accounting_policy';
      err.field = field;
      throw err;
    }
  }
  return policy;
}

module.exports = { DEFAULT_ACCOUNTING_POLICY, normalizePolicy, assertSupportedPolicy };
