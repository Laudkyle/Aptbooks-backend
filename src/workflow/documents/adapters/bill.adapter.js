const BaseDocumentableAdapter = require("./baseDocumentable.adapter");

class BillDocumentableAdapter extends BaseDocumentableAdapter {
  constructor() {
    super({
      entityType: "bill",
      documentTypeCode: "BILL",
      documentTypeName: "Bill",
      noun: "bill",
      blockedActionLabel: "issue"
    });
    this._title = (entity) => `Bill ${entity.bill_no}`;
    this._description = (entity) => entity.memo || null;
    this._versionFilename = (entity) => `bill-${entity.bill_no}.json`;
  }
}

module.exports = new BillDocumentableAdapter();
