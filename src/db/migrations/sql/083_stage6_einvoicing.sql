-- Stage 6: E-invoicing (UBL generation + submission tracking)

BEGIN;

CREATE TABLE IF NOT EXISTS e_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('invoice','bill')),
  source_id UUID NOT NULL,
  format TEXT NOT NULL DEFAULT 'ubl2.1',
  status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN ('generated','queued','submitted','accepted','rejected','failed','cancelled')),
  network TEXT NOT NULL DEFAULT 'none',
  ubl_xml TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NULL,
  response JSONB NULL,
  created_by UUID NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_e_invoices_org_source ON e_invoices(organization_id, source_type, source_id);

INSERT INTO permissions(code, description) VALUES
  ('einvoicing.read', 'Read e-invoices'),
  ('einvoicing.manage', 'Manage e-invoices')
ON CONFLICT (code) DO NOTHING;

COMMIT;
