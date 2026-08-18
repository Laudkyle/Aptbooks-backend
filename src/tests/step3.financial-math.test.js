const test = require('node:test');
const assert = require('node:assert/strict');
const {
  moneyUnits,
  moneyStringFromUnits,
  applyFractionToMoneyUnits,
  multiplyQuantityByUnitCost,
  weightedAverageUnitCost,
  weightedAverageUnitCostFromValue,
  unitCostFromExtendedValue,
  inventoryValueString,
  unitCostString,
  inventoryValueToJournalMoney,
  periodicDepreciationUnits,
  assetBookAmounts,
} = require('../shared/utils/financialMath');

test('early-payment discount fractions apply exactly to money', () => {
  assert.equal(moneyStringFromUnits(applyFractionToMoneyUnits(moneyUnits('100.00'), '0.02500')), '2.50');
  assert.equal(moneyStringFromUnits(applyFractionToMoneyUnits(moneyUnits('0.10'), '0.10000')), '0.01');
});

test('inventory quantity times unit cost is deterministic at six decimals', () => {
  const ext = multiplyQuantityByUnitCost('3.333333', '1.234567');
  assert.equal(inventoryValueString(ext), '4.115223');
  assert.equal(inventoryValueToJournalMoney(ext), '4.12');
});

test('weighted-average inventory costing never uses binary floating point', () => {
  const avg = weightedAverageUnitCost({
    oldQuantity: '100.000000',
    oldUnitCost: '1.234567',
    incomingQuantity: '50.000000',
    incomingUnitCost: '1.345678',
  });
  assert.equal(unitCostString(avg), '1.271604');
});

test('FIFO extended value can derive a six-decimal unit cost exactly', () => {
  const ext = multiplyQuantityByUnitCost('2.500000', '7.123456');
  assert.equal(unitCostString(unitCostFromExtendedValue(ext, '2.500000')), '7.123456');
});


test('straight-line depreciation catches rounding residual in the final useful-life period', () => {
  const basis = moneyUnits('100.00');
  const first = periodicDepreciationUnits({ basisUnits: basis, accumulatedUnits: 0n, usefulLifePeriods: 3, postedPeriods: 0 });
  const second = periodicDepreciationUnits({ basisUnits: basis, accumulatedUnits: first, usefulLifePeriods: 3, postedPeriods: 1 });
  const third = periodicDepreciationUnits({ basisUnits: basis, accumulatedUnits: first + second, usefulLifePeriods: 3, postedPeriods: 2 });
  assert.equal(moneyStringFromUnits(first), '33.33');
  assert.equal(moneyStringFromUnits(second), '33.33');
  assert.equal(moneyStringFromUnits(third), '33.34');
  assert.equal(first + second + third, basis);
});


test('FIFO transfer weighted average uses the exact transferred layer value', () => {
  const incomingValue = multiplyQuantityByUnitCost('1.000000', '1.000001') + multiplyQuantityByUnitCost('1.000000', '1.000002');
  const avg = weightedAverageUnitCostFromValue({
    oldQuantity: '1.000000',
    oldUnitCost: '1.000000',
    incomingQuantity: '2.000000',
    incomingValue,
  });
  assert.equal(unitCostString(avg), '1.000001');
});


test('asset carrying amount is reconstructed from valuation events, impairment, and depreciation', () => {
  const state = assetBookAmounts({
    cost: '100.00',
    accumulatedDepreciation: '20.00',
    revaluationDelta: '30.00',
    impairmentTotal: '10.00',
  });
  assert.equal(moneyStringFromUnits(state.grossBookUnits), '120.00');
  assert.equal(moneyStringFromUnits(state.carryingUnits), '100.00');
});
