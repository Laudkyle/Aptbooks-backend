const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FINANCIAL_SCALE,
  applyPercentagePoints,
  calculateInclusiveTaxUnits,
  multiplyScaledDecimals,
  parseDecimalRoundedToBigInt,
  parsePercentagePoints,
} = require('../shared/utils/money');
const { stripClientCalculatedTaxAmounts } = require('../shared/tax/authoritativeInput');

test('financial scale contract is explicit and stable', () => {
  assert.deepEqual(FINANCIAL_SCALE, {
    money: 2,
    documentQuantity: 4,
    documentUnitPrice: 2,
    quantity: 6,
    unitPrice: 6,
    unitCost: 6,
    percentagePoints: 6,
    fraction: 6,
    exchangeRate: 6,
  });
});

test('percentage points never use magnitude-based fraction inference', () => {
  assert.equal(parsePercentagePoints('1.000000'), 1000000n);
  assert.equal(applyPercentagePoints(10000n, '1.000000'), 100n); // 1% of 100.00 = 1.00
  assert.equal(applyPercentagePoints(10000n, '0.500000'), 50n);  // 0.5% = 0.50
  assert.equal(applyPercentagePoints(10000n, '15.000000'), 1500n);
});

test('inclusive tax breakdown is exact at currency boundary', () => {
  assert.deepEqual(calculateInclusiveTaxUnits(11500n, '15.000000'), { baseUnits: 10000n, taxUnits: 1500n });
  assert.deepEqual(calculateInclusiveTaxUnits(10100n, '1.000000'), { baseUnits: 10000n, taxUnits: 100n });
});

test('scaled multiplication and explicit rounding use one half-up policy', () => {
  assert.equal(multiplyScaledDecimals('2.5000', 4, '3.33', 2, 2), 833n);
  assert.equal(parseDecimalRoundedToBigInt('10.005', 2, 6), 1001n);
  assert.equal(parseDecimalRoundedToBigInt('-10.005', 2, 6), -1001n);
});


test('normal transaction tax resolution strips client-calculated money fields', () => {
  const sanitized = stripClientCalculatedTaxAmounts({
    taxCodeId: 'code',
    taxAmount: '999.99',
    taxableAmount: '0.01',
    lineTotal: '1000.00',
    withholdingRateOverride: '5.000000',
    taxes: [{ taxCodeId: 'component', taxAmount: '123.45', taxableAmount: '1.00', rateOverride: '2.5' }],
  });
  assert.equal(sanitized.taxAmount, undefined);
  assert.equal(sanitized.taxableAmount, undefined);
  assert.equal(sanitized.lineTotal, undefined);
  assert.equal(sanitized.withholdingRateOverride, '5.000000');
  assert.deepEqual(sanitized.taxes, [{ taxCodeId: 'component', rateOverride: '2.5' }]);
});
