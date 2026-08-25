# Tax Workspace Backend Contract

The frontend Tax control centre is backed by `GET /core/accounting/tax/workspace`, a read-only tenant-scoped aggregate that summarizes readiness, VAT registration, statutory withholding, corporate tax and E-VAT transmission health.

Ghana withholding is the canonical statutory withholding contract used by the Tax workspace. The backend now exposes `GET /core/accounting/tax/ghana/withholding/remittances`, which returns only remittances belonging to the Ghana statutory regimes (`income_wht` and `vat_withholding`). This fixes the former frontend behavior where Ghana remittances were created through the statutory endpoint but listed through the older generic withholding endpoint.

The older `/core/accounting/tax/withholding/*` workflow remains available for compatibility with historical integrations/data. It is not the canonical Tax workspace API and should not be used by new frontend Tax features.
