-- 074_stage5_tax_admin_permissions.sql
-- Stage 5: VAT/GST administration API permissions

BEGIN;

INSERT INTO permissions (code, description) VALUES
  ('tax.read', 'Read VAT/GST tax jurisdictions, codes and settings'),
  ('tax.manage', 'Manage VAT/GST tax jurisdictions, codes and settings')
ON CONFLICT (code) DO NOTHING;

COMMIT;
