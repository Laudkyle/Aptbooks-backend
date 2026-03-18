# Phase 2 Inventory & Operational Flow Integration

Implemented on top of the existing inventory backbone without duplicating the already-present stock transaction engine.

## Added modules
- `src/modules/inventory/bins`
  - warehouse bin/location operations
- `src/modules/inventory/reservations`
  - reserve, release, fulfill, and availability checks
- `src/modules/inventory/transfers`
  - transfer request workflow that posts through the existing inventory transaction service
- `src/modules/inventory/traceability`
  - batch receipt/issue and serial receipt/issue endpoints linked to posted inventory transaction lines
- `src/modules/inventory/reorder`
  - reorder settings, reorder suggestions, and purchase requisition generation from suggestions

## Reused existing work
- existing `inventory_transactions` posting flow
- existing inventory balances and valuation logic
- existing `inventory_reorder_settings`
- existing purchase requisition operational-document service
- existing warehouse master data

## Schema additions
Migration added:
- `warehouse_bins`
- `inventory_reservations`
- `inventory_transfer_requests`
- `inventory_transfer_request_lines`
- `inventory_batches`
- `inventory_serial_numbers`
- `inventory_traceability_links`

## Key behavior
- transfer requests do not duplicate stock movement logic; posting auto-creates and posts a standard `inventory_transactions` transfer
- reservations reduce *available* stock, not on-hand stock
- reorder suggestions are computed from on-hand minus active reservations against existing reorder settings
- purchase requisitions can be auto-generated from reorder suggestions
- batch and serial traceability is attached to transaction lines after operational stock transactions are posted
