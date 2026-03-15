const BaseDocumentableAdapter = require("./baseDocumentable.adapter");

class InvoiceDocumentableAdapter extends BaseDocumentableAdapter {
  constructor() {
    super({
      entityType: "invoice",
      documentTypeCode: "INVOICE",
      documentTypeName: "Invoice",
      noun: "invoice",
      blockedActionLabel: "issue"
    });
    this._title = (entity) => `Invoice ${entity.invoice_no}`;
    this._description = (entity) => entity.memo || null;
    this._versionFilename = (entity) => `invoice-${entity.invoice_no}.json`;
  }
}

module.exports = new InvoiceDocumentableAdapter();
