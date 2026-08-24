# Runbook: scheduler failure

Identify the task code from the bounded scheduler metric and inspect its persisted `scheduled_task_runs` record. Determine whether failure occurred inside the job or scheduler infrastructure. Failed automatic tasks use bounded retry/backoff and may disable after repeated failure; do not repeatedly run a financial job manually without confirming idempotency and tenant scope. After recovery, verify the task's financial side effects and run the relevant reconciliation/integrity checks.
