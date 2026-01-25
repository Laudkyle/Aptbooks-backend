import Decimal from 'decimal.js'; 

// Configure Decimal.js for financial calculations
Decimal.set({
  precision: 20,      // High precision for financial calculations
  rounding: Decimal.ROUND_HALF_EVEN,  // Banker's rounding (standard for accounting)
  toExpNeg: -10,      // Prevent scientific notation for small numbers
  toExpPos: 20,       // Prevent scientific notation for large numbers
}); 

/**
 * Convert any value to Decimal safely
 */
export function toDecimal(value, defaultValue = new Decimal(0)) {
  if (value instanceof Decimal) return value; 
  if (value === null || value === undefined || value === '') return defaultValue; 
  
  try {
    return new Decimal(value); 
  } catch (error) {
    console.warn(`Failed to convert value to Decimal: ${value}`, error); 
    return defaultValue; 
  }
}

/**
 * Round to specified decimal places with banker's rounding
 */
export function roundDecimal(value, decimals = 2) {
  const decimal = toDecimal(value); 
  return decimal.toDecimalPlaces(decimals, Decimal.ROUND_HALF_EVEN); 
}

/**
 * Convert Decimal to currency amount (2 decimal places)
 */
export function toCurrencyAmount(value) {
  return roundDecimal(value, 2); 
}

/**
 * Convert Decimal to number for database storage (with specified decimals)
 */
export function toNumber(value, decimals = 6) {
  const decimal = toDecimal(value); 
  return decimal.toDecimalPlaces(decimals, Decimal.ROUND_HALF_EVEN).toNumber(); 
}

/**
 * Present Value calculation for lease accounting
 * PV = PMT × [1 - (1 + r)^-n] / r
 */
export function calculatePresentValue({
  payment,
  annualDiscountRate,
  termMonths,
  paymentTiming = 'arrears', // 'arrears' or 'advance'
}) {
  const PMT = toDecimal(payment); 
  const r = toDecimal(annualDiscountRate).div(12);  // Monthly rate
  const n = toDecimal(termMonths); 
  
  // Handle zero interest rate
  if (r.equals(0)) {
    const pv = PMT.times(n); 
    return paymentTiming === 'advance' ? pv : pv; 
  }
  
  // Calculate (1 + r)^-n
  const onePlusR = new Decimal(1).plus(r); 
  const power = onePlusR.pow(n.negated()); 
  
  // PV of ordinary annuity: PMT × [1 - (1 + r)^-n] / r
  const pvOrdinary = PMT.times(new Decimal(1).minus(power)).div(r); 
  
  // If payments are in advance, multiply by (1 + r)
  if (paymentTiming === 'advance') {
    return pvOrdinary.times(onePlusR); 
  }
  
  return pvOrdinary; 
}

/**
 * Calculate lease liability amortization schedule
 */
export function calculateAmortizationSchedule({
  payment,
  annualDiscountRate,
  termMonths,
  paymentTiming = 'arrears',
  initialLiability,
}) {
  const PMT = toDecimal(payment); 
  const r = toDecimal(annualDiscountRate).div(12); 
  const n = toDecimal(termMonths); 
  const liability = toDecimal(initialLiability); 
  
  const schedule = []; 
  let balance = liability; 
  
  for (let period = 1;  period <= n.toNumber();  period++) {
    const interest = balance.times(r); 
    const principal = PMT.minus(interest); 
    const endingBalance = balance.minus(principal); 
    
    schedule.push({
      period,
      beginningBalance: toNumber(balance, 6),
      payment: toNumber(PMT, 6),
      interest: toNumber(interest, 6),
      principal: toNumber(principal, 6),
      endingBalance: toNumber(endingBalance, 6),
    }); 
    
    balance = endingBalance; 
  }
  
  return schedule; 
}

/**
 * Validate that amounts are positive and within reasonable bounds
 */
export function validateFinancialAmount(value, min = 0, max = 999999999999) {
  const amount = toDecimal(value); 
  
  if (amount.lessThan(min)) {
    throw new Error(`Amount must be at least ${min}`); 
  }
  
  if (amount.greaterThan(max)) {
    throw new Error(`Amount cannot exceed ${max}`); 
  }
  
  return amount; 
}