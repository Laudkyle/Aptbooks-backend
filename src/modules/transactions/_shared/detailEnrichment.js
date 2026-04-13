const { summarizeLineTaxDetails } = require('../../../shared/tax/posting');

function round2(n) {
  return Number(Number(n || 0).toFixed(2));
}

function firstDefined(obj, keys, fallback = null) {
  for (const key of keys) {
    if (obj?.[key] != null) return obj[key];
  }
  return fallback;
}

function buildTimeline(source = {}) {
  const events = [
    ['created', source.created_at || source.createdAt],
    ['submitted', source.submitted_at || source.submittedAt],
    ['approved', source.approved_at || source.approvedAt],
    ['issued', source.issued_at || source.issuedAt],
    ['posted', source.posted_at || source.postedAt],
    ['voided', source.voided_at || source.voidedAt],
    ['payment', source.payment_date || source.paymentDate],
    ['receipt', source.receipt_date || source.receiptDate],
    ['document', source.document_date || source.documentDate],
    ['due', source.due_date || source.dueDate],
  ].filter(([, at]) => !!at).map(([type, at]) => ({ type, at }));

  return {
    createdAt: source.created_at || source.createdAt || null,
    submittedAt: source.submitted_at || source.submittedAt || null,
    approvedAt: source.approved_at || source.approvedAt || null,
    issuedAt: source.issued_at || source.issuedAt || null,
    postedAt: source.posted_at || source.postedAt || null,
    voidedAt: source.voided_at || source.voidedAt || null,
    dueAt: source.due_date || source.dueDate || null,
    events,
  };
}

async function loadReferenceMaps({ client, lines = [] }) {
  const accountIds = [...new Set(lines.flatMap((line) => [
    line.revenue_account_id,
    line.expense_account_id,
    line.account_id,
    line.inventory_account_id,
    line.cash_account_id,
  ].filter(Boolean)))];
  const taxCodeIds = [...new Set(lines.flatMap((line) => {
    const ids = [];
    if (line.tax_code_id) ids.push(line.tax_code_id);
    const taxes = Array.isArray(line.taxes) ? line.taxes : [];
    for (const t of taxes) {
      if (t.tax_code_id) ids.push(t.tax_code_id);
      if (t.source_tax_code_id) ids.push(t.source_tax_code_id);
    }
    return ids;
  }))];

  const accountMap = new Map();
  const taxCodeMap = new Map();

  if (accountIds.length) {
    const { rows } = await client.query(
      `SELECT id, code, name, type, subtype FROM chart_of_accounts WHERE id = ANY($1::uuid[])`,
      [accountIds]
    );
    rows.forEach((row) => accountMap.set(row.id, row));
  }

  if (taxCodeIds.length) {
    const { rows } = await client.query(
      `SELECT id, code, name, tax_type, rate, direction, application_scope FROM tax_codes WHERE id = ANY($1::uuid[])`,
      [taxCodeIds]
    );
    rows.forEach((row) => taxCodeMap.set(row.id, row));
  }

  return { accountMap, taxCodeMap };
}

async function enrichLines({ client, lines = [] }) {
  const { accountMap, taxCodeMap } = await loadReferenceMaps({ client, lines });
  const taxSummary = summarizeLineTaxDetails(lines.map((line) => ({ ...line, taxDetails: line.taxes || line.taxes || [] })));

  return lines.map((line) => {
    const accountId = firstDefined(line, ['revenue_account_id', 'expense_account_id', 'account_id', 'inventory_account_id', 'cash_account_id']);
    const account = accountId ? accountMap.get(accountId) || null : null;
    const headerTaxCodeId = line.tax_code_id || null;
    const taxCode = headerTaxCodeId ? taxCodeMap.get(headerTaxCodeId) || null : null;
    const lineBuckets = taxSummary.byLineId.get(line.id) || { total: 0, recoverable: 0, nonRecoverable: 0, withholding: 0, reverseCharge: 0 };
    const taxes = Array.isArray(line.taxes) ? line.taxes : [];

    return {
      ...line,
      account,
      account_code: account?.code || null,
      account_name: account?.name || null,
      tax_code: taxCode,
      tax_code_code: taxCode?.code || null,
      tax_code_name: taxCode?.name || null,
      tax_breakdown: {
        total_tax: round2(lineBuckets.total || 0),
        recoverable_tax: round2(lineBuckets.recoverable || 0),
        non_recoverable_tax: round2(lineBuckets.nonRecoverable || 0),
        withholding_tax: round2(lineBuckets.withholding || 0),
        reverse_charge_tax: round2(lineBuckets.reverseCharge || 0),
        components: taxes.map((t) => ({
          ...t,
          tax_code_meta: taxCodeMap.get(t.tax_code_id) || taxCodeMap.get(t.source_tax_code_id) || null,
        })),
      },
      display_amounts: {
        quantity: Number(line.quantity || 0),
        unit_price: round2(line.unit_price || 0),
        taxable_amount: round2(line.taxable_amount ?? line.line_total ?? 0),
        line_subtotal: round2(line.line_total || 0),
        line_tax_total: round2(lineBuckets.total || line.tax_amount || 0),
        line_gross_total: round2(Number(line.line_total || 0) + Number(lineBuckets.total || line.tax_amount || 0)),
      }
    };
  });
}

function buildDetailMeta({ header = {}, lines = [], extra = {} }) {
  const taxSummary = summarizeLineTaxDetails(lines.map((line) => ({ ...line, taxDetails: line.taxes || [] })));
  const subtotal = round2(firstDefined(header, ['subtotal', 'amount_subtotal'], 0));
  const taxTotal = round2(firstDefined(header, ['tax_total', 'taxTotal'], taxSummary.totalTax || 0));
  const total = round2(firstDefined(header, ['total', 'amount_total', 'grand_total'], subtotal + taxTotal));
  const paid = round2(firstDefined(extra, ['paid', 'applied', 'applied_amount'], 0));
  const outstanding = extra.outstanding != null ? round2(extra.outstanding) : round2(Math.max(0, total - paid));
  const unappliedAmount = round2(firstDefined(extra, ['unapplied_amount', 'unappliedAmount'], firstDefined(header, ['unapplied_amount'], 0)));
  const taxedLineCount = lines.filter((line) => Number(line.tax_breakdown?.total_tax || 0) > 0 || Number(line.tax_amount || 0) > 0).length;

  return {
    workflow: {
      status: header.status || null,
      workflow_status: header.workflow_status || null,
      can_approve: !!header.can_approve,
      can_post: !!header.can_post,
      journal_entry_id: header.journal_entry_id || null,
      workflow_document_id: header.workflow_document_id || null,
      period_id: header.period_id || null,
    },
    commercial: {
      document_number: firstDefined(header, ['invoice_no', 'bill_no', 'credit_note_no', 'debit_note_no', 'payment_no', 'receipt_no', 'document_no']),
      document_date: firstDefined(header, ['invoice_date', 'bill_date', 'issue_date', 'payment_date', 'receipt_date', 'document_date']),
      due_date: firstDefined(header, ['due_date']),
      currency_code: header.currency_code || null,
      memo: header.memo || null,
    },
    totals: {
      subtotal,
      tax_total: taxTotal,
      total,
      paid,
      outstanding,
      unapplied_amount: unappliedAmount,
      discount_total: round2(firstDefined(header, ['discount_total', 'discount_amount'], 0)),
      settlement_total: round2(firstDefined(header, ['net_settlement_total', 'settlement_total', 'settlement_amount'], total)),
      withholding_total: round2(firstDefined(header, ['withholding_total'], taxSummary.withholdingReceivable || taxSummary.withholdingPayable || 0)),
    },
    tax: {
      total_tax: round2(taxSummary.totalTax),
      output_tax: round2(taxSummary.outputTax),
      recoverable_input_tax: round2(taxSummary.recoverableInputTax),
      non_recoverable_input_tax: round2(taxSummary.nonRecoverableInputTax),
      reverse_charge_tax: round2(taxSummary.reverseChargeTax),
      withholding_receivable: round2(taxSummary.withholdingReceivable),
      withholding_payable: round2(taxSummary.withholdingPayable),
    },
    stats: {
      line_count: lines.length,
      taxed_line_count: taxedLineCount,
      untaxed_line_count: lines.length - taxedLineCount,
    },
    timeline: buildTimeline(header),
  };
}

module.exports = {
  round2,
  enrichLines,
  buildDetailMeta,
  buildTimeline,
};
