const registry = {
  invoice: {
    entityType: "invoice",
    documentTypeCode: "INVOICE",
    documentTypeName: "Invoice",
    noun: "invoice",
    blockedActionLabel: "issue",
    title: (entity) => `Invoice ${entity.invoice_no}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `invoice-${entity.invoice_no}.json`
  },
  bill: {
    entityType: "bill",
    documentTypeCode: "BILL",
    documentTypeName: "Bill",
    noun: "bill",
    blockedActionLabel: "issue",
    title: (entity) => `Bill ${entity.bill_no}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `bill-${entity.bill_no}.json`
  }
  ,journal_entry: {
    entityType: "journal_entry",
    documentTypeCode: "JOURNAL_ENTRY",
    documentTypeName: "Journal Entry",
    noun: "journal entry",
    blockedActionLabel: "post",
    title: (entity) => `Journal ${entity.entry_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `journal-${entity.entry_no || entity.id}.json`
  },
  credit_note: {
    entityType: "credit_note",
    documentTypeCode: "CREDIT_NOTE",
    documentTypeName: "Credit Note",
    noun: "credit note",
    blockedActionLabel: "issue",
    title: (entity) => `Credit Note ${entity.credit_note_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `credit-note-${entity.credit_note_no || entity.id}.json`
  },
  debit_note: {
    entityType: "debit_note",
    documentTypeCode: "DEBIT_NOTE",
    documentTypeName: "Debit Note",
    noun: "debit note",
    blockedActionLabel: "issue",
    title: (entity) => `Debit Note ${entity.debit_note_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `debit-note-${entity.debit_note_no || entity.id}.json`
  },
  payment_out: {
    entityType: "payment_out",
    documentTypeCode: "PAYMENT_OUT",
    documentTypeName: "Payment Out",
    noun: "payment out",
    blockedActionLabel: "post",
    title: (entity) => `Payment Out ${entity.payment_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `payment-out-${entity.payment_no || entity.id}.json`
  },
  payment_in: {
    entityType: "payment_in",
    documentTypeCode: "PAYMENT_IN",
    documentTypeName: "Payment In",
    noun: "payment in",
    blockedActionLabel: "post",
    title: (entity) => `Payment In ${entity.receipt_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `payment-in-${entity.receipt_no || entity.id}.json`
  },
  stock_adjustment: {
    entityType: "stock_adjustment",
    documentTypeCode: "STOCK_ADJUSTMENT",
    documentTypeName: "Stock Adjustment",
    noun: "stock adjustment",
    blockedActionLabel: "post",
    title: (entity) => `Stock Adjustment ${entity.reference || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `stock-adjustment-${entity.id}.json`
  },
  stock_transfer: {
    entityType: "stock_transfer",
    documentTypeCode: "STOCK_TRANSFER",
    documentTypeName: "Stock Transfer",
    noun: "stock transfer",
    blockedActionLabel: "post",
    title: (entity) => `Stock Transfer ${entity.reference || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `stock-transfer-${entity.id}.json`
  },
  stock_issue: {
    entityType: "stock_issue",
    documentTypeCode: "STOCK_ISSUE",
    documentTypeName: "Stock Issue",
    noun: "stock issue",
    blockedActionLabel: "post",
    title: (entity) => `Stock Issue ${entity.reference || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `stock-issue-${entity.id}.json`
  },
  stock_receive: {
    entityType: "stock_receive",
    documentTypeCode: "STOCK_RECEIVE",
    documentTypeName: "Stock Receive",
    noun: "stock receipt",
    blockedActionLabel: "post",
    title: (entity) => `Stock Receive ${entity.reference || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `stock-receive-${entity.id}.json`
  },
  stock_count: {
    entityType: "stock_count",
    documentTypeCode: "STOCK_COUNT",
    documentTypeName: "Stock Count",
    noun: "stock count",
    blockedActionLabel: "post",
    title: (entity) => `Stock Count ${entity.reference || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `stock-count-${entity.id}.json`
  },
  leave_request: {
    entityType: "leave_request",
    documentTypeCode: "LEAVE_REQUEST",
    documentTypeName: "Leave Request",
    noun: "leave request",
    blockedActionLabel: "approve",
    title: (entity) => `Leave Request ${entity.employee_no || entity.id}`,
    description: (entity) => entity.reason || null,
    versionFilename: (entity) => `leave-request-${entity.id}.json`
  },
  payslip: {
    entityType: "payslip",
    documentTypeCode: "PAYSLIP",
    documentTypeName: "Payslip",
    noun: "payslip",
    blockedActionLabel: "post",
    title: (entity) => `Payroll Run ${entity.id}`,
    description: (entity) => `Payroll run for period ${entity.period_id}`,
    versionFilename: (entity) => `payroll-run-${entity.id}.json`
  },
  budget: {
    entityType: "budget",
    documentTypeCode: "BUDGET",
    documentTypeName: "Budget",
    noun: "budget",
    blockedActionLabel: "publish",
    title: (entity) => `Budget ${entity.budget_name || entity.name || entity.id} v${entity.version_no}`,
    description: (entity) => entity.name || null,
    versionFilename: (entity) => `budget-version-${entity.id}.json`
  },
  forecast: {
    entityType: "forecast",
    documentTypeCode: "FORECAST",
    documentTypeName: "Forecast",
    noun: "forecast",
    blockedActionLabel: "publish",
    title: (entity) => `Forecast ${entity.forecast_name || entity.name || entity.id} v${entity.version_no}`,
    description: (entity) => entity.name || null,
    versionFilename: (entity) => `forecast-version-${entity.id}.json`
  },
  project: {
    entityType: "project",
    documentTypeCode: "PROJECT",
    documentTypeName: "Project",
    noun: "project",
    blockedActionLabel: "activate",
    title: (entity) => `Project ${entity.code || entity.name || entity.id}`,
    description: (entity) => entity.description || null,
    versionFilename: (entity) => `project-${entity.id}.json`
  },

  lease: {
    entityType: "lease",
    documentTypeCode: "LEASE",
    documentTypeName: "Lease",
    noun: "lease",
    blockedActionLabel: "post",
    title: (entity) => `Lease ${entity.code || entity.name || entity.id}`,
    description: (entity) => entity.name || null,
    versionFilename: (entity) => `lease-${entity.code || entity.id}.json`
  },
  lease_modification: {
    entityType: "lease_modification",
    documentTypeCode: "LEASE_MODIFICATION",
    documentTypeName: "Lease Modification",
    noun: "lease modification",
    blockedActionLabel: "apply",
    title: (entity) => `Lease Modification ${entity.id}`,
    description: (entity) => entity.reason || null,
    versionFilename: (entity) => `lease-modification-${entity.id}.json`
  },

  contract: {
    entityType: "contract",
    documentTypeCode: "CONTRACT",
    documentTypeName: "Contract",
    noun: "contract",
    blockedActionLabel: "activate",
    title: (entity) => `Contract ${entity.code || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `contract-${entity.id}.json`
  },
  tax_invoice: {
    entityType: "tax_invoice",
    documentTypeCode: "TAX_INVOICE",
    documentTypeName: "Tax Invoice",
    noun: "tax invoice",
    blockedActionLabel: "issue",
    title: (entity) => `Tax Invoice ${entity.invoice_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `tax-invoice-${entity.invoice_no || entity.id}.json`
  },
  tax_credit: {
    entityType: "tax_credit",
    documentTypeCode: "TAX_CREDIT",
    documentTypeName: "Tax Credit",
    noun: "tax credit",
    blockedActionLabel: "issue",
    title: (entity) => `Tax Credit ${entity.credit_note_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `tax-credit-${entity.credit_note_no || entity.id}.json`
  },
  tax_return: {
    entityType: "tax_return",
    documentTypeCode: "TAX_RETURN",
    documentTypeName: "Tax Return",
    noun: "tax return",
    blockedActionLabel: "finalize",
    title: (entity) => `Tax Return ${entity.tax_type || 'TAX'} ${entity.from_date || entity.from || ''} to ${entity.to_date || entity.to || ''}`.trim(),
    description: (entity) => entity.template_name || entity.template_code || null,
    versionFilename: (entity) => `tax-return-${entity.tax_type || 'tax'}-${entity.from_date || entity.from || entity.id}-${entity.to_date || entity.to || ''}.json`.replace(/\s+/g, '-')
  },
  expense: {
    entityType: "expense",
    documentTypeCode: "EXPENSE",
    documentTypeName: "Expense",
    noun: "expense",
    blockedActionLabel: "post",
    title: (entity) => `Expense ${entity.document_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `expense-${entity.document_no || entity.id}.json`
  },
  quotation: {
    entityType: "quotation",
    documentTypeCode: "QUOTATION",
    documentTypeName: "Quotation",
    noun: "quotation",
    blockedActionLabel: "issue",
    title: (entity) => `Quotation ${entity.document_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `quotation-${entity.document_no || entity.id}.json`
  },
  sales_order: {
    entityType: "sales_order",
    documentTypeCode: "SALES_ORDER",
    documentTypeName: "Sales Order",
    noun: "sales order",
    blockedActionLabel: "issue",
    title: (entity) => `Sales Order ${entity.document_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `sales-order-${entity.document_no || entity.id}.json`
  },
  purchase_requisition: {
    entityType: "purchase_requisition",
    documentTypeCode: "PURCHASE_REQUISITION",
    documentTypeName: "Purchase Requisition",
    noun: "purchase requisition",
    blockedActionLabel: "issue",
    title: (entity) => `Purchase Requisition ${entity.document_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `purchase-requisition-${entity.document_no || entity.id}.json`
  },
  purchase_order: {
    entityType: "purchase_order",
    documentTypeCode: "PURCHASE_ORDER",
    documentTypeName: "Purchase Order",
    noun: "purchase order",
    blockedActionLabel: "issue",
    title: (entity) => `Purchase Order ${entity.document_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `purchase-order-${entity.document_no || entity.id}.json`
  },
  goods_receipt: {
    entityType: "goods_receipt",
    documentTypeCode: "GOODS_RECEIPT",
    documentTypeName: "Goods Receipt",
    noun: "goods receipt",
    blockedActionLabel: "post",
    title: (entity) => `Goods Receipt ${entity.document_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `goods-receipt-${entity.document_no || entity.id}.json`
  },
  petty_cash: {
    entityType: "petty_cash",
    documentTypeCode: "PETTY_CASH",
    documentTypeName: "Petty Cash",
    noun: "petty cash",
    blockedActionLabel: "post",
    title: (entity) => `Petty Cash ${entity.document_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `petty-cash-${entity.document_no || entity.id}.json`
  },
  advance: {
    entityType: "advance",
    documentTypeCode: "ADVANCE",
    documentTypeName: "Advance",
    noun: "advance",
    blockedActionLabel: "post",
    title: (entity) => `Advance ${entity.document_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `advance-${entity.document_no || entity.id}.json`
  },
  return: {
    entityType: "return",
    documentTypeCode: "RETURN",
    documentTypeName: "Return",
    noun: "return",
    blockedActionLabel: "post",
    title: (entity) => `Return ${entity.document_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `return-${entity.document_no || entity.id}.json`
  },
  refund: {
    entityType: "refund",
    documentTypeCode: "REFUND",
    documentTypeName: "Refund",
    noun: "refund",
    blockedActionLabel: "post",
    title: (entity) => `Refund ${entity.document_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `refund-${entity.document_no || entity.id}.json`
  },
  receipt: {
    entityType: "receipt",
    documentTypeCode: "RECEIPT",
    documentTypeName: "Receipt",
    noun: "receipt",
    blockedActionLabel: "post",
    title: (entity) => `Receipt ${entity.receipt_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `receipt-${entity.receipt_no || entity.id}.json`
  },
  withholding_remittance: {
    entityType: "withholding_remittance",
    documentTypeCode: "WITHHOLDING_REMITTANCE",
    documentTypeName: "Withholding Remittance",
    noun: "withholding remittance",
    blockedActionLabel: "post",
    title: (entity) => `Withholding Remittance ${entity.remittance_no || entity.id}` ,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `withholding-remittance-${entity.remittance_no || entity.id}.json`
  },
  withholding_certificate: {
    entityType: "withholding_certificate",
    documentTypeCode: "WITHHOLDING_CERTIFICATE",
    documentTypeName: "Withholding Certificate",
    noun: "withholding certificate",
    blockedActionLabel: "post",
    title: (entity) => `Withholding Certificate ${entity.certificate_no || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `withholding-certificate-${entity.certificate_no || entity.id}.json`
  },
  ifrs9_model_change: {
    entityType: "ifrs9_model_change",
    documentTypeCode: "IFRS9_MODEL_CHANGE",
    documentTypeName: "IFRS9 Model Change",
    noun: "IFRS9 model change",
    blockedActionLabel: "apply",
    title: (entity) => `IFRS9 Model Change ${entity.code || entity.id}`,
    description: (entity) => entity.memo || null,
    versionFilename: (entity) => `ifrs9-model-change-${entity.id}.json`
  }
};

function getDocumentable(entityType) {
  return registry[String(entityType || "").toLowerCase()] || null;
}

function registerDocumentable(entityType, config) {
  registry[String(entityType || "").toLowerCase()] = {
    ...(config || {}),
    entityType: String(entityType || "").toLowerCase()
  };
}

function listDocumentables() {
  return Object.keys(registry).sort();
}

module.exports = {
  getDocumentable,
  registerDocumentable,
  listDocumentables
};
