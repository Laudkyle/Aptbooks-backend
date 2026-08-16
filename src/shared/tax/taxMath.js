const {
  parseDecimalToBigInt,
  bigIntToDecimalString,
  divideAndRoundHalfUp,
} = require('../utils/money');

const MONEY_SCALE = 2;
const RATE_SCALE = 6;
const PERCENT_DENOMINATOR = 100n * (10n ** BigInt(RATE_SCALE));

function moneyToMinorUnits(value) {
  return parseDecimalToBigInt(value == null || value === '' ? '0' : String(value), MONEY_SCALE);
}

function rateToUnits(value) {
  return parseDecimalToBigInt(value == null || value === '' ? '0' : String(value), RATE_SCALE);
}

function minorUnitsToMoney(value) {
  return bigIntToDecimalString(value, MONEY_SCALE);
}

function normalizeMoney(value) {
  return minorUnitsToMoney(moneyToMinorUnits(value));
}

function normalizeRate(value) {
  return bigIntToDecimalString(rateToUnits(value), RATE_SCALE);
}

function addMoney(...values) {
  const total = values.flat().reduce((sum, value) => sum + moneyToMinorUnits(value), 0n);
  return minorUnitsToMoney(total);
}

function subtractMoney(left, right) {
  return minorUnitsToMoney(moneyToMinorUnits(left) - moneyToMinorUnits(right));
}

function compareMoney(left, right) {
  const a = moneyToMinorUnits(left);
  const b = moneyToMinorUnits(right);
  return a === b ? 0 : a > b ? 1 : -1;
}

/**
 * Tax rates in AptBooks are stored as percentage points.
 * Example: 15.000000 means 15%, not 0.15.
 */
function computeTaxMoney({ taxableAmount, rate, calculationMethod = 'standard', explicitTaxAmount = null }) {
  if (explicitTaxAmount != null) return normalizeMoney(explicitTaxAmount);

  const baseMinor = moneyToMinorUnits(taxableAmount);
  const rateUnits = rateToUnits(rate);
  if (baseMinor === 0n || rateUnits === 0n) return '0.00';
  if (rateUnits < 0n) throw new Error('Tax rate cannot be negative');

  let taxMinor;
  if (calculationMethod === 'inclusive') {
    taxMinor = divideAndRoundHalfUp(baseMinor * rateUnits, PERCENT_DENOMINATOR + rateUnits);
  } else {
    taxMinor = divideAndRoundHalfUp(baseMinor * rateUnits, PERCENT_DENOMINATOR);
  }

  return minorUnitsToMoney(taxMinor);
}


function sumRateUnits(components = []) {
  return components.reduce((sum, component) => sum + rateToUnits(component?.rate ?? 0), 0n);
}

function computeComponentTaxBreakdown({ amount, components = [], inclusive = false }) {
  const normalized = (components || []).map((component) => ({
    ...component,
    rate: normalizeRate(component?.rate ?? 0),
  }));
  if (!normalized.length) {
    return { taxableAmount: normalizeMoney(amount), taxAmount: '0.00', totalAmount: normalizeMoney(amount), components: [] };
  }

  const amountMinor = moneyToMinorUnits(amount);
  const totalRateUnits = sumRateUnits(normalized);
  if (totalRateUnits < 0n) throw new Error('Tax rate cannot be negative');

  let taxableMinor = amountMinor;
  let targetTaxMinor = 0n;
  if (inclusive && totalRateUnits > 0n) {
    taxableMinor = divideAndRoundHalfUp(amountMinor * PERCENT_DENOMINATOR, PERCENT_DENOMINATOR + totalRateUnits);
    targetTaxMinor = amountMinor - taxableMinor;
  }

  const calculated = normalized.map((component) => {
    const units = rateToUnits(component.rate);
    const taxMinor = divideAndRoundHalfUp(taxableMinor * units, PERCENT_DENOMINATOR);
    return { ...component, _rateUnits: units, _taxMinor: taxMinor };
  });

  if (inclusive && calculated.length) {
    let actualTaxMinor = calculated.reduce((sum, component) => sum + component._taxMinor, 0n);
    let residual = targetTaxMinor - actualTaxMinor;
    if (residual !== 0n) {
      // Allocate tax-inclusive rounding residual deterministically to the highest-rate
      // components first so taxable + components always equals the customer-facing total.
      const order = calculated
        .map((component, index) => ({ index, rateUnits: component._rateUnits }))
        .sort((a, b) => (a.rateUnits === b.rateUnits ? a.index - b.index : a.rateUnits > b.rateUnits ? -1 : 1));
      let cursor = 0;
      while (residual !== 0n) {
        const step = residual > 0n ? 1n : -1n;
        calculated[order[cursor % order.length].index]._taxMinor += step;
        residual -= step;
        cursor += 1;
      }
      actualTaxMinor = calculated.reduce((sum, component) => sum + component._taxMinor, 0n);
      targetTaxMinor = actualTaxMinor;
    }
  } else {
    targetTaxMinor = calculated.reduce((sum, component) => sum + component._taxMinor, 0n);
  }

  const totalMinor = inclusive ? amountMinor : taxableMinor + targetTaxMinor;
  return {
    taxableAmount: minorUnitsToMoney(taxableMinor),
    taxAmount: minorUnitsToMoney(targetTaxMinor),
    totalAmount: minorUnitsToMoney(totalMinor),
    components: calculated.map(({ _rateUnits, _taxMinor, ...component }) => ({
      ...component,
      taxAmount: minorUnitsToMoney(_taxMinor),
    })),
  };
}

function percentFractionToUnits(value) {
  // recoverable_percent is stored as a fraction (1 = 100%). Accept percent-style
  // overrides > 1 defensively for legacy records, but normalize to a 0..1 fraction.
  const raw = String(value == null || value === '' ? '1' : value);
  const fractionScale = 6;
  let units = parseDecimalToBigInt(raw, fractionScale);
  const one = 10n ** BigInt(fractionScale);
  if (units > one) {
    units = divideAndRoundHalfUp(units, 100n);
  }
  if (units < 0n) return 0n;
  if (units > one) return one;
  return units;
}

function applyRecoverablePercent(amount, recoverablePercent) {
  const amountMinor = moneyToMinorUnits(amount);
  const scale = 10n ** 6n;
  const pctUnits = percentFractionToUnits(recoverablePercent);
  const recoverableMinor = divideAndRoundHalfUp(amountMinor * pctUnits, scale);
  return {
    recoverableAmount: minorUnitsToMoney(recoverableMinor),
    nonRecoverableAmount: minorUnitsToMoney(amountMinor - recoverableMinor),
  };
}

module.exports = {
  MONEY_SCALE,
  RATE_SCALE,
  PERCENT_DENOMINATOR,
  moneyToMinorUnits,
  rateToUnits,
  minorUnitsToMoney,
  normalizeMoney,
  normalizeRate,
  addMoney,
  subtractMoney,
  compareMoney,
  computeTaxMoney,
  computeComponentTaxBreakdown,
  applyRecoverablePercent,
};
