BEGIN;

ALTER TABLE tax_returns
  ADD COLUMN IF NOT EXISTS return_version INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS amendment_no INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT TRUE;

-- Normalize pre-existing duplicate returns so the newest non-voided return remains current.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY organization_id, tax_type, from_date, to_date, COALESCE(jurisdiction_id, '00000000-0000-0000-0000-000000000000'::uuid)
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM tax_returns
  WHERE status <> 'voided'
)
UPDATE tax_returns tr
SET is_current = CASE WHEN ranked.rn = 1 THEN TRUE ELSE FALSE END
FROM ranked
WHERE ranked.id = tr.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_returns_current_period
  ON tax_returns (
    organization_id,
    tax_type,
    from_date,
    to_date,
    COALESCE(jurisdiction_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE is_current = TRUE AND status <> 'voided';

CREATE INDEX IF NOT EXISTS idx_tax_returns_current_status
  ON tax_returns(organization_id, tax_type, is_current, status, from_date, to_date);

COMMIT;
