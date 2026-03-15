class BaseDocumentableAdapter {
  constructor(config) {
    this.entityType = config.entityType;
    this.documentTypeCode = config.documentTypeCode;
    this.documentTypeName = config.documentTypeName;
    this.noun = config.noun || config.entityType;
    this.blockedActionLabel = config.blockedActionLabel || "post";
  }

  buildTitle(entity) {
    if (typeof this._title === "function") return this._title(entity);
    return `${this.documentTypeName} ${entity.id}`;
  }

  buildDescription(entity) {
    if (typeof this._description === "function") return this._description(entity);
    return null;
  }

  buildVersionFilename(entity) {
    if (typeof this._versionFilename === "function") return this._versionFilename(entity);
    return `${this.entityType}-${entity.id}.json`;
  }
}

module.exports = BaseDocumentableAdapter;
