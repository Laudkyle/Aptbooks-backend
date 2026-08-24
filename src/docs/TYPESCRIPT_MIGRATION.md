# Incremental TypeScript Migration

Phase 3 introduces strict accounting, HTTP and branded-ID contracts without changing the runtime loader of this source-only repository.

The root repositories supplied for this exercise do not include `package.json`, lockfiles or bundler/compiler configuration. Renaming runtime JavaScript to TypeScript here would therefore make the delivered source unverifiable and could break production builds. The migration is intentionally staged.

## Stage A — delivered in Phase 3

- Strict `tsconfig.phase3.json` contracts with `noEmit`.
- Branded organization/user/account/journal/period/document IDs.
- Decimal-string, Money, PostingLine, PostingCommand and AccountingPolicy contracts.
- Frontend API envelope and journal-view contracts.
- Architecture gates preventing new maintainability debt while runtime conversion proceeds.

## Stage B — after reintegration into the full repository

Install and pin TypeScript in the root toolchain. Add a blocking `typecheck` CI job using the Phase 3 config. Convert pure modules first: money/fixed-point helpers, posting invariants, accounting policy normalization, validators and API mappers. Keep file-by-file behavior tests green.

## Stage C

Convert repositories and service contracts by bounded context. Prefer branded IDs and decimal strings at interfaces. Convert React feature modules after their API/domain types are established. Remove a debt-baseline exception whenever its module is converted or decomposed.

A mass rename of JavaScript files is explicitly prohibited; correctness and deployability take precedence over percentage-of-TypeScript metrics.
