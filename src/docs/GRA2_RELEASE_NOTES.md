# AptBooks GRA Release 2 — Ghana VAT Compliance Layer

## Scope

GRA-2 builds on migration `148_gra1_tax_kernel.sql` and the canonical `tax_ledger_entries` source of truth.
It adds Ghana VAT recovery, mixed-supply apportionment, VAT-registration monitoring for businesses dealing in goods, and imported-services reverse-charge accounting.

## Migration

Run:

`149_gra2_ghana_vat_compliance.sql`

after migration 148.

The migration adds:

- Ghana VAT monitoring settings and snapshots.
- Catalog-level purchase recovery classification.
- Six-decimal recovery ratios in the canonical tax ledger.
- Mixed-input apportionment periods and posting linkage.
- Imported-service transactions and component tax details.
- Ghana imported-services composite VAT/NHIL/GETFund tax code.
- Tenant-integrity triggers for new Ghana VAT entities.
- Ghana country-pack metadata version `2026.2.0`.

## Recovery model

A purchase catalog profile can classify input tax as:

- `direct_taxable` — directly attributable to taxable/zero-rated activity; normally fully recoverable.
- `direct_exempt` — directly attributable to exempt activity; blocked from recovery.
- `mixed` — used by taxable and exempt activity; subject to period apportionment.
- `not_applicable` — no input recovery.

The organization setting `mixed_input_provisional_percent` controls the provisional recovery applied to new mixed-use transactions before period apportionment. The default is deliberately conservative (`0`).

## Mixed-supply apportionment

The statutory calculation helper uses taxable supplies / total taxable+exempt supplies and applies the configured Ghana Act 1151 thresholds:

- below 5%: no mixed-input deduction;
- above 95%: full mixed-input deduction;
- otherwise: pro-rata recovery.

Directly attributable taxable and exempt input tax remain separate from the mixed pool.

Posting an apportionment creates a journal only for the difference between provisional and final mixed-input recovery, then updates the affected canonical tax-ledger entries. Voiding reverses that journal and restores the pre-apportionment tax-ledger recovery values.

## VAT registration monitor

Endpoint:

`GET /tax/ghana/vat/registration-monitor?asOfDate=YYYY-MM-DD`

Default configuration monitors the current Ghana goods threshold of GH¢750,000 and is intentionally scoped to `businesses_dealing_in_goods`.

The automatic basis uses a rolling 12-month taxable-goods turnover view from qualifying invoices and POS activity, net of qualifying credit/return activity. Unclassified sales are surfaced as `manualReviewRequired` rather than silently assumed taxable.

Settings can switch the monitor to a manually supplied turnover basis where the organization's legal/operational facts require external adjustment.

The monitor is a compliance control, not an automatic VAT-registration decision. Actual registration/deregistration remains a taxpayer/GRA process.

## Imported services

Endpoints:

- `GET /tax/ghana/imported-services`
- `GET /tax/ghana/imported-services/:id`
- `POST /tax/ghana/imported-services`
- `PATCH /tax/ghana/imported-services/:id`
- `POST /tax/ghana/imported-services/:id/post`
- `POST /tax/ghana/imported-services/:id/void`
- `GET /reporting/tax/ghana/imported-services-summary`

The default Ghana imported-services code applies VAT 15%, NHIL 2.5%, and GETFund 2.5% on a common base. The transaction records a declaration due date 21 days after its tax-period end.

Posting creates a balanced reverse-charge journal:

- Dr recoverable input tax, to the extent deductible;
- Dr non-recoverable input-tax expense, to the extent blocked;
- Cr reverse-charge/output tax liability for the total statutory tax.

The component details are synchronized into the canonical tax ledger with `direction='reverse_charge'`, so the VAT return shows the output liability and only the allowable recoverable input amount.

## Ghana VAT reporting changes

Ghana VAT reporting now:

- includes output VAT, NHIL and GETFund as one Ghana VAT population;
- includes imported-services reverse charge;
- uses `recoverable_amount` rather than gross input tax when computing input credits;
- reports non-recoverable input tax separately;
- de-duplicates the taxable base across VAT/NHIL/GETFund components;
- reconciles the same Ghana component population against configured tax-control accounts.

## Apportionment APIs

- `GET /tax/ghana/vat/apportionments`
- `POST /tax/ghana/vat/apportionments/calculate`
- `POST /tax/ghana/vat/apportionments/:id/post`
- `POST /tax/ghana/vat/apportionments/:id/void`

All mutation endpoints require existing `tax.manage` permission; reads use `tax.read`. Posting/voiding endpoints retain idempotency middleware.

## Configuration additions

`tax_settings` supports:

- `mixedInputProvisionalPercent`
- `ghVatGoodsRegistrationThreshold`
- `ghVatMonitorEnabled`
- `ghVatManualGoodsTurnover`
- `ghVatTurnoverBasis`

Catalog tax profiles support:

- `purchaseRecoveryMode`
- `defaultRecoverablePercent`
- `legalReference`
- `relieved` tax scope

## Deployment checklist

1. Back up the database.
2. Apply migrations through 148 first.
3. Run migration 149 in staging.
4. Inspect seeded `GH_IMPORTED_SERVICES_20` and `GH_MIXED_INPUT` records per organization.
5. Confirm `tax_settings` has input-tax, output/reverse-charge, and non-recoverable input-tax accounts configured.
6. Classify purchase catalog profiles with the appropriate recovery basis.
7. Review unclassified invoice/POS sales reported by the registration monitor.
8. Run a mixed taxable/exempt period apportionment in staging and reconcile its journal.
9. Run an imported-service sample and confirm VAT/NHIL/GETFund tax-ledger and GL values.
10. Compare Ghana VAT return totals to the canonical tax ledger and tax-control GL accounts.

## Important boundary

GRA-2 materially strengthens Ghana VAT accounting, but it is not the final GRA compliance release. It does not yet implement the full income-WHT/VAT-withholding matrix, official filing-form/version lifecycle, Ghana PAYE/SSNIT/Tier 2, or certified GRA E-VAT fiscalization. Those remain subsequent releases.
