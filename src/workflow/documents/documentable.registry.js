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
