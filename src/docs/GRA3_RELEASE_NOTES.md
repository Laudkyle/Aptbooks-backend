# GRA Release 3 — Ghana Withholding Compliance

Release 3 builds on the GRA-1 tax kernel and GRA-2 VAT compliance layer. It separates Ghana income withholding tax from VAT withholding (WHVAT), moves compliance event recognition to payment time, adds cumulative annual threshold tracking, certificates, remittances, frozen DT110/WHVAT returns, supplier-side credit certificates, and withholding reconciliation.

## Statutory model implemented

- Income WHT and VAT withholding are distinct regimes.
- Resident goods/works/services tax codes use annual cumulative threshold tracking where applicable.
- VAT withholding uses a dedicated `GH_WHVAT_7` code on the standard-rated taxable value when the organization is configured as an appointed VAT withholding agent.
- Withholding return/remittance due dates are calculated as the 15th of the following month.
- DT110 and WHVAT returns freeze event membership at preparation/finalization.
- Return finalization is blocked when a withholdee TIN/GUIN is missing.
- Received WHVAT credit certificates reduce the Ghana VAT net payable as a separately disclosed credit.

Reference material used for the release design:
- Ghana Revenue Authority — Withholding Tax: https://gra.gov.gh/domestic-tax/tax-types/withholding-tax/
- Ghana Revenue Authority — VAT Withholding: https://gra.gov.gh/domestic-tax/tax-types/vat-withholding/
- Ghana Revenue Authority — Forms: https://gra.gov.gh/forms/

## New canonical compliance records

- `ghana_withholding_events`
- `ghana_withholding_certificates`
- `ghana_withholding_returns`
- `ghana_withholding_return_lines`
- `ghana_withholding_remittance_events`

Events are idempotent through `(organization_id, event_key)` and retain payment/source references, category, annual cumulative position, tax code, taxable basis, rate, amount, certificate, remittance and return references.

## Payment settlement behavior

For VAT withholding, a vendor payment now distinguishes:

- cash actually paid to the supplier;
- VAT withholding taxable basis;
- VAT withholding retained for GRA;
- A/P settlement amount = cash + discount + VAT withholding.

The payment journal credits the configured VAT-withholding payable account. The A/P open-item projection includes `vat_withholding_applied`, preventing a fully settled bill from remaining artificially open by the withheld amount.

## Received certificates

`POST /tax/ghana/withholding/certificates/received` records a received income-WHT or WHVAT certificate as a receivable compliance event. Received WHVAT is included in the Ghana VAT return as `vat_withholding_credit`, while the pre-credit liability remains visible as `net_tax_payable_before_vat_withholding_credit`.

## Return controls

- `DT110` — income withholding return.
- `WHVAT` — VAT withholding return for appointed withholding agents.
- Draft returns snapshot qualifying payable events.
- Finalization links frozen event membership.
- Finalization fails when a return line lacks a partner TIN/GUIN.
- Filing stores the GRA filing/reference number.

## Configuration

Tax settings now support:

- `gh_income_wht_agent_enabled`
- `gh_vat_withholding_agent_enabled`
- `gh_wht_annual_threshold`
- `gh_vat_withholding_rate`
- `vat_withholding_payable_account_id`
- `vat_withholding_receivable_account_id`

Partner tax profiles now support withholding exemptions, default WHT classification, and VAT-withholding eligibility.

## Migration

Run `150_gra3_withholding_compliance.sql` after migration 149.

Always test this migration on a staging copy of the production schema before production deployment. The stripped source package used during implementation did not include a live PostgreSQL test database.

## Compatibility note

The older AptBooks bill-posting flow may recognize income-WHT accounting liability when a bill is issued. GRA-3 adds the canonical compliance event at payment time and exposes the timing variance in withholding reconciliation. This preserves existing books while moving statutory schedules/certificates to the payment event. A future accounting-policy migration can move legacy income-WHT GL recognition entirely to settlement if you choose that policy across all tenants.
