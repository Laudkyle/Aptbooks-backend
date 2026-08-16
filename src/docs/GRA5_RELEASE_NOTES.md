# GRA Release 5 — E-VAT Fiscalization Foundation

## Scope

Release 5 adds the backend architecture needed to integrate AptBooks ERP/POS with Ghana Revenue Authority Certified Invoicing (E-VAT) without inventing GRA's production API contract.

GRA's published guidance permits an existing ERP/POS to be integrated with the GRA invoicing system. For an integration taxpayer, GRA provides API documentation during onboarding, the taxpayer integrates, testing is performed, GRA signs off, and the taxpayer is scheduled to go live. Production transport therefore remains behind a contract-specific adapter boundary until the onboarding API pack is supplied.

## Added

- `fiscalization_settings` with simulation/pending/live modes and onboarding state.
- Fiscal locations and fiscal devices linked to existing POS stores/registers/devices.
- Generic `fiscal_documents` for invoice, POS receipt, credit/debit note and return/refund document families.
- Storage for GRA security fields: Commissioner-General signature, QR code, receipt/invoice signature, verification engine ID, encrypted data, fiscal timestamp, serial/receipt number and machine registration code.
- Durable idempotent `fiscal_transmission_queue` using claimed-state + `FOR UPDATE SKIP LOCKED`.
- 24-hour-capped offline-pending window, retry/dead-letter state and exponential retry scheduling.
- Append-only `fiscal_system_logs` plus CSV log export for compliance/electronic-log access.
- Six-year fiscal-document retention date.
- Automatic fiscal snapshot creation when an AR invoice is issued or a POS sale is completed/created, when fiscalization is enabled.
- POS receipt API includes fiscal security/status information after fiscal processing.
- Explicit simulation adapter (`GRA_EVAT_SIM`) which never masquerades as official certification.
- Tenant-integrity triggers for fiscal locations/devices/documents/queue references.

## Public GRA requirements represented in the model

The fiscal payload model carries seller identity/address/TIN, supply date/time, consecutive number, buyer identity/TIN when supplied, line descriptions, quantities/UOM, transaction type, separate tax/levy amounts, tax-exclusive totals, discount amount/rate, tax total and tax-inclusive total. The response model retains QR/signature/verification/timestamp/serial/receipt/machine fields.

## Live GRA adapter

`graEvat.adapter.js` intentionally refuses production transmission until a GRA onboarding-specific API contract mapper is installed. Do not replace this with guessed endpoints or guessed field names. When GRA provides the API pack, implement the adapter behind `submitToGraEvat()` and keep the rest of the fiscal model/queue unchanged.

## Migration

Run after migration 151:

`152_gra5_evat_fiscalization.sql`

Test migration 152 on staging before production.

## Recommended rollout

1. Run migration 152.
2. Configure a current Ghana VAT registration in AptBooks.
3. Configure organization identity/address.
4. Create fiscal locations/devices and map POS registers.
5. Enable `simulation` mode first.
6. Run invoice + POS certification simulations and inspect fiscal receipts/logs.
7. Request/complete GRA E-VAT integration onboarding.
8. Install the GRA-provided contract mapper.
9. Complete GRA testing/sign-off.
10. Switch to live only after sign-off.
