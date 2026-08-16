# GRA-1 — Ghana Tax Kernel

This release establishes the backend tax kernel required for later Ghana VAT, withholding, payroll and GRA integration releases.

## Migration

Run after migration 147:

- `db/migrations/sql/148_gra1_tax_kernel.sql`

Use a staging/test PostgreSQL database first. The migration backfills existing tax detail into the canonical tax subledger and creates POS return tax detail records for already-received returns.

## Rate convention

AptBooks tax rates are percentage points everywhere:

- `15.000000` = 15%
- `2.500000` = 2.5%
- `7.500000` = 7.5%

Tax calculations use fixed-point integer arithmetic and explicit half-up rounding.

## New tax architecture

### Tax catalog profiles

`tax_catalog_profiles` supplies reusable tax classification for inventory/catalog items. Inventory items can reference a profile through `inventory_items.tax_profile_id`.

Initial Ghana defaults installed with the Ghana country pack include:

- `GH_STANDARD_GOODS`
- `GH_STANDARD_SERVICES`
- `GH_EXEMPT_SUPPLY`
- `GH_ZERO_RATED_EXPORT`

API endpoints under the existing tax router:

- `GET /catalog-profiles`
- `GET /catalog-profiles/:id`
- `POST /catalog-profiles`
- `PATCH /catalog-profiles/:id`
- `DELETE /catalog-profiles/:id`

Existing `tax.read` and `tax.manage` permissions are used for compatibility with existing roles.

### Canonical tax subledger

`tax_ledger_entries` is the canonical tax reporting source. Tax detail from invoices, bills, credit/debit notes, operational documents, POS sales, POS returns and posted tax adjustments is mirrored into the ledger.

`GET /ledger` exposes tax-ledger entries using `tax.read`.

Operational document status still controls whether a tax-ledger entry is reportable. Draft/unposted business documents do not become statutory activity merely because a tax detail row exists.

### POS

POS now uses the same fixed-point component calculator as transactional accounting. Inventory tax profiles can determine the sale tax code automatically. Received item returns create proportional negative tax-subledger entries and prevent return quantity from exceeding the original sale quantity.

### Tax determination

Selection precedence is:

1. explicit transaction-line tax choice;
2. catalog tax profile;
3. effective-dated tax rules / partner defaults;
4. explicit withholding overlay where applicable.

Rule conditions now evaluate transaction facts such as tax category, industry, residency and supplied context. Only one rule wins within a `rule_group`; distinct groups can stack.

## Verification

Dependency-free kernel tests:

```bash
node --test src/tests/gra1.tax-kernel.test.js
```

These cover percentage-point rates, Ghana component tax, inclusive tax, half-up rounding, recoverability, tax-rule conditions/stacking, exempt-vs-standard selection, input/output direction, POS ledger/reporting, tax posting aggregation and e-invoice percentage serialization.

## Not included in GRA-1

The following remain later releases and should not be inferred as complete from this release:

- full Ghana 2026 VAT return semantics and mixed-supply apportionment;
- VAT registration threshold monitoring;
- imported-services VAT workflow;
- income withholding and VAT-withholding completion;
- Ghana PAYE/SSNIT/Tier 2 completion;
- production GRA E-VAT adapter/certification;
- CIT/capital allowances;
- hospital/school/mart sector packs.
