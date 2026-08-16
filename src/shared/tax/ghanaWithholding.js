const { parseDecimalToBigInt, bigIntToDecimalString, divideAndRoundHalfUp } = require('../utils/money');

const RATE_SCALE = 6;
const RATE_DENOMINATOR = 100n * (10n ** BigInt(RATE_SCALE));

function normalizeMoney(value) {
  return bigIntToDecimalString(parseDecimalToBigInt(value ?? '0', 2), 2);
}

function percentageOf(amount, rate) {
  const amountCents = parseDecimalToBigInt(amount ?? '0', 2);
  const rateScaled = parseDecimalToBigInt(rate ?? '0', RATE_SCALE);
  return bigIntToDecimalString(divideAndRoundHalfUp(amountCents * rateScaled, RATE_DENOMINATOR), 2);
}

function calculateIncomeWithholding({
  paymentAmount,
  rate,
  priorQualifyingPayments = '0.00',
  thresholdAmount = null,
  thresholdBasis = 'none',
  exempt = false,
  treatment = 'creditable',
}) {
  const paymentCents = parseDecimalToBigInt(paymentAmount ?? '0', 2);
  const priorCents = parseDecimalToBigInt(priorQualifyingPayments ?? '0', 2);
  const thresholdCents = thresholdAmount == null ? null : parseDecimalToBigInt(thresholdAmount, 2);
  const cumulativeCents = priorCents + paymentCents;

  let applies = !exempt && paymentCents > 0n;
  let thresholdStatus = 'not_applicable';

  if (applies && thresholdBasis === 'annual_cumulative' && thresholdCents != null) {
    if (cumulativeCents <= thresholdCents) {
      applies = false;
      thresholdStatus = cumulativeCents === thresholdCents ? 'at_threshold' : 'below_threshold';
    } else {
      thresholdStatus = priorCents >= thresholdCents ? 'already_exceeded' : 'crossed_threshold';
    }
  }

  const withheld = applies ? percentageOf(bigIntToDecimalString(paymentCents, 2), rate) : '0.00';

  return {
    applies,
    paymentAmount: bigIntToDecimalString(paymentCents, 2),
    priorQualifyingPayments: bigIntToDecimalString(priorCents, 2),
    cumulativeQualifyingPayments: bigIntToDecimalString(cumulativeCents, 2),
    thresholdAmount: thresholdCents == null ? null : bigIntToDecimalString(thresholdCents, 2),
    thresholdBasis,
    thresholdStatus,
    taxableBasis: applies ? bigIntToDecimalString(paymentCents, 2) : '0.00',
    rate: String(rate ?? '0'),
    withheldAmount: withheld,
    treatment,
    exempt: !!exempt,
  };
}

function calculateVatWithholding({
  taxableValue,
  rate = '7.000000',
  isWithholdingAgent = false,
  supplierVatRegistered = true,
  standardRatedSupply = true,
  exempt = false,
}) {
  const base = normalizeMoney(taxableValue);
  const applies = !!isWithholdingAgent && !!supplierVatRegistered && !!standardRatedSupply && !exempt && parseDecimalToBigInt(base, 2) > 0n;
  return {
    applies,
    taxableValue: base,
    rate: String(rate),
    withheldAmount: applies ? percentageOf(base, rate) : '0.00',
    reason: applies
      ? 'appointed_agent_standard_rated_supply'
      : exempt
        ? 'exempt'
        : !isWithholdingAgent
          ? 'organization_not_vat_withholding_agent'
          : !supplierVatRegistered
            ? 'supplier_not_vat_registered'
            : !standardRatedSupply
              ? 'supply_not_standard_rated'
              : 'not_applicable',
  };
}

function withholdingDueDate(periodEnd) {
  const d = new Date(`${periodEnd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid periodEnd');
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 15));
  return next.toISOString().slice(0, 10);
}

function taxYearFor(date) {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid date');
  return d.getUTCFullYear();
}

module.exports = {
  percentageOf,
  calculateIncomeWithholding,
  calculateVatWithholding,
  withholdingDueDate,
  taxYearFor,
};
