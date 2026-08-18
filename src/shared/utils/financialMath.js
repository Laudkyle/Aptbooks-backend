const {
  FINANCIAL_SCALE,
  parseDecimalToBigInt,
  parseDecimalRoundedToBigInt,
  bigIntToDecimalString,
  divideAndRoundHalfUp,
  powerOfTen,
} = require('./money');

const MONEY_SCALE = FINANCIAL_SCALE.money;
const FRACTION_SCALE = FINANCIAL_SCALE.fraction;
const QUANTITY_SCALE = FINANCIAL_SCALE.quantity;
const UNIT_COST_SCALE = FINANCIAL_SCALE.unitCost;
const INVENTORY_VALUE_SCALE = 6;

function units(value, scale) {
  return parseDecimalToBigInt(value == null || value === '' ? '0' : String(value), scale);
}

function moneyUnits(value) {
  return units(value, MONEY_SCALE);
}

function moneyStringFromUnits(value) {
  return bigIntToDecimalString(value, MONEY_SCALE);
}

function normalizeMoney(value) {
  return moneyStringFromUnits(moneyUnits(value));
}

function compareMoney(left, right) {
  const a = moneyUnits(left);
  const b = moneyUnits(right);
  return a === b ? 0 : a > b ? 1 : -1;
}

function addMoney(...values) {
  const total = values.flat().reduce((sum, value) => sum + moneyUnits(value), 0n);
  return moneyStringFromUnits(total);
}

function subtractMoney(left, right) {
  return moneyStringFromUnits(moneyUnits(left) - moneyUnits(right));
}

function sumMoneyUnits(values) {
  return (values || []).reduce((sum, value) => sum + moneyUnits(value), 0n);
}

function fractionUnits(value) {
  const out = units(value, FRACTION_SCALE);
  const one = powerOfTen(FRACTION_SCALE);
  if (out < 0n || out > one) throw new Error('Fraction must be between 0 and 1');
  return out;
}

/** Apply a 0..1 fraction to a monetary amount in minor units. */
function applyFractionToMoneyUnits(amountMinor, fraction) {
  if (typeof amountMinor !== 'bigint') throw new Error('amountMinor must be BigInt');
  return divideAndRoundHalfUp(amountMinor * fractionUnits(fraction), powerOfTen(FRACTION_SCALE));
}

function quantityUnits(value) {
  return units(value, QUANTITY_SCALE);
}

function unitCostUnits(value) {
  return units(value, UNIT_COST_SCALE);
}

function inventoryValueUnits(value) {
  return units(value, INVENTORY_VALUE_SCALE);
}

function quantityString(value) {
  return bigIntToDecimalString(typeof value === 'bigint' ? value : quantityUnits(value), QUANTITY_SCALE);
}

function unitCostString(value) {
  return bigIntToDecimalString(typeof value === 'bigint' ? value : unitCostUnits(value), UNIT_COST_SCALE);
}

function inventoryValueString(value) {
  return bigIntToDecimalString(typeof value === 'bigint' ? value : inventoryValueUnits(value), INVENTORY_VALUE_SCALE);
}

/** quantity(6) * unit cost(6) -> inventory value(6), rounded half-up. */
function multiplyQuantityByUnitCost(quantity, unitCost) {
  const product = quantityUnits(quantity) * unitCostUnits(unitCost);
  return divideAndRoundHalfUp(product, powerOfTen(QUANTITY_SCALE));
}

/** Exact weighted-average unit cost at six decimals. */
function weightedAverageUnitCost({ oldQuantity, oldUnitCost, incomingQuantity, incomingUnitCost }) {
  const oldQty = quantityUnits(oldQuantity);
  const inQty = quantityUnits(incomingQuantity);
  const newQty = oldQty + inQty;
  if (newQty === 0n) return 0n;
  const numerator = oldQty * unitCostUnits(oldUnitCost) + inQty * unitCostUnits(incomingUnitCost);
  return divideAndRoundHalfUp(numerator, newQty);
}

/**
 * Weighted-average unit cost when the incoming valuation is already known exactly at value scale.
 * Useful for FIFO transfers where preserving consumed layer value is more accurate than deriving and
 * re-multiplying a synthetic average incoming unit cost.
 */
function weightedAverageUnitCostFromValue({ oldQuantity, oldUnitCost, incomingQuantity, incomingValue }) {
  const oldQty = quantityUnits(oldQuantity);
  const inQty = quantityUnits(incomingQuantity);
  const newQty = oldQty + inQty;
  if (newQty === 0n) return 0n;
  const oldValue = multiplyQuantityByUnitCost(quantityString(oldQty), unitCostString(oldUnitCost));
  const incomingValueUnits = typeof incomingValue === 'bigint' ? incomingValue : inventoryValueUnits(incomingValue);
  return unitCostFromExtendedValue(oldValue + incomingValueUnits, quantityString(newQty));
}

/** extended value(6) / quantity(6) -> unit cost(6). */
function unitCostFromExtendedValue(extendedValue, quantity) {
  const qty = quantityUnits(quantity);
  if (qty === 0n) throw new Error('Quantity cannot be zero');
  const ext = typeof extendedValue === 'bigint' ? extendedValue : inventoryValueUnits(extendedValue);
  return divideAndRoundHalfUp(ext * powerOfTen(QUANTITY_SCALE), qty);
}

/** Convert a six-decimal inventory valuation to the 2-decimal journal boundary. */
function inventoryValueToJournalMoney(value) {
  const text = typeof value === 'bigint' ? inventoryValueString(value) : String(value ?? '0');
  return bigIntToDecimalString(parseDecimalRoundedToBigInt(text, MONEY_SCALE, INVENTORY_VALUE_SCALE), MONEY_SCALE);
}

function minUnits(left, right) {
  return left < right ? left : right;
}

function absUnits(value) {
  return value < 0n ? -value : value;
}

/**
 * Straight-line depreciation at the currency boundary with deterministic final-period catch-up.
 * The last declared useful-life period absorbs any rounding residual so cumulative depreciation
 * reaches the depreciable basis exactly and never exceeds it.
 */
/**
 * Reconstruct fixed-asset book amounts from durable accounting components rather than the
 * cached current_value field (which is only refreshed by valuation events). Revaluation
 * deltas adjust the gross asset account; impairment reduces it; depreciation is the contra
 * balance. All inputs/outputs are currency minor units.
 */
function assetBookAmounts({ cost, accumulatedDepreciation = '0', revaluationDelta = '0', impairmentTotal = '0' }) {
  const costUnits = moneyUnits(cost);
  const accumulatedUnits = moneyUnits(accumulatedDepreciation);
  const revaluationUnits = moneyUnits(revaluationDelta);
  const impairmentUnits = moneyUnits(impairmentTotal);
  const grossBookUnits = costUnits + revaluationUnits - impairmentUnits;
  const carryingUnits = grossBookUnits - accumulatedUnits;
  return {
    costUnits,
    accumulatedUnits,
    revaluationUnits,
    impairmentUnits,
    grossBookUnits,
    carryingUnits,
  };
}

function periodicDepreciationUnits({ basisUnits, accumulatedUnits = 0n, usefulLifePeriods, postedPeriods = 0 }) {
  if (typeof basisUnits !== 'bigint' || typeof accumulatedUnits !== 'bigint') {
    throw new Error('basisUnits and accumulatedUnits must be BigInt values');
  }
  if (!Number.isInteger(usefulLifePeriods) || usefulLifePeriods <= 0) {
    throw new Error('usefulLifePeriods must be a positive integer');
  }
  if (!Number.isInteger(postedPeriods) || postedPeriods < 0) {
    throw new Error('postedPeriods must be a non-negative integer');
  }
  const remainingUnits = basisUnits - accumulatedUnits;
  if (basisUnits <= 0n || remainingUnits <= 0n) return 0n;
  const scheduledUnits = divideAndRoundHalfUp(basisUnits, BigInt(usefulLifePeriods));
  if (postedPeriods >= usefulLifePeriods - 1) return remainingUnits;
  return minUnits(scheduledUnits, remainingUnits);
}

/** Presentation compatibility only. Never use this result for financial decisions. */
function moneyNumber(value) {
  return Number(normalizeMoney(value));
}

module.exports = {
  MONEY_SCALE,
  FRACTION_SCALE,
  QUANTITY_SCALE,
  UNIT_COST_SCALE,
  INVENTORY_VALUE_SCALE,
  moneyUnits,
  moneyStringFromUnits,
  normalizeMoney,
  compareMoney,
  addMoney,
  subtractMoney,
  sumMoneyUnits,
  fractionUnits,
  applyFractionToMoneyUnits,
  quantityUnits,
  unitCostUnits,
  inventoryValueUnits,
  quantityString,
  unitCostString,
  inventoryValueString,
  multiplyQuantityByUnitCost,
  weightedAverageUnitCost,
  weightedAverageUnitCostFromValue,
  unitCostFromExtendedValue,
  inventoryValueToJournalMoney,
  minUnits,
  absUnits,
  periodicDepreciationUnits,
  assetBookAmounts,
  moneyNumber,
};
