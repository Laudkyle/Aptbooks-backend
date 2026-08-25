# Assets & Inventory Production Hardening

## Purpose

This release turns Fixed Assets and Inventory from operational scaffolding into controlled accounting subledgers. It preserves the Phase 1–4 security, financial-assurance, maintainability, observability, and Tax workspace controls while adding stronger lifecycle accounting, depreciation evidence, stock integrity, and coherent workspace APIs.

## Fixed Assets

### Atomic lifecycle accounting

Acquisition, depreciation, revaluation, impairment, and disposal are treated as financial mutations. The asset register update, event/audit evidence, and journal posting are committed in the same PostgreSQL transaction through the canonical posting engine. A failure rolls back the whole operation rather than allowing the GL and asset register to diverge.

### Depreciation model

Each depreciation schedule owns an explicit accounting basis rather than implicitly depreciating the entire asset:

- depreciable basis
- residual value
- useful life
- method (`straight_line` or `reducing_balance`)
- convention (`full_month` or `daily_prorata`)
- reducing-balance rate where applicable
- component identity
- effective dates

Component schedules may coexist, but the same component cannot have overlapping active schedules and aggregate schedule basis cannot exceed the asset gross book basis. Posted schedules are protected from accounting-policy mutation.

Each depreciation posting stores calculation evidence, including the schedule method, basis, residual value, convention, applicable rate, and calculation snapshot. Period runs are serialized and retry-safe.

### Decimal safety

Asset carrying-value aggregation is calculated in PostgreSQL `NUMERIC` arithmetic. Presentation code does not recompute financial book values using JavaScript floating-point arithmetic.

### Migration 164 legacy schedule guard

`164_assets_inventory_production_hardening.sql` intentionally stops if an existing asset has multiple active legacy depreciation schedules without explicit basis allocation. Automatically assigning the entire asset cost to every legacy schedule could over-depreciate the asset.

If the migration raises the legacy multi-schedule guard, review those assets and allocate explicit component/schedule bases before retrying the migration. Do not remove the guard merely to make the migration pass.

## Inventory

### Master-data controls

New operational transactions require active inventory masters. Items explicitly support tracking modes of `none`, `batch`, or `serial`, and may define a preferred warehouse, reorder point, reorder quantity, tax profile, and barcode/GTIN.

Items and warehouses cannot be deactivated while doing so would strand active stock/reservations. Inventory balance/cost constraints protect new writes while allowing legacy anomalies to be identified and remediated deliberately.

### Transaction and stock-count atomicity

Approved inventory postings use the canonical journal posting path and record posting identity/time.

Stock-count posting is now one database transaction:

1. lock the approved stock count;
2. lock relevant inventory balances;
3. generate the inventory adjustment;
4. submit/approve the generated workflow evidence;
5. post stock and valuation effects;
6. post the GL journal;
7. mark the stock count posted.

A retry locks the same stock-count row and returns the existing posted result rather than generating a second adjustment. Any failure rolls the entire operation back.

### Inventory control-centre data

The inventory overview/integrity service surfaces operational and accounting exceptions, including:

- negative stock;
- negative inventory valuation;
- broken item/master-data relationships;
- stock in inactive warehouses;
- approved but unposted transactions;
- posted transactions without journal provenance;
- reorder exposure;
- warehouse valuation/control totals.

## API and repository boundaries

New SQL introduced by this release follows the Phase 3 repository/query standard. Services own orchestration and financial transaction boundaries; repositories own persistence. Tenant isolation and RLS context from Phase 1 remain authoritative.

## Production deployment notes

Before applying this release in production:

1. back up the database and verify restore capability;
2. rehearse migration 164 in staging using a recent production-shaped copy;
3. resolve any legacy multi-schedule depreciation basis guard deliberately;
4. run the complete package build and dependency audit from the full repository;
5. execute DB-backed integration/concurrency tests against staging PostgreSQL;
6. run the Phase 1–4 gates plus Assets/Inventory regression tests;
7. run financial-integrity checks before and after migration;
8. compare asset register, accumulated depreciation, inventory valuation, and their GL control balances before release approval.

## Accounting invariants

The release is designed around these invariants:

- posted financial lifecycle events are atomic with their GL journals;
- a depreciation schedule cannot charge below its residual-value floor;
- component schedule basis cannot silently exceed the asset basis;
- retrying a posted stock count cannot duplicate the inventory adjustment;
- financial carrying values are calculated using fixed-precision database arithmetic;
- posted stock/asset accounting remains traceable to its source and posting evidence.
