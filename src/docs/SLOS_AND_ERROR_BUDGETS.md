# AptBooks SLOs and Error Budgets

The service-level objectives in `ops/slo-definition.json` are the initial production reliability contract. Availability is measured from non-intentional API outcomes; planned maintenance must be separately identified rather than deleting data. Interactive latency is evaluated from the HTTP duration histogram. Financial-integrity failures have a zero-tolerance objective because they can indicate accounting correctness drift rather than ordinary service degradation.

For a 99.9% 30-day availability objective, the approximate monthly error budget is 43.2 minutes. Error budgets are a release-control mechanism, not a target for permissible downtime. A fast burn should page the on-call owner; a sustained slow burn should block risky releases; exhaustion should freeze nonessential releases until the underlying reliability issue has been corrected and the service demonstrates recovery.

Do not include `/metrics`, `/healthz`, deliberate authentication failures, expected validation 4xx responses, or synthetic chaos traffic in the user-availability numerator/denominator unless the monitoring definition explicitly accounts for them.
