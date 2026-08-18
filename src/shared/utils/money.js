/*
  Money utilities for numeric(18,2)-style amounts.

  Goals:
  - Avoid floating point rounding errors.
  - Provide strict parsing (no more than the configured scale).

  Representation:
  - BigInt integer of minor units (e.g., cents) where scale=2.
*/


const FINANCIAL_SCALE = Object.freeze({
  money: 2,
  documentQuantity: 4,
  documentUnitPrice: 2,
  quantity: 6,
  unitPrice: 6,
  unitCost: 6,
  percentagePoints: 6,
  fraction: 6,
  exchangeRate: 6,
});

function powerOfTen(scale) {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw new Error("Invalid fixed-point scale");
  }
  return 10n ** BigInt(scale);
}

function assertFiniteNumber(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error("Invalid number");
  }
}

function normaliseToString(value) {
  if (value === null || value === undefined || value === "") return "0";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") {
    assertFiniteNumber(value);
    // Convert to string without exponential notation when possible.
    return String(value);
  }
  throw new Error("Invalid decimal value type");
}

/**
 * Parse a decimal string/number into a BigInt representing value * 10^scale.
 *
 * Examples (scale=2):
 *  "10" -> 1000n
 *  "10.50" -> 1050n
 *
 * Notes:
 * - Rejects more than 'scale' fractional digits.
 */
function parseDecimalToBigInt(value, scale = 2) {
  const s = normaliseToString(value);
  if (s === "") return 0n;

  const m = s.match(/^([+-])?(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error("Invalid decimal format");

  const sign = m[1] === "-" ? -1n : 1n;
  const intPart = m[2];
  const fracRaw = m[3] || "";
  if (fracRaw.length > scale) {
    throw new Error(`Too many decimal places; max ${scale}`);
  }

  const fracPart = fracRaw.padEnd(scale, "0");
  const combined = intPart + fracPart;
  const bi = BigInt(combined || "0");
  return sign * bi;
}

/**
 * Parse a decimal value to a target scale and round excess fractional digits
 * using round-half-up. Use this at explicit accounting rounding boundaries.
 */
function parseDecimalRoundedToBigInt(value, scale = 2, maxInputScale = 18) {
  const raw = normaliseToString(value);
  const match = raw.match(/^([+-])?(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error("Invalid decimal format");
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2];
  const fraction = match[3] || "";
  if (fraction.length > maxInputScale) throw new Error(`Too many decimal places; max ${maxInputScale}`);
  const kept = fraction.slice(0, scale).padEnd(scale, "0");
  let units = BigInt(`${whole}${kept}` || "0");
  const discarded = fraction.slice(scale);
  if (discarded && discarded[0] >= "5") units += 1n;
  return sign * units;
}

/**
 * Divide two BigInts using round-half-up semantics.
 *
 * This is intended for monetary/rate conversions where plain BigInt division
 * would silently truncate fractional minor units. Denominator must be positive.
 */
function divideAndRoundHalfUp(numerator, denominator) {
  if (typeof numerator !== "bigint" || typeof denominator !== "bigint") {
    throw new Error("divideAndRoundHalfUp expects BigInt values");
  }
  if (denominator <= 0n) throw new Error("Denominator must be positive");

  if (numerator === 0n) return 0n;
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

function bigIntToDecimalString(valueBigInt, scale = 2) {
  let v = valueBigInt;
  const sign = v < 0n ? "-" : "";
  if (v < 0n) v = -v;

  const s = v.toString();
  if (scale === 0) return sign + s;

  const pad = scale + 1;
  const padded = s.length < pad ? s.padStart(pad, "0") : s;
  const intPart = padded.slice(0, -scale);
  const fracPart = padded.slice(-scale);
  return sign + intPart + "." + fracPart;
}

/**
 * Compute cents for (qty * unitPrice) with configurable qty scale.
 *
 * qtyScale: number of decimal places allowed for quantity.
 * unitPrice assumed to be money with moneyScale (default 2).
 * Output is money in minor units (moneyScale).
 */
function multiplyQtyByUnitPriceToMoney(qty, unitPrice, qtyScale = 6, moneyScale = 2) {
  const qtyBI = parseDecimalToBigInt(qty, qtyScale);
  const priceBI = parseDecimalToBigInt(unitPrice, moneyScale);

  // product scale = qtyScale + moneyScale; we want moneyScale.
  // So divide by 10^qtyScale with half-up rounding.
  const denom = 10n ** BigInt(qtyScale);
  const half = denom / 2n;

  const product = qtyBI * priceBI;
  const rounded = product >= 0n ? (product + half) / denom : (product - half) / denom;
  return rounded;
}

/**
 * Multiply two scaled decimal values and return a BigInt at outputScale.
 * All down-scaling uses the same round-half-up policy as the journal/tax kernels.
 */
function multiplyScaledDecimals(left, leftScale, right, rightScale, outputScale) {
  const leftUnits = parseDecimalToBigInt(left, leftScale);
  const rightUnits = parseDecimalToBigInt(right, rightScale);
  const product = leftUnits * rightUnits;
  const productScale = leftScale + rightScale;
  if (productScale === outputScale) return product;
  if (productScale < outputScale) return product * powerOfTen(outputScale - productScale);
  return divideAndRoundHalfUp(product, powerOfTen(productScale - outputScale));
}

/** Percentage-point semantics: 1.000000 means 1 percent, not 100 percent. */
function parsePercentagePoints(value, scale = FINANCIAL_SCALE.percentagePoints) {
  const units = parseDecimalToBigInt(value == null || value === "" ? "0" : value, scale);
  if (units < 0n) throw new Error("Percentage rate cannot be negative");
  return units;
}

function applyPercentagePointUnits(amountUnits, rateUnits, rateScale = FINANCIAL_SCALE.percentagePoints) {
  if (typeof amountUnits !== "bigint" || typeof rateUnits !== "bigint") {
    throw new Error("amountUnits and rateUnits must be BigInt values");
  }
  if (rateUnits < 0n) throw new Error("Percentage rate cannot be negative");
  const denominator = 100n * powerOfTen(rateScale);
  return divideAndRoundHalfUp(amountUnits * rateUnits, denominator);
}

function applyPercentagePoints(amountUnits, rate, rateScale = FINANCIAL_SCALE.percentagePoints) {
  return applyPercentagePointUnits(amountUnits, parsePercentagePoints(rate, rateScale), rateScale);
}

function calculateInclusiveTaxUnits(grossUnits, rate, rateScale = FINANCIAL_SCALE.percentagePoints) {
  if (typeof grossUnits !== "bigint") throw new Error("grossUnits must be a BigInt");
  const rateUnits = parsePercentagePoints(rate, rateScale);
  if (rateUnits === 0n) return { baseUnits: grossUnits, taxUnits: 0n };
  const hundred = 100n * powerOfTen(rateScale);
  const baseUnits = divideAndRoundHalfUp(grossUnits * hundred, hundred + rateUnits);
  return { baseUnits, taxUnits: grossUnits - baseUnits };
}

module.exports = {
  FINANCIAL_SCALE,
  powerOfTen,
  parseDecimalToBigInt,
  parseDecimalRoundedToBigInt,
  bigIntToDecimalString,
  multiplyQtyByUnitPriceToMoney,
  multiplyScaledDecimals,
  parsePercentagePoints,
  applyPercentagePointUnits,
  applyPercentagePoints,
  calculateInclusiveTaxUnits,
  divideAndRoundHalfUp
};
