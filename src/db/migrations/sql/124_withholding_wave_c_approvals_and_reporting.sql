BEGIN;

ALTER TABLE withholding_remittances
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID NULL REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS submitted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS approved_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS rejected_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT NULL;

ALTER TABLE withholding_certificates
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID NULL REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS submitted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS approved_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS rejected_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT NULL;

ALTER TABLE withholding_remittances DROP CONSTRAINT IF EXISTS withholding_remittances_status_check;
ALTER TABLE withholding_remittances ADD CONSTRAINT withholding_remittances_status_check CHECK (status IN ('draft','submitted','approved','rejected','posted','voided'));

ALTER TABLE withholding_certificates DROP CONSTRAINT IF EXISTS withholding_certificates_status_check;
ALTER TABLE withholding_certificates ADD CONSTRAINT withholding_certificates_status_check CHECK (status IN ('draft','submitted','approved','rejected','posted','voided'));

CREATE OR REPLACE VIEW reporting_withholding_register AS
WITH rem AS (
  SELECT r.organization_id, 'remittance'::text AS workflow_type, r.id AS workflow_id, r.remittance_no AS document_no,
         r.status, r.remittance_date AS document_date, r.period_start, r.period_end, r.currency_code,
         r.total_amount, 'payable'::text AS direction, bp.name AS partner_name, tc.code AS tax_code, tj.code AS jurisdiction_code
  FROM withholding_remittances r
  LEFT JOIN business_partners bp ON bp.id = r.authority_partner_id
  LEFT JOIN tax_codes tc ON tc.id = r.tax_code_id
  LEFT JOIN tax_jurisdictions tj ON tj.id = r.jurisdiction_id
), cert AS (
  SELECT c.organization_id, 'certificate'::text AS workflow_type, c.id AS workflow_id, c.certificate_no AS document_no,
         c.status, c.certificate_date AS document_date, NULL::date AS period_start, NULL::date AS period_end, NULL::varchar(10) AS currency_code,
         c.total_amount, 'receivable'::text AS direction, bp.name AS partner_name, tc.code AS tax_code, tj.code AS jurisdiction_code
  FROM withholding_certificates c
  LEFT JOIN business_partners bp ON bp.id = c.customer_id
  LEFT JOIN tax_codes tc ON tc.id = c.tax_code_id
  LEFT JOIN tax_jurisdictions tj ON tj.id = c.jurisdiction_id
)
SELECT * FROM rem
UNION ALL
SELECT * FROM cert;

COMMIT;
