const { z } = require('zod');
const { parseDecimalToBigInt } = require('../utils/money');

function normalizeDecimalInput(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return value;
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value.trim();
  return value;
}

function decimalValue({ scale = 2, positive = false, nonnegative = false, label = 'Value' } = {}) {
  const fractional = scale > 0 ? `(?:\\.\\d{1,${scale}})?` : '';
  const pattern = new RegExp(`^-?\\d+${fractional}$`);

  return z.preprocess(
    normalizeDecimalInput,
    z.string().superRefine((value, ctx) => {
      if (!pattern.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be a decimal with at most ${scale} decimal place${scale === 1 ? '' : 's'}`,
        });
        return;
      }
      try {
        const units = parseDecimalToBigInt(value, scale);
        if (positive && units <= 0n) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be greater than 0` });
        } else if (nonnegative && units < 0n) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be 0 or greater` });
        }
      } catch (_err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} is not a valid decimal` });
      }
    })
  );
}

const moneyAmount = decimalValue({ scale: 2, nonnegative: true, label: 'Amount' });
const positiveMoneyAmount = decimalValue({ scale: 2, positive: true, label: 'Amount' });
const signedMoneyAmount = decimalValue({ scale: 2, label: 'Amount' });
const quantityAmount = decimalValue({ scale: 6, positive: true, label: 'Quantity' });
const nonnegativeQuantityAmount = decimalValue({ scale: 6, nonnegative: true, label: 'Quantity' });
const unitCostAmount = decimalValue({ scale: 6, nonnegative: true, label: 'Unit cost' });

module.exports = {
  normalizeDecimalInput,
  decimalValue,
  moneyAmount,
  positiveMoneyAmount,
  signedMoneyAmount,
  quantityAmount,
  nonnegativeQuantityAmount,
  unitCostAmount,
};
