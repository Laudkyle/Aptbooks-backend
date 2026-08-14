const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDecimalToBigInt, bigIntToDecimalString, divideAndRoundHalfUp } = require('../shared/utils/money');

test('minor-unit parser and formatter are exact', () => {
  assert.equal(parseDecimalToBigInt('10.01', 2), 1001n);
  assert.equal(bigIntToDecimalString(1001n, 2), '10.01');
  assert.throws(() => parseDecimalToBigInt('10.001', 2));
});

test('round-half-up is deterministic at midpoint boundaries', () => {
  assert.equal(divideAndRoundHalfUp(1005n, 10n), 101n);
  assert.equal(divideAndRoundHalfUp(1004n, 10n), 100n);
  assert.equal(divideAndRoundHalfUp(-1005n, 10n), -101n);
});

test('FX examples round to expected base-currency cents', () => {
  const amount = parseDecimalToBigInt('10.01', 2);
  const rate = parseDecimalToBigInt('1.234567', 6);
  assert.equal(bigIntToDecimalString(divideAndRoundHalfUp(amount * rate, 1000000n), 2), '12.36');
  const midpointRate = parseDecimalToBigInt('1.005000', 6);
  assert.equal(bigIntToDecimalString(divideAndRoundHalfUp(100n * midpointRate, 1000000n), 2), '1.01');
});
