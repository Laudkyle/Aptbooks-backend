const { parseDecimalToBigInt, bigIntToDecimalString, divideAndRoundHalfUp } = require('../../../../shared/utils/money');

const SCALE = 2;
const RATE_SCALE = 4; // 10000 = 100.00%, 550 = 5.50%

function toCents(value) {
  return parseDecimalToBigInt(value ?? 0, SCALE);
}
function fromCents(value) {
  return bigIntToDecimalString(BigInt(value || 0), SCALE);
}
function rateUnits(ratePercent) {
  return parseDecimalToBigInt(ratePercent ?? 0, 2); // 5.5 -> 550
}
function percentOfCents(amountCents, ratePercent) {
  return divideAndRoundHalfUp(BigInt(amountCents) * rateUnits(ratePercent), 10000n);
}
function clampCents(value, min, max) {
  let out = BigInt(value);
  if (min !== null && min !== undefined && out < BigInt(min)) out = BigInt(min);
  if (max !== null && max !== undefined && out > BigInt(max)) out = BigInt(max);
  return out;
}
function add(...values) { return values.reduce((s, v) => s + BigInt(v || 0), 0n); }
function max0(v) { return BigInt(v) < 0n ? 0n : BigInt(v); }

function calculateProgressiveTaxCents(amountCents, bands = []) {
  let remaining = max0(amountCents);
  let tax = 0n;
  for (const band of bands) {
    if (remaining <= 0n) break;
    const width = band.amount === null || band.amount === undefined ? null : toCents(band.amount);
    const slice = width === null ? remaining : (remaining < width ? remaining : width);
    tax += percentOfCents(slice, band.rate);
    remaining -= slice;
  }
  return tax;
}

function calculatePaye({
  regularTaxable = 0,
  bonus = 0,
  overtime = 0,
  monthlyBasic = 0,
  annualBasic = null,
  ytdBonusBeforeCurrent = 0,
  approvedRelief = 0,
  residency = 'resident',
  workerClassification = 'regular',
  qualifiesOvertimeConcession = false,
  bands = [],
  nonResidentRate = 25,
  nonResidentBonusOvertimeRate = 20,
  casualRate = 5,
  partTimeResidentRate = 10,
  bonusConcessionRate = 5,
  bonusConcessionPercentOfAnnualBasic = 15,
  overtimeLowerRate = 5,
  overtimeUpperRate = 10,
  overtimeThresholdPercentOfMonthlyBasic = 50,
  overtimeConcessionAnnualIncomeLimit = 18000,
}) {
  const regular = toCents(regularTaxable);
  const bonusCents = toCents(bonus);
  const overtimeCents = toCents(overtime);
  const relief = toCents(approvedRelief);
  const basicMonthly = toCents(monthlyBasic);
  const annualBasicCents = annualBasic === null || annualBasic === undefined
    ? basicMonthly * 12n
    : toCents(annualBasic);
  const priorBonus = toCents(ytdBonusBeforeCurrent);

  if (workerClassification === 'casual') {
    const basis = add(regular, bonusCents, overtimeCents);
    const tax = percentOfCents(basis, casualRate);
    return {
      method: 'casual_final',
      chargeableIncome: fromCents(basis),
      graduatedTax: '0.00',
      bonusTax: '0.00',
      overtimeTax: '0.00',
      finalTax: fromCents(tax),
      totalTax: fromCents(tax),
    };
  }

  if (workerClassification === 'part_time' && residency === 'resident') {
    const basis = add(regular, bonusCents, overtimeCents);
    const tax = percentOfCents(basis, partTimeResidentRate);
    return {
      method: 'part_time_on_account',
      chargeableIncome: fromCents(basis),
      graduatedTax: '0.00',
      bonusTax: '0.00',
      overtimeTax: '0.00',
      finalTax: '0.00',
      totalTax: fromCents(tax),
    };
  }

  // GRA publishes a separate 20% employment withholding rate for bonus/overtime paid to a non-resident employee.
  // Keep the ordinary non-resident chargeable-employment rate separate so historical rule versions can change either independently.
  if (residency === 'nonresident') {
    const chargeableRegular = max0(regular - relief);
    const regularTax = percentOfCents(chargeableRegular, nonResidentRate);
    const bonusTax = percentOfCents(bonusCents, nonResidentBonusOvertimeRate);
    const overtimeTax = percentOfCents(overtimeCents, nonResidentBonusOvertimeRate);
    const total = regularTax + bonusTax + overtimeTax;
    return {
      method: 'nonresident_flat',
      chargeableIncome: fromCents(chargeableRegular),
      bonusConcessionAmount: '0.00',
      bonusExcessAmount: fromCents(bonusCents),
      graduatedTax: fromCents(regularTax),
      bonusTax: fromCents(bonusTax),
      overtimeTax: fromCents(overtimeTax),
      finalTax: fromCents(bonusTax + overtimeTax),
      totalTax: fromCents(total),
    };
  }

  let bonusConcession = 0n;
  let bonusExcess = bonusCents;
  if (bonusCents > 0n) {
    const annualLimit = percentOfCents(annualBasicCents, bonusConcessionPercentOfAnnualBasic);
    const remainingLimit = annualLimit > priorBonus ? annualLimit - priorBonus : 0n;
    bonusConcession = bonusCents < remainingLimit ? bonusCents : remainingLimit;
    bonusExcess = bonusCents - bonusConcession;
  }
  const bonusTax = percentOfCents(bonusConcession, bonusConcessionRate);

  let overtimeTax = 0n;
  let overtimeToGraduated = overtimeCents;
  const overtimeAnnualLimit = toCents(overtimeConcessionAnnualIncomeLimit || 0);
  const withinOvertimeIncomeLimit = overtimeAnnualLimit <= 0n || annualBasicCents <= overtimeAnnualLimit;
  if (qualifiesOvertimeConcession && withinOvertimeIncomeLimit && overtimeCents > 0n) {
    const threshold = percentOfCents(basicMonthly, overtimeThresholdPercentOfMonthlyBasic);
    const lowerSlice = overtimeCents < threshold ? overtimeCents : threshold;
    const upperSlice = overtimeCents - lowerSlice;
    overtimeTax = percentOfCents(lowerSlice, overtimeLowerRate) + percentOfCents(upperSlice, overtimeUpperRate);
    overtimeToGraduated = 0n;
  }

  const chargeable = max0(regular + bonusExcess + overtimeToGraduated - relief);
  let graduatedTax;
  graduatedTax = calculateProgressiveTaxCents(chargeable, bands);

  const total = graduatedTax + bonusTax + overtimeTax;
  return {
    method: 'resident_graduated',
    chargeableIncome: fromCents(chargeable),
    bonusConcessionAmount: fromCents(bonusConcession),
    bonusExcessAmount: fromCents(bonusExcess),
    graduatedTax: fromCents(graduatedTax),
    bonusTax: fromCents(bonusTax),
    overtimeTax: fromCents(overtimeTax),
    finalTax: fromCents(bonusTax + overtimeTax),
    totalTax: fromCents(total),
  };
}

function calculatePension({
  monthlyBasic = 0,
  minimumInsurable = 0,
  maximumInsurable = null,
  employeeRate = 5.5,
  employerRate = 13,
  ssnitRemittanceRate = 13.5,
  tier2Rate = 5,
  minimumSsnitRemittance = null,
  maximumSsnitRemittance = null,
  exempt = false,
}) {
  if (exempt) {
    return {
      insurableEarnings: '0.00', employeeContribution: '0.00', employerContribution: '0.00',
      ssnitTier1Payable: '0.00', tier2Payable: '0.00', totalContribution: '0.00'
    };
  }
  const basic = toCents(monthlyBasic);
  if (basic <= 0n) return calculatePension({ monthlyBasic: 0, exempt: true });
  const minimum = toCents(minimumInsurable || 0);
  const maximum = maximumInsurable === null || maximumInsurable === undefined ? null : toCents(maximumInsurable);
  const insured = clampCents(basic, minimum, maximum);
  const employee = percentOfCents(insured, employeeRate);
  const tier2 = percentOfCents(insured, tier2Rate);
  let tier1 = percentOfCents(insured, ssnitRemittanceRate);

  // SSNIT publishes the actual statutory minimum/maximum Tier-1 contribution in addition to the earnings bounds.
  // Use those published contribution limits when present rather than deriving a different pesewa through generic rounding.
  const minimumTier1 = minimumSsnitRemittance === null || minimumSsnitRemittance === undefined ? null : toCents(minimumSsnitRemittance);
  const maximumTier1 = maximumSsnitRemittance === null || maximumSsnitRemittance === undefined ? null : toCents(maximumSsnitRemittance);
  if (minimumTier1 !== null && insured === minimum && tier1 < minimumTier1) tier1 = minimumTier1;
  if (maximumTier1 !== null && maximum !== null && insured === maximum && tier1 > maximumTier1) tier1 = maximumTier1;

  // The employer funds the remainder after the worker's deduction once the statutory Tier-1/Tier-2 amounts are fixed.
  // This preserves an exactly balanced payroll journal even at a published SSNIT contribution floor.
  const employer = max0(tier1 + tier2 - employee);
  return {
    insurableEarnings: fromCents(insured),
    employeeContribution: fromCents(employee),
    employerContribution: fromCents(employer),
    ssnitTier1Payable: fromCents(tier1),
    tier2Payable: fromCents(tier2),
    totalContribution: fromCents(employee + employer),
  };
}

function computeBaseSalaryForPeriod({ amount = 0, frequency = 'monthly', startDate, endDate }) {
  const base = toCents(amount);
  if (base <= 0n) return '0.00';
  if (frequency === 'monthly') return fromCents(base);
  const start = new Date(`${String(startDate).slice(0,10)}T00:00:00Z`);
  const end = new Date(`${String(endDate).slice(0,10)}T00:00:00Z`);
  const days = BigInt(Math.floor((end - start) / 86400000) + 1);
  if (frequency === 'daily') return fromCents(base * days);
  if (frequency === 'weekly') return fromCents(divideAndRoundHalfUp(base * days, 7n));
  return fromCents(base);
}

function summarizeGhanaPayroll({ baseSalary = 0, regularEarnings = 0, bonus = 0, overtime = 0, nonTaxableEarnings = 0, otherDeductions = 0, relief = 0, employee, settings, ytdBonusBeforeCurrent = 0 }) {
  const base = toCents(baseSalary);
  const regular = toCents(regularEarnings);
  const bonusCents = toCents(bonus);
  const overtimeCents = toCents(overtime);
  const nonTaxable = toCents(nonTaxableEarnings);
  const otherDed = toCents(otherDeductions);
  const gross = add(base, regular, bonusCents, overtimeCents, nonTaxable);

  const pension = calculatePension({
    monthlyBasic: fromCents(base),
    minimumInsurable: settings.minimumInsurable,
    maximumInsurable: settings.maximumInsurable,
    employeeRate: settings.employeePensionRate,
    employerRate: settings.employerPensionRate,
    ssnitRemittanceRate: settings.ssnitRemittanceRate,
    tier2Rate: settings.tier2Rate,
    minimumSsnitRemittance: settings.minimumSsnitRemittance,
    maximumSsnitRemittance: settings.maximumSsnitRemittance,
    exempt: Boolean(employee.pension_exempt),
  });

  // Employee pension contribution is an allowable deduction from employment income for PAYE.
  const regularTaxableCents = max0(base + regular - toCents(pension.employeeContribution));
  const paye = calculatePaye({
    regularTaxable: fromCents(regularTaxableCents),
    bonus: fromCents(bonusCents),
    overtime: fromCents(overtimeCents),
    monthlyBasic: fromCents(base),
    ytdBonusBeforeCurrent,
    approvedRelief: relief,
    residency: employee.tax_residency || 'resident',
    workerClassification: employee.worker_classification || 'regular',
    qualifiesOvertimeConcession: Boolean(employee.qualifies_overtime_concession),
    bands: settings.payeBands,
    nonResidentRate: settings.nonResidentRate,
    nonResidentBonusOvertimeRate: settings.nonResidentBonusOvertimeRate,
    casualRate: settings.casualRate,
    partTimeResidentRate: settings.partTimeResidentRate,
    bonusConcessionRate: settings.bonusConcessionRate,
    bonusConcessionPercentOfAnnualBasic: settings.bonusConcessionPercent,
    overtimeLowerRate: settings.overtimeLowerRate,
    overtimeUpperRate: settings.overtimeUpperRate,
    overtimeThresholdPercentOfMonthlyBasic: settings.overtimeThresholdPercent,
    overtimeConcessionAnnualIncomeLimit: settings.overtimeConcessionAnnualIncomeLimit,
  });

  const deductions = add(otherDed, toCents(pension.employeeContribution), toCents(paye.totalTax));
  const net = gross - deductions;

  return {
    baseSalary: fromCents(base),
    regularEarnings: fromCents(regular),
    bonus: fromCents(bonusCents),
    overtime: fromCents(overtimeCents),
    nonTaxableEarnings: fromCents(nonTaxable),
    grossPay: fromCents(gross),
    otherDeductions: fromCents(otherDed),
    pension,
    paye,
    totalDeductions: fromCents(deductions),
    netPay: fromCents(net),
    employerContributions: pension.employerContribution,
  };
}

module.exports = {
  toCents, fromCents, percentOfCents, calculateProgressiveTaxCents,
  calculatePaye, calculatePension, computeBaseSalaryForPeriod, summarizeGhanaPayroll,
};
