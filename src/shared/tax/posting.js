const {
  moneyToMinorUnits,
  minorUnitsToMoney,
  applyRecoverablePercent,
} = require('./taxMath');

// Compatibility helper for consumers that still expect a Number at the API/UI
// boundary. All aggregation in this module is performed in integer minor units.
function round2(n) {
  return Number(minorUnitsToMoney(moneyToMinorUnits(n)));
}

function emptyMinorBuckets() {
  return {
    recoverable: 0n,
    nonRecoverable: 0n,
    withholding: 0n,
    reverseCharge: 0n,
    total: 0n,
  };
}

function bucketsToNumbers(buckets) {
  return Object.fromEntries(
    Object.entries(buckets).map(([key, value]) => [key, Number(minorUnitsToMoney(value))])
  );
}

function bucketsToStrings(buckets) {
  return Object.fromEntries(
    Object.entries(buckets).map(([key, value]) => [key, minorUnitsToMoney(value)])
  );
}

function summarizeLineTaxDetails(lines = []) {
  const minor = {
    totalTax: 0n,
    recoverableInputTax: 0n,
    nonRecoverableInputTax: 0n,
    reverseChargeTax: 0n,
    outputTax: 0n,
    withholdingReceivable: 0n,
    withholdingPayable: 0n,
  };
  const byPostingAccountMinor = new Map();
  const byLineId = new Map();
  const byLineIdExact = new Map();

  for (const line of lines) {
    const details = Array.isArray(line.taxDetails) ? line.taxDetails : [];
    const buckets = emptyMinorBuckets();

    for (const d of details) {
      const taxAmount = d.taxAmount ?? d.tax_amount ?? 0;
      const taxMinor = moneyToMinorUnits(taxAmount);
      const recoverablePercent = d.recoverablePercent ?? d.recoverable_percent ?? 1;
      const postingAccountId = d.postingAccountId || d.posting_account_id || null;
      const taxType = d.taxType || d.tax_type || null;
      const direction = d.direction || null;
      const reverseCharge = d.reverseCharge === true || d.reverse_charge === true;
      const recovery = applyRecoverablePercent(taxAmount, recoverablePercent);
      const recoverableMinor = moneyToMinorUnits(recovery.recoverableAmount);
      const nonRecoverableMinor = moneyToMinorUnits(recovery.nonRecoverableAmount);

      minor.totalTax += taxMinor;
      buckets.total += taxMinor;
      buckets.recoverable += recoverableMinor;
      buckets.nonRecoverable += nonRecoverableMinor;

      if (direction === 'output') minor.outputTax += taxMinor;
      if (direction === 'input' && taxType !== 'WITHHOLDING') {
        minor.recoverableInputTax += recoverableMinor;
        minor.nonRecoverableInputTax += nonRecoverableMinor;
      }
      if (reverseCharge) {
        minor.reverseChargeTax += taxMinor;
        buckets.reverseCharge += taxMinor;
      }
      if (taxType === 'WITHHOLDING' && direction === 'input') {
        minor.withholdingPayable += taxMinor;
        buckets.withholding += taxMinor;
      }
      if (taxType === 'WITHHOLDING' && direction === 'output') {
        minor.withholdingReceivable += taxMinor;
        buckets.withholding += taxMinor;
      }

      if (postingAccountId) {
        byPostingAccountMinor.set(
          postingAccountId,
          (byPostingAccountMinor.get(postingAccountId) || 0n) + taxMinor
        );
      }
    }

    byLineId.set(line.id, bucketsToNumbers(buckets));
    byLineIdExact.set(line.id, bucketsToStrings(buckets));
  }

  const byPostingAccount = new Map(
    Array.from(byPostingAccountMinor.entries()).map(([accountId, value]) => [
      accountId,
      Number(minorUnitsToMoney(value)),
    ])
  );

  return {
    // Legacy presentation-compatible Number fields. New accounting decisions should use `exact` below.
    totalTax: Number(minorUnitsToMoney(minor.totalTax)),
    recoverableInputTax: Number(minorUnitsToMoney(minor.recoverableInputTax)),
    nonRecoverableInputTax: Number(minorUnitsToMoney(minor.nonRecoverableInputTax)),
    reverseChargeTax: Number(minorUnitsToMoney(minor.reverseChargeTax)),
    outputTax: Number(minorUnitsToMoney(minor.outputTax)),
    withholdingReceivable: Number(minorUnitsToMoney(minor.withholdingReceivable)),
    withholdingPayable: Number(minorUnitsToMoney(minor.withholdingPayable)),
    byPostingAccount,
    byLineId,
    exact: {
      totalTax: minorUnitsToMoney(minor.totalTax),
      recoverableInputTax: minorUnitsToMoney(minor.recoverableInputTax),
      nonRecoverableInputTax: minorUnitsToMoney(minor.nonRecoverableInputTax),
      reverseChargeTax: minorUnitsToMoney(minor.reverseChargeTax),
      outputTax: minorUnitsToMoney(minor.outputTax),
      withholdingReceivable: minorUnitsToMoney(minor.withholdingReceivable),
      withholdingPayable: minorUnitsToMoney(minor.withholdingPayable),
      byPostingAccount: new Map(Array.from(byPostingAccountMinor.entries()).map(([accountId, value]) => [accountId, minorUnitsToMoney(value)])),
      byLineId: byLineIdExact,
    },
  };
}

module.exports = {
  round2,
  summarizeLineTaxDetails,
};
