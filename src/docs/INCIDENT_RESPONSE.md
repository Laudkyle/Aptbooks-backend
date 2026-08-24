# Incident Response

## Severity

- SEV-1: suspected cross-tenant exposure, incorrect/imbalanced ledger state, loss of posted financial data, credential compromise, or broad production outage.
- SEV-2: substantial feature outage, persistent scheduler/accounting automation failure, database saturation, or sustained SLO breach without known financial corruption.
- SEV-3: localized degradation with a safe workaround and no evidence of financial-integrity impact.

## Required incident record

Record UTC start/detection/mitigation/end times, severity, incident commander, affected release, customer/tenant scope when known, trace/request IDs, alert(s), financial-integrity status, actions taken, decision log, and follow-up owners. Never paste passwords, tokens, full request bodies, raw customer financial exports, or unredacted SQL parameters into incident chat/tickets.

## Response order

Protect accounting correctness and tenant isolation first. If integrity is uncertain, stop or drain affected financial mutations before attempting convenience fixes. Preserve evidence. Use trace/request IDs to correlate logs. Check `/readyz`, metrics, database pool health, scheduler failures and the most recent financial-integrity run. Roll forward or back only with schema compatibility understood. After mitigation, run financial-integrity checks and reconcile impacted subledgers before declaring the incident resolved.

Every SEV-1 and recurring SEV-2 requires a blameless post-incident review with corrective actions that can be tested or monitored.
