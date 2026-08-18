# Architecture invariants

The executable gate in `architecture-gates.cjs` protects the accounting architecture established by the hardening programme. It is intentionally dependency-free so it can run before application dependencies are installed.

The gate rejects raw runtime `console.*`, shell-based process execution, duplicate top-level service functions, growth beyond the listed legacy-service budgets, restoration of tenant-authored Report Builder SQL execution, and native-`Number` financial decision paths in the migrated high-risk accounting modules.

The GitHub Actions workflow also runs the repository's dependency-free security/reliability contracts and exact-money/Ghana accounting kernel tests. If a legacy large service must grow, extract a cohesive domain module instead of increasing its line budget.
