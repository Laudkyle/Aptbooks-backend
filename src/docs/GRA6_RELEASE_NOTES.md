# GRA Release 6 — CIT, Capital Allowances, Industry Profiles, Readiness

Release 6 builds on GRA Releases 1–5. It adds Ghana corporate-income-tax workpapers/returns,
self-assessment estimates, a tax-specific capital-allowance register, Ghana sector templates,
and a consolidated readiness score.

## Statutory source model

The seeded defaults are effective-dated and cite the current GRA public guidance used when this
release was prepared. They are configuration, not a substitute for taxpayer-specific tax advice.
Special rates are never automatically selected from an industry profile.

- General CIT: 25%; GRA also publishes industry/location-specific rates.
- Self-assessment: four quarterly instalments.
- Annual income return: not later than four months after the end of the basis period.
- Capital allowance classes currently published by GRA: Class 1 40%, Class 2 30%, Class 3 20%,
  Class 4 10%, Class 5 based on useful life. Book depreciation remains separate.

Sources:
- https://gra.gov.gh/domestic-tax/tax-types/corporate-income-tax/
- https://gra.gov.gh/domestic-tax/capital-allowance/
- https://gra.gov.gh/domestic-tax/domestic-tax-faq/
- https://gra.gov.gh/forms/

## Migration

Run `153_gra6_cit_industry_readiness.sql` after migration 152.

## CIT APIs

- `GET /tax/ghana/cit/settings`
- `PUT /tax/ghana/cit/settings`
- `GET /tax/ghana/cit/rates`
- `GET/POST /tax/ghana/cit/computations`
- `GET /tax/ghana/cit/computations/:id`
- `POST /tax/ghana/cit/computations/:id/adjustments`
- `POST /tax/ghana/cit/computations/:id/finalize`
- `POST /tax/ghana/cit/computations/:id/filed`
- `GET/POST /tax/ghana/cit/self-assessments`
- `POST /tax/ghana/cit/self-assessments/:id/finalize`
- `POST /tax/ghana/cit/self-assessments/:id/filed`
- `POST /tax/ghana/cit/self-assessments/:id/payments`

CIT is disabled by default. Configure taxpayer identity, rate and GL mappings before enabling it.
A special CIT rate cannot be finalized until eligibility is explicitly reviewed.

## Capital allowance APIs

- `GET /tax/ghana/capital-allowances/classes`
- `GET/POST /tax/ghana/capital-allowances/assets`
- `POST /tax/ghana/capital-allowances/assets/:id/dispose`
- `GET/POST /tax/ghana/capital-allowances/runs`
- `GET /tax/ghana/capital-allowances/runs/:id`
- `POST /tax/ghana/capital-allowances/runs/:id/finalize`

The tax asset register is intentionally separate from book fixed assets and book depreciation.
A tax asset can link to a fixed asset, but tax cost, business-use percentage, class, useful life,
and tax WDV are retained independently.

## Industry profiles

Seeded Ghana profiles:

- `GH_HOSPITAL`
- `GH_SCHOOL`
- `GH_MART`
- `GH_HOTEL_RESTAURANT`
- `GH_PROFESSIONAL_SERVICES`
- `GH_GENERAL_TRADING`

These install recommended capabilities/classification checklists only. They do **not** automatically
declare a whole hospital/school/business exempt, standard-rated, or entitled to a special CIT rate.
Every supply/item/service still flows through the tax determination engine and review process.

## Readiness

`GET /tax/ghana/readiness?persist=true` evaluates tax pack installation, taxpayer identity, CIT,
VAT/catalog classification, WHT/WHVAT, payroll, E-VAT, tax assets, sector profile and fiscal queue
exceptions. Persisted snapshots are stored in `ghana_readiness_snapshots`.

The readiness score is operational guidance, not a legal certification or GRA approval.

## Deployment

1. Back up the database.
2. Run migration 153 in staging.
3. Confirm the general CIT rate is selected; do not activate a special rate without eligibility review.
4. Configure CIT taxpayer ID and GL accounts.
5. Map fixed assets into the Ghana tax asset register and review tax classes.
6. Install/review the applicable industry profile.
7. Generate a readiness snapshot and clear blockers.
8. Parallel-run one CIT computation and capital-allowance schedule against an accountant's working papers.
9. Only then deploy/enable in production.
