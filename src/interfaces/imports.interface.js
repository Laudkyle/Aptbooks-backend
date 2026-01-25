const svc = require("../core/accounting/imports/imports.service");

async function importCoaCsv({ orgId, actorUserId, csvText, options }) {
  return svc.importCoaCsv({ orgId, actorUserId, csvText, options });
}

async function importJournalsCsv({ orgId, actorUserId, csvText, options }) {
  return svc.importJournalsCsv({ orgId, actorUserId, csvText, options });
}

module.exports = { importCoaCsv, importJournalsCsv };
