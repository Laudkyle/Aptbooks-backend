const { parseDecimalToBigInt, bigIntToDecimalString, divideAndRoundHalfUp } = require('../shared/utils/money');

test('money parser preserves exact minor units and rejects excess precision', () => {
  expect(parseDecimalToBigInt('10.01', 2)).toBe(1001n);
  expect(bigIntToDecimalString(1001n, 2)).toBe('10.01');
  expect(() => parseDecimalToBigInt('10.001', 2)).toThrow(/Too many decimal places/);
});

test('round-half-up rounds positive and negative midpoint values away from zero', () => {
  expect(divideAndRoundHalfUp(1005n, 10n)).toBe(101n);
  expect(divideAndRoundHalfUp(1004n, 10n)).toBe(100n);
  expect(divideAndRoundHalfUp(-1005n, 10n)).toBe(-101n);
});

test('FX conversion examples produce deterministic cent values', () => {
  const tenOhOne = parseDecimalToBigInt('10.01', 2);
  const rate = parseDecimalToBigInt('1.234567', 6);
  expect(bigIntToDecimalString(divideAndRoundHalfUp(tenOhOne * rate, 1000000n), 2)).toBe('12.36');

  const one = parseDecimalToBigInt('1.00', 2);
  const midpoint = parseDecimalToBigInt('1.005000', 6);
  expect(bigIntToDecimalString(divideAndRoundHalfUp(one * midpoint, 1000000n), 2)).toBe('1.01');
});
