BEGIN;

ALTER TABLE tax_returns
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID NULL REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS workflow_status TEXT NOT NULL DEFAULT 'draft' CHECK (workflow_status IN ('draft','submitted','approved','rejected')),
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS submitted_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS approved_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS rejected_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_tax_returns_org_workflow_status
  ON tax_returns(organization_id, workflow_status);

COMMIT;
