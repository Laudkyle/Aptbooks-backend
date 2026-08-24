#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${APTBOOKS_ALLOW_RESTORE:?set APTBOOKS_ALLOW_RESTORE=true explicitly}"
[[ "$APTBOOKS_ALLOW_RESTORE" == "true" ]] || { echo 'restore refused'; exit 2; }
: "${PGHOST:?set PGHOST}"
: "${PGPORT:=5432}"
: "${PGDATABASE:?set PGDATABASE to the restore target}"
: "${PGUSER:?set PGUSER to the restore/migrator role}"
: "${PGSSLMODE:=verify-full}"
export PGHOST PGPORT PGDATABASE PGUSER PGSSLMODE
: "${1:?usage: restore-postgres.sh path/to/backup.dump}"

backup="$1"
manifest="${backup}.sha256"
[[ -f "$backup" ]] || { echo "missing backup: $backup"; exit 2; }
[[ -f "$manifest" ]] || { echo "missing checksum manifest: $manifest"; exit 2; }
(cd "$(dirname "$backup")" && sha256sum --check "$(basename "$manifest")")

# Credentials are sourced from the environment/PGPASSFILE/IAM, never argv.
pg_restore --exit-on-error --clean --if-exists --no-owner --no-privileges \
  --dbname="$PGDATABASE" "$backup"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
psql --set=ON_ERROR_STOP=1 --dbname="$PGDATABASE" \
  --file="$script_dir/../db/admin/post_restore_verify.sql"
printf 'Restore and accounting integrity verification completed successfully.\n'
