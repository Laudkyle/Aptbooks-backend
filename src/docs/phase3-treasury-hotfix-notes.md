Phase 3 treasury hotfixes

Included in this patch:
- payment run line insertion now appends after the current maximum line number instead of restarting at 1 on every add-lines call
- payment run line numbering is serialized with a parent-row lock to reduce duplicate line number collisions during concurrent edits
- treasury services now accept common snake_case and camelCase request aliases for phase 3 payloads
- cheque issue now persists issue_date and amount when issuing
- cheque issue now validates that issueDate exists and that amount is available before issuing
- cheque clear accepts both clearedDate and cleared_date
