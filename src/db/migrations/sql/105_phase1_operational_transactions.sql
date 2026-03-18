
-- Phase 1 operational transaction modules foundation

CREATE TABLE IF NOT EXISTS operational_document_sequences (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL,
  next_no BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, module_code)
);

CREATE TABLE IF NOT EXISTS operational_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL,
  document_no TEXT NOT NULL,
  counterparty_partner_id UUID REFERENCES business_partners(id) ON DELETE RESTRICT,
  employee_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  document_date DATE NOT NULL,
  due_date DATE NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','issued','posted','rejected','void')),
  memo TEXT NULL,
  reference TEXT NULL,
  source_document_id UUID NULL REFERENCES operational_documents(id) ON DELETE SET NULL,
  cash_account_id UUID NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  primary_account_id UUID NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  amount_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency_code CHAR(3) NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
  workflow_document_id UUID NULL REFERENCES documents(id) ON DELETE SET NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  rejection_comment TEXT NULL,
  issued_at TIMESTAMPTZ NULL,
  issued_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  posted_at TIMESTAMPTZ NULL,
  posted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  voided_at TIMESTAMPTZ NULL,
  voided_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, module_code, document_no)
);

CREATE INDEX IF NOT EXISTS idx_operational_documents_org_module_status
  ON operational_documents(organization_id, module_code, status, document_date DESC);
CREATE INDEX IF NOT EXISTS idx_operational_documents_partner
  ON operational_documents(organization_id, counterparty_partner_id);
CREATE INDEX IF NOT EXISTS idx_operational_documents_employee
  ON operational_documents(organization_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_operational_documents_workflow
  ON operational_documents(organization_id, workflow_document_id)
  WHERE workflow_document_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS operational_document_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES operational_documents(id) ON DELETE CASCADE,
  line_no INT NOT NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
  unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  account_id UUID NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  item_id UUID NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  tax_code_id UUID NULL REFERENCES tax_codes(id) ON DELETE RESTRICT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_operational_document_lines_document
  ON operational_document_lines(document_id, line_no);
