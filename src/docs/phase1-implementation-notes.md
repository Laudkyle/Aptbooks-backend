# Phase 1 Implementation Notes

Implemented in this repo:

- `quotations`
- `sales-orders`
- `purchase-requisitions`
- `purchase-orders`
- `goods-receipts`
- `expenses`
- `petty-cash`
- `advances`
- `returns`
- `refunds`

## What was added

- Route mounts in `src/modules/transactions/transactions.routes.js`
- Shared operational document engine under `src/modules/transactions/_shared`
- Validation schemas in `src/shared/validators/phase1.transactions.validators.js`
- Workflow document registry entries for all Phase 1 entities
- Default permissions in:
  - `src/db/seeds/seed.js`
  - `src/core/foundation/organizations/organizations.service.js`
- Database migration:
  - `src/db/migrations/sql/105_phase1_operational_transactions.sql`

## Current behavior

These Phase 1 modules support:

- create draft
- list
- get details
- submit for approval
- approve
- reject
- issue/post
- void

## Important note

This implementation establishes the operational document layer and approval/status flow in a way that matches the existing repo structure. It does **not** yet post full accounting journals for every new Phase 1 module. Existing accounting-integrated modules such as invoices, bills, receipts, and vendor payments remain unchanged.
