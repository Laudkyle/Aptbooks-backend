-- Tier 2: Notifications + Global Search + /me + current period API support

-- Permissions
INSERT INTO permissions (code, description) VALUES
  ('notifications.manage', 'Create/broadcast notifications'),
  ('notifications.read', 'Read own notifications'),
  ('search.read', 'Use global search')
ON CONFLICT (code) DO NOTHING;

-- Unified notifications table (per-user, per-organization)
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'general',
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','success','warning','error')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_org_user_created
  ON notifications(organization_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_org_user_unread
  ON notifications(organization_id, user_id)
  WHERE read_at IS NULL;
