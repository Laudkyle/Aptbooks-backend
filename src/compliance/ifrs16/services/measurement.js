const { Decimal, AppError, toDecimal, toCurrencyNumber, toISODate, addMonths } = require('./common');

function calculatePresentValue({ payment, annualDiscountRate, periods, paymentsPerYear = 12, paymentTiming = 'arrears' }) {
  const PMT = toDecimal(payment); const ppy = toDecimal(paymentsPerYear); const r = toDecimal(annualDiscountRate).div(ppy); const n = toDecimal(periods);
  if (r.equals(0)) return PMT.times(n);
  const onePlusR = new Decimal(1).plus(r); const power = onePlusR.pow(n.negated());
  const pvOrdinary = PMT.times(new Decimal(1).minus(power)).div(r);
  return paymentTiming === 'advance' ? pvOrdinary.times(onePlusR) : pvOrdinary;
}

function resolveDepreciationPeriods({ termMonths, usefulLifeMonths, ownershipTransfers = false, purchaseOptionReasonablyCertain = false }) {
  const term = Number(termMonths || 0);
  const life = Number(usefulLifeMonths || 0);
  if (ownershipTransfers || purchaseOptionReasonablyCertain) return life > 0 ? life : term;
  if (life > 0 && term > 0) return Math.min(life, term);
  return life > 0 ? life : term;
}

function determineRecognitionModel(lease, contract = {}) {
  if (lease.recognition_model) return lease.recognition_model;
  if (lease.is_short_term_lease) return 'short_term_exempt';
  if (lease.is_low_value_lease) return 'low_value_exempt';
  return 'on_balance_sheet';
}

function buildMeasurement({ lease, contract = null, assets = [], effectiveDate, override = {}, existingLiability = null, fromModification = false }) {
  const paymentTiming = override.payment_timing || lease.payment_timing || contract?.payment_timing || 'arrears';
  const paymentsPerYear = Number(override.payments_per_year || lease.payments_per_year || 12);
  const termMonths = Number(override.term_months || lease.term_months || 0);
  const paymentAmount = toDecimal(override.payment_amount != null ? override.payment_amount : lease.payment_amount);
  const annualDiscountRate = toDecimal(override.annual_discount_rate != null ? override.annual_discount_rate : lease.annual_discount_rate);
  const monthsPerPeriod = new Decimal(12).div(paymentsPerYear);
  if (!monthsPerPeriod.isInteger()) throw new AppError(400, 'payments_per_year must divide 12 evenly');
  const periods = toDecimal(termMonths).times(paymentsPerYear).div(12);
  if (!periods.isInteger() || !periods.greaterThan(0)) throw new AppError(400, 'Term months and payments_per_year must produce a whole number of periods');

  const residualValueGuarantee = toDecimal(contract?.residual_value_guarantee || 0);
  const purchaseOptionAmount = toDecimal(contract?.purchase_option_amount || 0);
  const initialDirectCosts = toDecimal(contract?.initial_direct_costs || 0);
  const leaseIncentives = toDecimal(contract?.lease_incentives || 0);
  const restorationProvision = toDecimal(contract?.restoration_provision || 0);
  const prepaidLeasePayments = toDecimal(contract?.prepaid_lease_payments || 0);
  const accruedLeasePayments = toDecimal(contract?.accrued_lease_payments || 0);

  const liabilityBase = calculatePresentValue({ payment: paymentAmount, annualDiscountRate, periods, paymentsPerYear, paymentTiming })
    .plus(residualValueGuarantee)
    .plus(purchaseOptionAmount);
  const leaseLiability = existingLiability != null ? toDecimal(existingLiability) : liabilityBase;

  const recognitionModel = determineRecognitionModel(lease, contract);
  const initialRouAsset = recognitionModel === 'on_balance_sheet'
    ? leaseLiability.plus(initialDirectCosts).plus(prepaidLeasePayments).plus(restorationProvision).minus(leaseIncentives).minus(accruedLeasePayments)
    : new Decimal(0);

  const primaryAsset = assets.find((a) => a.is_primary) || assets[0] || null;
  const depreciationMonths = resolveDepreciationPeriods({
    termMonths,
    usefulLifeMonths: primaryAsset?.useful_life_months || lease.useful_life_months || termMonths,
    ownershipTransfers: !!lease.ownership_transfers,
    purchaseOptionReasonablyCertain: !!lease.purchase_option_reasonably_certain,
  });
  const periodicDepreciation = depreciationMonths > 0 ? initialRouAsset.div(depreciationMonths) : new Decimal(0);

  return {
    recognitionModel,
    effectiveDate: toISODate(effectiveDate || lease.commencement_date),
    paymentTiming,
    periods: Number(periods),
    monthsPerPeriod: Number(monthsPerPeriod),
    paymentAmount,
    annualDiscountRate,
    initialDirectCosts,
    leaseIncentives,
    restorationProvision,
    prepaidLeasePayments,
    accruedLeasePayments,
    residualValueGuarantee,
    purchaseOptionAmount,
    leaseLiability: leaseLiability.toDecimalPlaces(6),
    initialRouAsset: initialRouAsset.toDecimalPlaces(6),
    depreciationMonths,
    periodicDepreciation: periodicDepreciation.toDecimalPlaces(6),
  };
}

function generateScheduleLines({ lease, measurement, startDate, openingLiability = null }) {
  const periods = Number(measurement.periods);
  const payment = measurement.paymentAmount;
  const periodicRate = measurement.annualDiscountRate.div(lease.payments_per_year || 12);
  const monthsPerPeriod = measurement.monthsPerPeriod;
  const timing = measurement.paymentTiming;
  let opening = openingLiability != null ? toDecimal(openingLiability) : measurement.leaseLiability;
  const lines = [];
  for (let i = 1; i <= periods; i += 1) {
    const offsetPeriods = timing === 'advance' ? (i - 1) : i;
    const dueDate = addMonths(startDate, monthsPerPeriod * offsetPeriods);
    let interest; let principal; let closing; let currentPayment = payment;
    if (timing === 'advance') {
      principal = i === periods ? opening : Decimal.min(payment, opening);
      const afterPayment = opening.minus(principal);
      interest = i === periods ? new Decimal(0) : afterPayment.times(periodicRate);
      closing = afterPayment.plus(interest);
    } else {
      interest = opening.times(periodicRate);
      principal = payment.minus(interest);
      if (principal.lessThan(0)) throw new AppError(400, 'Payment amount is too low for the discount rate; schedule would go negative');
      if (i === periods) {
        principal = opening;
        currentPayment = principal.plus(interest);
        closing = new Decimal(0);
      } else {
        closing = opening.minus(principal);
      }
    }
    let depreciationForPeriod = measurement.periodicDepreciation;
    if (i === periods) depreciationForPeriod = measurement.initialRouAsset.minus(measurement.periodicDepreciation.times(periods - 1));
    lines.push({
      line_no: i,
      due_date: toISODate(dueDate),
      opening_balance: opening.toDecimalPlaces(6).toNumber(),
      payment_amount: currentPayment.toDecimalPlaces(6).toNumber(),
      interest_amount: interest.toDecimalPlaces(6).toNumber(),
      principal_amount: principal.toDecimalPlaces(6).toNumber(),
      closing_balance: closing.toDecimalPlaces(6).toNumber(),
      depreciation_amount: Decimal.max(depreciationForPeriod, 0).toDecimalPlaces(6).toNumber(),
    });
    opening = closing;
  }
  return lines;
}

async function persistMeasurementSnapshot({ client, orgId, actorUserId, leaseId, snapshotType, measurement, modificationId = null, reason = null, payload = {} }) {
  try {
    await client.query(
      `INSERT INTO lease_measurement_snapshots(
          organization_id, lease_id, modification_id, snapshot_type, effective_date,
          payment_timing, term_months, payments_per_year, annual_discount_rate, payment_amount,
          lease_liability_amount, rou_asset_amount, depreciation_basis_amount, depreciation_months,
          initial_direct_costs, lease_incentives, restoration_provision, residual_value_guarantee,
          prepaid_lease_payments, accrued_lease_payments, source_payload, reason, created_by
       ) VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,$10,
          $11,$12,$13,$14,
          $15,$16,$17,$18,
          $19,$20,$21,$22,$23
       )`,
      [
        orgId, leaseId, modificationId, snapshotType, measurement.effectiveDate,
        measurement.paymentTiming, Number(payload.term_months || 0), Number(payload.payments_per_year || 0), measurement.annualDiscountRate.toNumber(), measurement.paymentAmount.toNumber(),
        measurement.leaseLiability.toNumber(), measurement.initialRouAsset.toNumber(), measurement.initialRouAsset.toNumber(), measurement.depreciationMonths,
        measurement.initialDirectCosts.toNumber(), measurement.leaseIncentives.toNumber(), measurement.restorationProvision.toNumber(), measurement.residualValueGuarantee.toNumber(),
        measurement.prepaidLeasePayments.toNumber(), measurement.accruedLeasePayments.toNumber(), payload, reason, actorUserId,
      ]
    );
  } catch (_) {
    // Skip on databases before migration is applied.
  }
}

function journalLine(accountId, debit, credit, memo) {
  return { accountId, debit: toCurrencyNumber(debit), credit: toCurrencyNumber(credit), memo };
}

module.exports = {
  calculatePresentValue,
  resolveDepreciationPeriods,
  determineRecognitionModel,
  buildMeasurement,
  generateScheduleLines,
  persistMeasurementSnapshot,
  journalLine,
};
