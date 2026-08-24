# Disaster Recovery

AptBooks recovery is based on encrypted PostgreSQL backups plus platform-level point-in-time recovery/WAL archiving configured outside this source tree. Source code alone cannot enable PITR; the database platform must provide and continuously monitor it.

Recovery acceptance requires a clean checksum, successful restore to an isolated target, migrations/schema presence, RLS/security baseline, posted-journal balance verification, and application smoke tests. Restore evidence must identify the backup point, target, elapsed recovery time and verification result without embedding credentials.

Use `ops/dr-drill.sh` for repeatable restore evidence. Set an organization-approved RPO and RTO in infrastructure policy. The example RTO check defaults to one hour but should be changed to the contractual target. Run restore drills on a fixed cadence and after major database/storage architecture changes.
