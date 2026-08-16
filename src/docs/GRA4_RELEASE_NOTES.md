# GRA Release 4 — Ghana PAYE, SSNIT and Tier 2

Release 4 builds on migrations 148–150 and adds Ghana-native payroll statutory calculation and filing support.

## Migration

Run `151_gra4_ghana_payroll_paye_pensions.sql` after migration 150.

The migration is intentionally opt-in per organization. Ghana country-pack organizations receive a `ghana_payroll_settings` row with `enabled = false` until PAYE/SSNIT/Tier-2 account mappings are reviewed.

## Effective-dated Ghana statutory rules

`ghana_payroll_rule_versions` stores immutable/effective-dated statutory rules. The first seeded versions are:

- `GH_PAYE`, effective 2024-01-01, based on the resident monthly bands and special employment rates currently published by GRA.
- `GH_SSNIT`, effective 2026-01-01, based on SSNIT's 2026 minimum/maximum insurable earnings notice and current employer contribution guidance.

Important 2026 SSNIT parameters are stored explicitly rather than inferred only from percentages:

- minimum insurable earnings: GHS 587.80
- maximum insurable earnings: GHS 69,000.00
- minimum Tier-1 amount payable to SSNIT: GHS 79.40
- maximum Tier-1 amount payable to SSNIT: GHS 9,315.00
- employee contribution: 5.5%
- employer contribution funding: 13%
- Tier-1 remittance: 13.5%
- Tier-2 allocation: 5%

Historical payroll runs retain the rule-version IDs used for calculation.

## Fixed-point Ghana payroll kernel

`modules/hr/payroll/ghana/ghanaPayroll.js` calculates Ghana statutory amounts in integer minor units with explicit half-up rounding. The Ghana path does not rely on IEEE-754 money arithmetic.

Supported PAYE treatments include:

- resident graduated monthly PAYE;
- ordinary non-resident employment income at the current flat rate;
- the GRA-published special rate for non-resident bonus/overtime;
- casual-worker final withholding;
- part-time resident treatment configured in the effective-dated rule;
- bonus concession up to the remaining statutory annual-basic threshold;
- excess bonus pushed into graduated income;
- qualifying junior-staff overtime at the concessionary bands, subject to explicit employee eligibility and the current qualifying-income ceiling;
- approved monthly tax relief;
- employee SSNIT deduction before PAYE chargeable income.

## Employee statutory profile

Employees can now carry:

- Ghana Card PIN;
- SSNIT number;
- Tier-2 member ID and scheme name;
- resident/non-resident tax status;
- regular, temporary, casual or part-time worker classification;
- qualifying-overtime flag;
- pension-exempt flag;
- approved monthly tax relief;
- employment end date.

## Payroll component classification

Payroll components can classify Ghana earnings/deductions as:

- regular;
- bonus;
- overtime;
- non-taxable;
- relief;
- other deduction.

The normal payroll form remains the operational source; the Ghana kernel consumes these classifications when the organization enables Ghana payroll.

## Payroll calculation snapshot

Each Ghana payroll run line records and freezes:

- taxable earnings;
- chargeable income;
- graduated/total PAYE;
- bonus tax;
- overtime tax;
- insurable earnings;
- employee SSNIT;
- employer pension contribution;
- Tier-1 amount payable to SSNIT;
- Tier-2 amount payable;
- total employer cost;
- PAYE and pension rule versions.

## Payroll-to-GL

The generated payroll journal separates:

- employee net-pay payable;
- PAYE payable;
- SSNIT Tier-1 payable;
- Tier-2 payable;
- employer pension expense;
- other configured deductions/benefits.

Journal aggregation uses exact minor-unit arithmetic and refuses to create an unbalanced payroll journal.

## PAYE returns and schedules

The Ghana payroll API can prepare frozen returns from **posted** Ghana payroll runs only:

- DT107 monthly PAYE return with DT107A schedule export;
- DT108 annual PAYE return with DT108A schedule export;
- DT107C disengaged-employee schedule.

Finalization blocks any employee line that has neither a taxpayer identifier nor Ghana Card PIN. Filing records the GRA reference and preserves the return version and frozen source-run membership.

The CSV exports are return-ready data extracts generated from AptBooks records. They should be compared against the current GRA upload template before production filing because GRA can revise workbook column layouts independently of the tax law.

## SSNIT / Tier-2 contribution schedule

The pension schedule provides employee-level:

- insurable earnings;
- employee contribution;
- employer contribution;
- Tier-1 payable;
- Tier-2 payable;
- SSNIT number;
- Tier-2 member/scheme identifiers.

## Statutory remittances

AptBooks can prepare PAYE, SSNIT Tier-1 and Tier-2 remittance records from posted payroll runs.

Marking a remittance paid now requires a payment date and settlement account and creates/posts the GL settlement journal:

- Dr relevant statutory payable
- Cr bank/cash

The remittance keeps the settlement account, payment reference, posted journal and actor for auditability.

## API

Base path: `/hr/payroll/ghana`

- `GET/PATCH /settings`
- `GET/POST /returns`
- `GET /returns/:id`
- `POST /returns/:id/finalize`
- `POST /returns/:id/filed`
- `GET /returns/:id/export.csv`
- `GET /pension-schedule`
- `GET /disengaged-schedule`
- `GET/POST /remittances`
- `POST /remittances/:id/paid`

Permissions:

- `hr.payroll.ghana.read`
- `hr.payroll.ghana.manage`
- `hr.payroll.ghana.file`

Existing Admin/Administrator/Super Admin/Owner roles receive these permissions during the migration; custom roles must be assigned explicitly.

## Official source references used for the seeded rules

- Ghana Revenue Authority PAYE: https://gra.gov.gh/domestic-tax/tax-types/paye/
- Ghana Revenue Authority forms: https://gra.gov.gh/forms/
- SSNIT employer guidance: https://www.ssnit.org.gh/become-an-employer/
- SSNIT 2026 maximum/minimum notice: https://www.ssnit.org.gh/maximum-insurable-earning-increased/

## Deployment checklist

1. Back up the database.
2. Apply migrations through 150 if not already applied.
3. Apply migration 151 in staging.
4. Configure PAYE, SSNIT Tier-1, Tier-2 and employer pension expense accounts.
5. Set employer GRA/SSNIT identifiers.
6. Complete employee Ghana Card/TIN, SSNIT and Tier-2 details.
7. Classify bonus/overtime/non-taxable/relief payroll components.
8. Calculate a parallel payroll and compare employee-by-employee against the organization's existing approved payroll/GRA schedule.
9. Build and post the payroll journal; reconcile PAYE/SSNIT/Tier-2 liabilities.
10. Prepare DT107/DT107A and pension schedules and compare them to the current authority templates before live filing.
11. Only then enable Ghana payroll in production.

## Validation performed in the stripped source tree

- all backend JavaScript syntax checked;
- all relative runtime `require()` references resolved;
- GRA Releases 1–4 dependency-free regression tests passed;
- migration 151 quote/comment/parenthesis sanity check passed.

A live PostgreSQL migration was not executed in this stripped source archive. Migration 151 must therefore be run and exercised against a staging copy of the real schema before production.
