#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${PGHOST:?set PGHOST}"
: "${PGPORT:=5432}"
: "${PGDATABASE:?set PGDATABASE}"
: "${PGUSER:?set PGUSER to a dedicated backup role}"
: "${BACKUP_DIR:?set BACKUP_DIR}"
: "${PGSSLMODE:=verify-full}"
export PGHOST PGPORT PGDATABASE PGUSER PGSSLMODE

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="aptbooks-${PGDATABASE}-${stamp}.dump"
out="$BACKUP_DIR/$base"
manifest="$out.sha256"

# Authentication must come from PGPASSFILE, PGPASSWORD, IAM, or the platform's
# native credential mechanism. Credentials are never placed in argv here.
pg_dump --format=custom --compress=9 --no-owner --no-privileges \
  --file="$out" "$PGDATABASE"
(cd "$BACKUP_DIR" && sha256sum "$base" > "$base.sha256")
printf 'Backup created: %s\nChecksum: %s\n' "$out" "$manifest"
