/*
  Money utilities for numeric(18,2)-style amounts.

  Goals:
  - Avoid floating point rounding errors.
  - Provide strict parsing (no more than the configured scale).

  Representation:
  - BigInt integer of minor units (e.g., cents) where scale=2.
*/

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
    throw new Error(`Too many decimal places;  max ${scale}`); 
  }

  const fracPart = fracRaw.padEnd(scale, "0"); 
  const combined = intPart + fracPart; 
  const bi = BigInt(combined || "0"); 
  return sign * bi; 
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

  // product scale = qtyScale + moneyScale;  we want moneyScale.
  // So divide by 10^qtyScale with half-up rounding.
  const denom = 10n ** BigInt(qtyScale); 
  const half = denom / 2n; 

  const product = qtyBI * priceBI; 
  const rounded = product >= 0n ? (product + half) / denom : (product - half) / denom; 
  return rounded; 
}

module.exports = {
  parseDecimalToBigInt,
  bigIntToDecimalString,
  multiplyQtyByUnitPriceToMoney
}; 
