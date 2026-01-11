/**
 * Journal Posting API (Tier 1)
 * Used by Tier >= 2 modules. Does not expose repositories.
 */
const journalSvc = require("../core/accounting/journal/journal.service");

async function createDraftJournal({ orgId, actorUserId, payload, client = null }) {
  return journalSvc.createDraftJournal({ orgId, actorUserId, payload, client });
}

async function postDraftJournal({ orgId, journalId, actorUserId, client = null }) {
  return journalSvc.postDraftJournal({ orgId, journalId, actorUserId, client });
}

/**
 * Convenience wrapper for callers that do not need to persist a draft journal id.
 * Creates a draft journal and immediately posts it.
 */
async function postJournal({ orgId, actorUserId, payload, client = null }) {
  const draft = await journalSvc.createDraftJournal({ orgId, actorUserId, payload, client });
  return journalSvc.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId, client });
}

async function voidPostedJournal({ orgId, journalId, actorUserId, reason, client = null }) {
  return journalSvc.voidByReversal({ orgId, journalId, actorUserId, reason, client });
}
async function reversePostedJournal({ orgId, journalId, actorUserId, targetPeriodId, entryDate, reason, idempotencyKey, client = null }) {
  return journalSvc.reversePostedJournal({ orgId, journalId, actorUserId, targetPeriodId, entryDate, reason, idempotencyKey, client });
}

module.exports = {
  createDraftJournal,
  postDraftJournal,
  postJournal,
  voidPostedJournal,reversePostedJournal
};
