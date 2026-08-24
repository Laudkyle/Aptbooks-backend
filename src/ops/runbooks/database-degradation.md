# Runbook: database degradation

Check connectivity, provider health, pool total/idle/waiting gauges, query-error rate and query-latency histogram. Confirm the runtime role is still least privilege and RLS is enforced. Stop high-cost nonessential batch/report activity if necessary, but do not disable financial constraints or RLS. For failover/recovery, preserve the current recovery point and use the documented DR process. Run financial-integrity verification after database recovery.
