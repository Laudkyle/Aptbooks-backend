#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${APTBOOKS_DR_DRILL_CONFIRM:?set APTBOOKS_DR_DRILL_CONFIRM=RESTORE_TO_DISPOSABLE_TARGET}"
[[ "$APTBOOKS_DR_DRILL_CONFIRM" == "RESTORE_TO_DISPOSABLE_TARGET" ]] || { echo 'DR drill refused'; exit 2; }
: "${DR_EVIDENCE_DIR:?set DR_EVIDENCE_DIR}"
: "${PGDATABASE:?set PGDATABASE to a disposable restore target}"
: "${DR_RTO_SECONDS:=3600}"
: "${1:?usage: dr-drill.sh path/to/backup.dump}"

backup="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$DR_EVIDENCE_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
evidence="$DR_EVIDENCE_DIR/aptbooks-dr-drill-$stamp.txt"
start_epoch="$(date +%s)"

{
  echo "drill_started_at=$stamp"
  echo "target_database=$PGDATABASE"
  echo "backup=$(basename "$backup")"
  echo "rto_target_seconds=$DR_RTO_SECONDS"
} > "$evidence"

APTBOOKS_ALLOW_RESTORE=true "$script_dir/restore-postgres.sh" "$backup" 2>&1 | tee -a "$evidence"

end_epoch="$(date +%s)"
elapsed="$((end_epoch - start_epoch))"
{
  echo "drill_completed_at=$(date -u +%Y%m%dT%H%M%SZ)"
  echo "elapsed_seconds=$elapsed"
  echo "result=$([[ "$elapsed" -le "$DR_RTO_SECONDS" ]] && echo PASS || echo FAIL_RTO)"
} >> "$evidence"

if [[ "$elapsed" -gt "$DR_RTO_SECONDS" ]]; then
  echo "DR drill exceeded RTO target ($elapsed > $DR_RTO_SECONDS seconds)" >&2
  exit 1
fi
printf 'DR drill PASS. Evidence: %s\n' "$evidence"
