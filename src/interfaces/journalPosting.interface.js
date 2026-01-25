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

// Stage 2 lifecycle + editing (still Tier 1 contract)
async function getJournalWithLines({ orgId, journalId }) {
  return journalSvc.getJournalWithLines({ orgId, journalId }); 
}

async function updateDraftHeader({ orgId, journalId, actorUserId, payload }) {
  return journalSvc.updateDraftHeader({ orgId, journalId, actorUserId, payload }); 
}

async function replaceDraftLines({ orgId, journalId, actorUserId, lines }) {
  return journalSvc.replaceDraftLines({ orgId, journalId, actorUserId, lines }); 
}

async function submitDraftJournal({ orgId, journalId, actorUserId }) {
  return journalSvc.submitDraftJournal({ orgId, journalId, actorUserId }); 
}

async function approveSubmittedJournal({ orgId, journalId, actorUserId }) {
  return journalSvc.approveSubmittedJournal({ orgId, journalId, actorUserId }); 
}

async function rejectSubmittedJournal({ orgId, journalId, actorUserId, reason }) {
  return journalSvc.rejectSubmittedJournal({ orgId, journalId, actorUserId, reason }); 
}

async function cancelDraftJournal({ orgId, journalId, actorUserId }) {
  return journalSvc.cancelDraftJournal({ orgId, journalId, actorUserId }); 
}

async function batchPostJournals({ orgId, actorUserId, journalIds, client = null }) {
  return journalSvc.batchPostJournals({ orgId, actorUserId, journalIds, client }); 
}

async function listJournals({ orgId, filters = {}, limit = 100, offset = 0 }) {
  return journalSvc.listJournals({ orgId, filters, limit, offset }); 
}
async function reversePostedJournal({ orgId, journalId, actorUserId, targetPeriodId, entryDate, reason, idempotencyKey, client = null }) {
  return journalSvc.reversePostedJournal({ orgId, journalId, actorUserId, targetPeriodId, entryDate, reason, idempotencyKey, client }); 
}

module.exports = {
  createDraftJournal,
  postDraftJournal,
  postJournal,
  voidPostedJournal,reversePostedJournal
  ,
  listJournals,
  getJournalWithLines,
  updateDraftHeader,
  replaceDraftLines,
  submitDraftJournal,
  approveSubmittedJournal,
  rejectSubmittedJournal,
  cancelDraftJournal,
  batchPostJournals
}; 
