# Banking & Treasury Production Hardening

This release turns Banking and Treasury into controlled financial domains rather than collections of CRUD routes.

## Banking controls
- Bank accounts carry institution/branch/type, masked account identity, minimum balance, overdraft limit, and reconciliation tolerance.
- Statement imports retain source/checksum identity and can be validated and locked.
- Manual statement matching requires a posted journal affecting the selected bank GL account in the bank currency and within tolerance.
- Reconciliation close requires a validated statement, zero unmatched lines, zero wrong-currency GL lines, and a bank-vs-GL difference within tolerance.
- Closed reconciliations cannot be reopened while their accounting period is closed.
- Reconciliation close evidence snapshots statement balance, GL balance, difference, unmatched count, and tolerance.

## Treasury controls
- Organization-level maker/checker and execution-separation controls are enforced in services.
- Payment runs and transfers use explicit submit/approve/execute-or-post lifecycles and canonical journal posting.
- Instructions in approval batches cannot bypass the batch; cancelled batches release their child instructions.
- Direct cross-currency bank transfers are blocked until an explicit FX conversion/gain-loss workflow is used.
- Treasury liquidity and forecasts are grouped by currency; nominal balances from different currencies are never summed.

## Cheques
- New cheque leaves begin as available; they cannot be created directly as issued.
- A cheque must either be linked to a controlled payment run or post its accounting entry on issue.
- One active physical cheque may reference a payment run. Voided/bounced historical instruments do not block a replacement.
- A payment-run cheque clears only after the payment run is executed/posted.
- Bounce/void reverses the relevant posted journal atomically and preserves reversal provenance.

## Tenant and precision rules
- Tenant ownership of bank statement lines is inherited through `bank_statements`; queries must never assume `bank_statement_lines.organization_id` exists.
- Monetary comparisons use exact financial helpers or PostgreSQL NUMERIC, not binary floating point.
- All new Treasury control tables are protected by RLS.

## Migration
Apply `165_banking_treasury_production_hardening.sql` in staging first. The migration blocks if more than one active cheque references the same payment run. Resolve those data conflicts rather than removing the guard.
