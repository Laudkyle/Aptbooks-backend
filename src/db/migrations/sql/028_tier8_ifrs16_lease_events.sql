BEGIN;

CREATE TABLE IF NOT EXISTS lease_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lease_id uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  event_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lease_events_org_lease_created
  ON lease_events(organization_id, lease_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lease_events_org_type_created
  ON lease_events(organization_id, event_type, created_at DESC);

COMMIT;
