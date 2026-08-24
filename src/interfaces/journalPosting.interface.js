/**
 * Canonical accounting posting contract.
 *
 * Tier >= 2 modules must depend on this interface rather than importing the
 * journal service or writing ledger projection rows directly. Phase 2 routes
 * every posting command through postingEngine.service so policy resolution,
 * financial idempotency, provenance, and posting invariants are applied once.
 */
const postingEngine = require('../core/accounting/posting/postingEngine.service');
const journalSvc = require('../core/accounting/journal/journal.service');

async function createDraftJournal(args) { return postingEngine.createDraftJournal(args); }
async function postDraftJournal(args) { return postingEngine.postDraftJournal(args); }
async function postJournal(args) { return postingEngine.postJournal(args); }
async function postSourceJournal(args) { return postingEngine.postSourceJournal(args); }
async function voidPostedJournal(args) { return postingEngine.voidPostedJournal(args); }
async function reversePostedJournal(args) { return postingEngine.reversePostedJournal(args); }

// Draft workflow/editing remains owned by the Tier 1 journal aggregate. These
// methods cannot mutate posted journal history.
async function getJournalWithLines(args) { return journalSvc.getJournalWithLines(args); }
async function updateDraftHeader(args) { return journalSvc.updateDraftHeader(args); }
async function replaceDraftLines(args) { return journalSvc.replaceDraftLines(args); }
async function submitDraftJournal(args) { return journalSvc.submitDraftJournal(args); }
async function approveSubmittedJournal(args) { return journalSvc.approveSubmittedJournal(args); }
async function rejectSubmittedJournal(args) { return journalSvc.rejectSubmittedJournal(args); }
async function cancelDraftJournal(args) { return journalSvc.cancelDraftJournal(args); }
async function batchPostJournals(args) { return postingEngine.batchPostJournals(args); }
async function listJournals(args) { return journalSvc.listJournals(args); }

module.exports = {
  createDraftJournal,
  postDraftJournal,
  postJournal,
  postSourceJournal,
  voidPostedJournal,
  reversePostedJournal,
  listJournals,
  getJournalWithLines,
  updateDraftHeader,
  replaceDraftLines,
  submitDraftJournal,
  approveSubmittedJournal,
  rejectSubmittedJournal,
  cancelDraftJournal,
  batchPostJournals,
};
