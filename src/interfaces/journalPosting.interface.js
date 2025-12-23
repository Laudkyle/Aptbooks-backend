/**
 * Journal Posting API (Tier 1)
 * Used by Tier >= 2 modules. Does not expose repositories.
 */
const journalSvc = require("../core/accounting/journal/journal.service");

async function createDraftJournal({ orgId, actorUserId, payload }) {
  return journalSvc.createDraftJournal({ orgId, actorUserId, payload });
}

async function postDraftJournal({ orgId, journalId, actorUserId }) {
  return journalSvc.postDraftJournal({ orgId, journalId, actorUserId });
}

async function voidPostedJournal({ orgId, journalId, actorUserId, reason }) {
  return journalSvc.voidByReversal({ orgId, journalId, actorUserId, reason });
}

module.exports = {
  createDraftJournal,
  postDraftJournal,
  voidPostedJournal
};
