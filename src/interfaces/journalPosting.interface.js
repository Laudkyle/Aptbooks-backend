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

/**
 * Convenience wrapper for callers that do not need to persist a draft journal id.
 * Creates a draft journal and immediately posts it.
 */
async function postJournal({ orgId, actorUserId, payload }) {
  const draft = await journalSvc.createDraftJournal({ orgId, actorUserId, payload });
  return journalSvc.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId });
}

async function voidPostedJournal({ orgId, journalId, actorUserId, reason }) {
  return journalSvc.voidByReversal({ orgId, journalId, actorUserId, reason });
}
async function reversePostedJournal({ orgId, journalId, actorUserId, targetPeriodId, entryDate, reason, idempotencyKey }) {
  return journalSvc.reversePostedJournal({ orgId, journalId, actorUserId, targetPeriodId, entryDate, reason, idempotencyKey });
}

module.exports = {
  createDraftJournal,
  postDraftJournal,
  postJournal,
  voidPostedJournal,reversePostedJournal
};
