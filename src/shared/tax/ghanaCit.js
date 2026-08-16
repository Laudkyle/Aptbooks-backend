const {
  parseDecimalToBigInt,
  bigIntToDecimalString,
  divideAndRoundHalfUp,
} = require('../utils/money');

const RATE_SCALE = 6;
const RATE_DENOMINATOR = 100n * (10n ** BigInt(RATE_SCALE));

function money(value) {
  return parseDecimalToBigInt(value == null || value === '' ? '0' : String(value), 2);
}

function moneyString(value) {
  return bigIntToDecimalString(value, 2);
}

function rateUnits(value) {
  return parseDecimalToBigInt(value == null || value === '' ? '0' : String(value), RATE_SCALE);
}

function percentOf(amountMinor, rate) {
  const rateMinor = rateUnits(rate);
  if (amountMinor === 0n || rateMinor === 0n) return 0n;
  return divideAndRoundHalfUp(amountMinor * rateMinor, RATE_DENOMINATOR);
}

function nonNegative(value) {
  return value < 0n ? 0n : value;
}

function calculateCitComputation({
  accountingProfit = '0',
  addBacks = '0',
  otherAssessableIncome = '0',
  allowableDeductions = '0',
  capitalAllowance = '0',
  lossRelief = '0',
  taxRate = '25.000000',
  withholdingCredits = '0',
  otherTaxCredits = '0',
  instalmentsPaid = '0',
} = {}) {
  const accountingProfitMinor = money(accountingProfit);
  const addBacksMinor = money(addBacks);
  const otherIncomeMinor = money(otherAssessableIncome);
  const deductionsMinor = money(allowableDeductions);
  const capitalAllowanceMinor = money(capitalAllowance);
  const lossReliefMinor = money(lossRelief);
  const withholdingCreditsMinor = money(withholdingCredits);
  const otherCreditsMinor = money(otherTaxCredits);
  const instalmentsPaidMinor = money(instalmentsPaid);

  const adjustedProfitMinor = accountingProfitMinor + addBacksMinor + otherIncomeMinor - deductionsMinor;
  const chargeableIncomeMinor = nonNegative(adjustedProfitMinor - capitalAllowanceMinor - lossReliefMinor);
  const grossTaxMinor = percentOf(chargeableIncomeMinor, taxRate);
  const totalCreditsMinor = nonNegative(withholdingCreditsMinor + otherCreditsMinor);
  const taxAfterCreditsMinor = nonNegative(grossTaxMinor - totalCreditsMinor);
  const netTaxPayableMinor = nonNegative(taxAfterCreditsMinor - instalmentsPaidMinor);
  const overpaymentMinor = nonNegative(instalmentsPaidMinor - taxAfterCreditsMinor);

  return {
    accountingProfit: moneyString(accountingProfitMinor),
    addBacks: moneyString(addBacksMinor),
    otherAssessableIncome: moneyString(otherIncomeMinor),
    allowableDeductions: moneyString(deductionsMinor),
    adjustedProfit: moneyString(adjustedProfitMinor),
    capitalAllowance: moneyString(capitalAllowanceMinor),
    lossRelief: moneyString(lossReliefMinor),
    chargeableIncome: moneyString(chargeableIncomeMinor),
    taxRate: bigIntToDecimalString(rateUnits(taxRate), RATE_SCALE),
    grossTax: moneyString(grossTaxMinor),
    withholdingCredits: moneyString(withholdingCreditsMinor),
    otherTaxCredits: moneyString(otherCreditsMinor),
    totalCredits: moneyString(totalCreditsMinor),
    taxAfterCredits: moneyString(taxAfterCreditsMinor),
    instalmentsPaid: moneyString(instalmentsPaidMinor),
    netTaxPayable: moneyString(netTaxPayableMinor),
    overpayment: moneyString(overpaymentMinor),
  };
}

function calculateSelfAssessment({ estimatedChargeableIncome = '0', taxRate = '25.000000', taxCredits = '0', instalmentsPaid = '0' } = {}) {
  const estimatedIncomeMinor = nonNegative(money(estimatedChargeableIncome));
  const grossTaxMinor = percentOf(estimatedIncomeMinor, taxRate);
  const creditsMinor = nonNegative(money(taxCredits));
  const estimatedTaxMinor = nonNegative(grossTaxMinor - creditsMinor);
  const paidMinor = nonNegative(money(instalmentsPaid));
  const remainingMinor = nonNegative(estimatedTaxMinor - paidMinor);
  return {
    estimatedChargeableIncome: moneyString(estimatedIncomeMinor),
    taxRate: bigIntToDecimalString(rateUnits(taxRate), RATE_SCALE),
    grossEstimatedTax: moneyString(grossTaxMinor),
    taxCredits: moneyString(creditsMinor),
    estimatedAnnualTax: moneyString(estimatedTaxMinor),
    instalmentsPaid: moneyString(paidMinor),
    remainingTax: moneyString(remainingMinor),
  };
}

function splitQuarterlyInstalments(annualTax) {
  const total = nonNegative(money(annualTax));
  const base = total / 4n;
  let remainder = total % 4n;
  const values = [];
  for (let i = 0; i < 4; i += 1) {
    let amount = base;
    if (remainder > 0n) { amount += 1n; remainder -= 1n; }
    values.push(moneyString(amount));
  }
  return values;
}

function calculateCapitalAllowance({
  openingTaxWdv = '0',
  additions = '0',
  disposals = '0',
  rate = '0',
  usefulLifeYears = null,
  straightLineCostBasis = null,
  daysInBasisPeriod = 365,
  method = 'reducing_balance',
} = {}) {
  const openingMinor = nonNegative(money(openingTaxWdv));
  const additionsMinor = nonNegative(money(additions));
  const disposalsMinor = nonNegative(money(disposals));
  const basisBeforeAllowanceMinor = nonNegative(openingMinor + additionsMinor - disposalsMinor);
  const days = BigInt(Math.max(0, Math.min(366, Number(daysInBasisPeriod || 365))));

  let annualAllowanceMinor = 0n;
  if (method === 'useful_life') {
    const years = Number(usefulLifeYears || 0);
    if (!Number.isFinite(years) || years <= 0) throw new Error('usefulLifeYears must be greater than zero');
    const originalCostMinor = straightLineCostBasis == null ? (additionsMinor || basisBeforeAllowanceMinor) : nonNegative(money(straightLineCostBasis));
    const annualMinor = divideAndRoundHalfUp(originalCostMinor, BigInt(Math.round(years)));
    annualAllowanceMinor = divideAndRoundHalfUp(annualMinor * days, 365n);
  } else if (method === 'straight_line') {
    const originalCostMinor = straightLineCostBasis == null ? (additionsMinor || basisBeforeAllowanceMinor) : nonNegative(money(straightLineCostBasis));
    const rawAnnual = percentOf(originalCostMinor, rate);
    annualAllowanceMinor = divideAndRoundHalfUp(rawAnnual * days, 365n);
  } else {
    const rawAnnual = percentOf(basisBeforeAllowanceMinor, rate);
    annualAllowanceMinor = divideAndRoundHalfUp(rawAnnual * days, 365n);
  }

  if (annualAllowanceMinor > basisBeforeAllowanceMinor) annualAllowanceMinor = basisBeforeAllowanceMinor;
  const closingMinor = nonNegative(basisBeforeAllowanceMinor - annualAllowanceMinor);
  return {
    openingTaxWdv: moneyString(openingMinor),
    additions: moneyString(additionsMinor),
    disposals: moneyString(disposalsMinor),
    allowanceBasis: moneyString(basisBeforeAllowanceMinor),
    rate: bigIntToDecimalString(rateUnits(rate), RATE_SCALE),
    method,
    daysInBasisPeriod: Number(days),
    capitalAllowance: moneyString(annualAllowanceMinor),
    closingTaxWdv: moneyString(closingMinor),
  };
}

function addMonthsToDate(dateString, months) {
  const [y, m, d] = String(dateString).split('-').map(Number);
  if (!y || !m || !d) throw new Error('Invalid date');
  const zeroBasedTarget = (m - 1) + Number(months || 0);
  const targetYear = y + Math.floor(zeroBasedTarget / 12);
  const targetMonthZero = ((zeroBasedTarget % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonthZero + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return new Date(Date.UTC(targetYear, targetMonthZero, day)).toISOString().slice(0, 10);
}

function addDaysToDate(dateString, days) {
  const [y, m, d] = String(dateString).split('-').map(Number);
  if (!y || !m || !d) throw new Error('Invalid date');
  const dt = new Date(Date.UTC(y, m - 1, d + Number(days || 0)));
  return dt.toISOString().slice(0, 10);
}

function annualReturnDueDate(basisPeriodEnd) {
  return addMonthsToDate(basisPeriodEnd, 4);
}

function quarterlyInstalmentDueDates(basisPeriodStart) {
  return [3, 6, 9, 12].map((months) => addDaysToDate(addMonthsToDate(basisPeriodStart, months), -1));
}

module.exports = {
  calculateCitComputation,
  calculateSelfAssessment,
  splitQuarterlyInstalments,
  calculateCapitalAllowance,
  annualReturnDueDate,
  quarterlyInstalmentDueDates,
};
