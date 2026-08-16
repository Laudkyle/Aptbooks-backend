const {
  moneyToMinorUnits,
  minorUnitsToMoney,
} = require('./taxMath');
const { divideAndRoundHalfUp } = require('../utils/money');

const RATIO_SCALE = 6;
const RATIO_DENOM = 10n ** BigInt(RATIO_SCALE);

function clampRatioUnits(value) {
  if (value < 0n) return 0n;
  if (value > RATIO_DENOM) return RATIO_DENOM;
  return value;
}

function ratioUnitsToString(value) {
  const clamped = clampRatioUnits(value);
  const whole = clamped / RATIO_DENOM;
  const fraction = String(clamped % RATIO_DENOM).padStart(RATIO_SCALE, '0');
  return `${whole}.${fraction}`;
}

function parseRatioToUnits(value) {
  if (value == null || value === '') return 0n;
  const raw = String(value).trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) throw new Error('Invalid ratio');
  const [whole, fraction = ''] = raw.split('.');
  return clampRatioUnits(BigInt(whole) * RATIO_DENOM + BigInt((fraction + '000000').slice(0, 6)));
}

function computeTurnoverRecoveryRatio({ taxableSupplies, totalSupplies }) {
  const taxableMinor = moneyToMinorUnits(taxableSupplies);
  const totalMinor = moneyToMinorUnits(totalSupplies);
  if (taxableMinor < 0n || totalMinor < 0n) throw new Error('Supply values cannot be negative');
  if (totalMinor === 0n) {
    return {
      rawRatio: '0.000000',
      allowedRatio: '0.000000',
      thresholdApplied: 'no_supplies',
    };
  }

  const rawUnits = clampRatioUnits(divideAndRoundHalfUp(taxableMinor * RATIO_DENOM, totalMinor));
  const fivePercent = 50_000n;
  const ninetyFivePercent = 950_000n;
  let allowedUnits = rawUnits;
  let thresholdApplied = 'pro_rata';
  if (rawUnits < fivePercent) {
    allowedUnits = 0n;
    thresholdApplied = 'below_5_percent_none';
  } else if (rawUnits > ninetyFivePercent) {
    allowedUnits = RATIO_DENOM;
    thresholdApplied = 'above_95_percent_full';
  }
  return {
    rawRatio: ratioUnitsToString(rawUnits),
    allowedRatio: ratioUnitsToString(allowedUnits),
    thresholdApplied,
  };
}

function applyRecoveryRatio(amount, ratio) {
  const amountMinor = moneyToMinorUnits(amount);
  const ratioUnits = parseRatioToUnits(ratio);
  const recoverableMinor = divideAndRoundHalfUp(amountMinor * ratioUnits, RATIO_DENOM);
  return {
    recoverableAmount: minorUnitsToMoney(recoverableMinor),
    nonRecoverableAmount: minorUnitsToMoney(amountMinor - recoverableMinor),
  };
}

function calculateInputTaxApportionment({
  taxableSupplies,
  exemptSupplies,
  mixedInputTax,
  directTaxableInputTax = '0.00',
  directExemptInputTax = '0.00',
}) {
  const taxableMinor = moneyToMinorUnits(taxableSupplies);
  const exemptMinor = moneyToMinorUnits(exemptSupplies);
  const totalMinor = taxableMinor + exemptMinor;
  const ratio = computeTurnoverRecoveryRatio({
    taxableSupplies: minorUnitsToMoney(taxableMinor),
    totalSupplies: minorUnitsToMoney(totalMinor),
  });
  const mixedRecovery = applyRecoveryRatio(mixedInputTax, ratio.allowedRatio);
  const totalRecoverable = moneyToMinorUnits(directTaxableInputTax) + moneyToMinorUnits(mixedRecovery.recoverableAmount);
  const totalNonRecoverable = moneyToMinorUnits(directExemptInputTax) + moneyToMinorUnits(mixedRecovery.nonRecoverableAmount);

  return {
    taxableSupplies: minorUnitsToMoney(taxableMinor),
    exemptSupplies: minorUnitsToMoney(exemptMinor),
    totalSupplies: minorUnitsToMoney(totalMinor),
    rawRecoveryRatio: ratio.rawRatio,
    allowedRecoveryRatio: ratio.allowedRatio,
    thresholdApplied: ratio.thresholdApplied,
    directTaxableInputTax: minorUnitsToMoney(moneyToMinorUnits(directTaxableInputTax)),
    directExemptInputTax: minorUnitsToMoney(moneyToMinorUnits(directExemptInputTax)),
    mixedInputTax: minorUnitsToMoney(moneyToMinorUnits(mixedInputTax)),
    recoverableMixedInputTax: mixedRecovery.recoverableAmount,
    nonRecoverableMixedInputTax: mixedRecovery.nonRecoverableAmount,
    totalRecoverableInputTax: minorUnitsToMoney(totalRecoverable),
    totalNonRecoverableInputTax: minorUnitsToMoney(totalNonRecoverable),
  };
}

function calculateVatRegistrationMonitor({ taxableGoodsTurnover, threshold = '750000.00', isRegistered = false }) {
  const turnoverMinor = moneyToMinorUnits(taxableGoodsTurnover);
  const thresholdMinor = moneyToMinorUnits(threshold);
  if (thresholdMinor <= 0n) throw new Error('VAT registration threshold must be positive');
  const remainingMinor = thresholdMinor - turnoverMinor;
  const ratioUnits = clampRatioUnits(divideAndRoundHalfUp(turnoverMinor * RATIO_DENOM, thresholdMinor));
  const status = isRegistered
    ? 'registered'
    : turnoverMinor >= thresholdMinor
      ? 'threshold_met'
      : ratioUnits >= 900_000n
        ? 'approaching_threshold'
        : 'below_threshold';
  return {
    taxableGoodsTurnover: minorUnitsToMoney(turnoverMinor),
    threshold: minorUnitsToMoney(thresholdMinor),
    remaining: minorUnitsToMoney(remainingMinor > 0n ? remainingMinor : 0n),
    thresholdProgress: ratioUnitsToString(ratioUnits),
    status,
    registrationRequiredByMonitor: !isRegistered && turnoverMinor >= thresholdMinor,
  };
}

module.exports = {
  RATIO_SCALE,
  RATIO_DENOM,
  parseRatioToUnits,
  ratioUnitsToString,
  computeTurnoverRecoveryRatio,
  applyRecoveryRatio,
  calculateInputTaxApportionment,
  calculateVatRegistrationMonitor,
};
