# Phase 1 Posting Hook Notes

Implemented automatic posting hooks for the Phase 1 operational transaction modules that are accounting-impacting:

- expenses
- petty cash
- advances
- refunds
- returns
- goods receipts

## Behaviour

- Approval still commits through the existing workflow/document interfaces first.
- Immediately after approval, a posting hook runs for the modules above.
- The hook calls the module's existing `finalize()` method, which now:
  - resolves the open accounting period,
  - builds the journal payload,
  - uses the existing Tier 1 journal posting interface,
  - stores the resulting `period_id` and `journal_entry_id` on `operational_documents`.
- If posting fails, the document remains approved and the failure is returned in `posting.error`.

## Added files

- `src/modules/transactions/_shared/approvalPostingHooks.js`
- `src/modules/transactions/_shared/operationalDocPosting.service.js`
- `src/db/migrations/sql/106_phase1_operational_posting_links.sql`

## Important notes

- Posted Phase 1 operational documents are now linked to journals and cannot be directly voided; the journal should be reversed first.
- `goods_receipt` posting now expects `primaryAccountId` to be supplied as the clearing/accrual account.
- Posting line validation was tightened for the modules that now auto-post.
