# Runbook: high HTTP error rate

Use route/status labels to identify the affected surface, then correlate examples by request ID and trace ID in structured logs. Check whether the error started with a release, dependency outage or database degradation. Do not use customer payloads as debugging logs. If financial mutations are failing ambiguously, verify idempotency records and ledger integrity before asking users to retry. Roll back/forward only with migration compatibility understood.
