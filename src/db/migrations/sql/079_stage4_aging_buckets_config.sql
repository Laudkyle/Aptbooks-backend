-- Stage 4: Configurable AR/AP aging buckets

CREATE TABLE IF NOT EXISTS aging_bucket_sets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aging_bucket_sets_org ON aging_bucket_sets(organization_id);

CREATE TABLE IF NOT EXISTS aging_buckets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  bucket_set_id UUID NOT NULL,
  label TEXT NOT NULL,
  start_days INTEGER NOT NULL,
  end_days INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aging_buckets_set ON aging_buckets(bucket_set_id);

-- Seed a default bucket set per org from existing organizations (safe if multiple runs)
INSERT INTO aging_bucket_sets (organization_id, name, is_default)
SELECT o.id, 'Default', TRUE
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM aging_bucket_sets s WHERE s.organization_id = o.id AND s.is_default = TRUE
);

-- Seed default buckets for each default set if absent
INSERT INTO aging_buckets (organization_id, bucket_set_id, label, start_days, end_days, sort_order)
SELECT s.organization_id, s.id, b.label, b.start_days, b.end_days, b.sort_order
FROM aging_bucket_sets s
CROSS JOIN (VALUES
  ('CURRENT', -999999, 0, 1),
  ('1-30', 1, 30, 2),
  ('31-60', 31, 60, 3),
  ('61-90', 61, 90, 4),
  ('91-120', 91, 120, 5),
  ('120+', 121, NULL, 6)
) AS b(label,start_days,end_days,sort_order)
WHERE s.is_default=TRUE
AND NOT EXISTS (
  SELECT 1 FROM aging_buckets ab WHERE ab.bucket_set_id = s.id
);

-- Permissions
INSERT INTO permissions (code, description)
SELECT v.code, v.description
FROM (VALUES
  ('reporting.config.manage','Manage reporting configuration such as aging buckets')
) AS v(code,description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);
