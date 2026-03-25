function round2(n) {
  return Number(Number(n || 0).toFixed(2));
}

function summarizeLineTaxDetails(lines = []) {
  const summary = {
    totalTax: 0,
    recoverableInputTax: 0,
    nonRecoverableInputTax: 0,
    reverseChargeTax: 0,
    outputTax: 0,
    withholdingReceivable: 0,
    withholdingPayable: 0,
    byPostingAccount: new Map(),
    byLineId: new Map()
  };

  for (const line of lines) {
    const details = Array.isArray(line.taxDetails) ? line.taxDetails : [];
    const buckets = {
      recoverable: 0,
      nonRecoverable: 0,
      withholding: 0,
      reverseCharge: 0,
      total: 0
    };
    for (const d of details) {
      const taxAmount = round2(d.taxAmount || d.tax_amount || 0);
      const recoverablePercent = Number(d.recoverablePercent ?? d.recoverable_percent ?? 1);
      const postingAccountId = d.postingAccountId || d.posting_account_id || null;
      const taxType = d.taxType || d.tax_type || null;
      const direction = d.direction || null;
      const reverseCharge = d.reverseCharge === true || d.reverse_charge === true;
      const recoverablePortion = round2(taxAmount * Math.max(0, Math.min(1, recoverablePercent)));
      const nonRecoverablePortion = round2(taxAmount - recoverablePortion);

      summary.totalTax = round2(summary.totalTax + taxAmount);
      buckets.total = round2(buckets.total + taxAmount);
      buckets.recoverable = round2(buckets.recoverable + recoverablePortion);
      buckets.nonRecoverable = round2(buckets.nonRecoverable + nonRecoverablePortion);

      if (direction === 'output') summary.outputTax = round2(summary.outputTax + taxAmount);
      if (direction === 'input' && taxType !== 'WITHHOLDING') {
        summary.recoverableInputTax = round2(summary.recoverableInputTax + recoverablePortion);
        summary.nonRecoverableInputTax = round2(summary.nonRecoverableInputTax + nonRecoverablePortion);
      }
      if (reverseCharge) {
        summary.reverseChargeTax = round2(summary.reverseChargeTax + taxAmount);
        buckets.reverseCharge = round2(buckets.reverseCharge + taxAmount);
      }
      if (taxType === 'WITHHOLDING' && direction === 'input') {
        summary.withholdingPayable = round2(summary.withholdingPayable + taxAmount);
        buckets.withholding = round2(buckets.withholding + taxAmount);
      }
      if (taxType === 'WITHHOLDING' && direction === 'output') {
        summary.withholdingReceivable = round2(summary.withholdingReceivable + taxAmount);
        buckets.withholding = round2(buckets.withholding + taxAmount);
      }

      if (postingAccountId) {
        summary.byPostingAccount.set(
          postingAccountId,
          round2((summary.byPostingAccount.get(postingAccountId) || 0) + taxAmount)
        );
      }
    }
    summary.byLineId.set(line.id, buckets);
  }

  return summary;
}

module.exports = {
  round2,
  summarizeLineTaxDetails
};
