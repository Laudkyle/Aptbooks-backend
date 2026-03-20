# Phase 4 — Automation & Smart Accounting

Implemented on top of the user's latest backend repo without removing existing files.

## Added
- `src/modules/automation/automation.routes.js`
- `src/modules/automation/recurring-transactions/*`
- `src/modules/automation/accounting-jobs/*`
- `src/modules/automation/auto-reconciliation/*`
- `src/modules/automation/document-matching/*`
- `src/modules/automation/ai-classification/*`
- `src/modules/automation/smart-notifications/*`
- `src/utilities/scheduled-tasks/automation.jobs.js`
- `src/db/migrations/sql/110_phase4_automation_smart_accounting.sql`

## Integrated with existing platform pieces
- Existing `scheduled_tasks` / `scheduled_task_runs`
- Existing journal posting interface
- Existing banking matching logic
- Existing notifications service

## Notes
- Auto reconciliation stores suggestions; it does not auto-apply matches.
- AI classification is deterministic and rule-based for auditability.
- Document matching currently supports:
  - invoices ↔ customer receipts
  - bills ↔ vendor payments
- Smart notifications currently supports:
  - scheduler failures
  - recurring transactions due
  - low bank balance
