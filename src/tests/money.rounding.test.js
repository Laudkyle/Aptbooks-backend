const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDecimalToBigInt, bigIntToDecimalString, divideAndRoundHalfUp } = require('../shared/utils/money');

test('money parser preserves exact minor units and rejects excess precision', () => {
  assert.equal(parseDecimalToBigInt('10.01', 2), 1001n);
  assert.equal(bigIntToDecimalString(1001n, 2), '10.01');
  assert.throws(() => parseDecimalToBigInt('10.001', 2), /Too many decimal places/);
});

test('round-half-up rounds positive and negative midpoint values away from zero', () => {
  assert.equal(divideAndRoundHalfUp(1005n, 10n), 101n);
  assert.equal(divideAndRoundHalfUp(1004n, 10n), 100n);
  assert.equal(divideAndRoundHalfUp(-1005n, 10n), -101n);
});

test('FX conversion examples produce deterministic cent values', () => {
  const tenOhOne = parseDecimalToBigInt('10.01', 2);
  const rate = parseDecimalToBigInt('1.234567', 6);
  assert.equal(bigIntToDecimalString(divideAndRoundHalfUp(tenOhOne * rate, 1000000n), 2), '12.36');

  const one = parseDecimalToBigInt('1.00', 2);
  const midpoint = parseDecimalToBigInt('1.005000', 6);
  assert.equal(bigIntToDecimalString(divideAndRoundHalfUp(one * midpoint, 1000000n), 2), '1.01');
});
