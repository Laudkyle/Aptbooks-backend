BEGIN;

CREATE TABLE IF NOT EXISTS tax_code_components (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_tax_code_id UUID NOT NULL REFERENCES tax_codes(id) ON DELETE CASCADE,
  component_tax_code_id UUID NOT NULL REFERENCES tax_codes(id) ON DELETE RESTRICT,
  sequence_no INTEGER NOT NULL DEFAULT 1,
  rate_override NUMERIC(9,6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (parent_tax_code_id, component_tax_code_id),
  CHECK (parent_tax_code_id <> component_tax_code_id)
);

CREATE INDEX IF NOT EXISTS idx_tax_code_components_parent
  ON tax_code_components(organization_id, parent_tax_code_id, sequence_no);

CREATE TABLE IF NOT EXISTS invoice_line_tax_details (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  line_id UUID NOT NULL REFERENCES invoice_lines(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL DEFAULT 1,
  source_tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  taxable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(9,6) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_type TEXT,
  direction TEXT,
  box_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (line_id, sequence_no)
);

CREATE TABLE IF NOT EXISTS bill_line_tax_details (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  line_id UUID NOT NULL REFERENCES bill_lines(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL DEFAULT 1,
  source_tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  taxable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(9,6) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_type TEXT,
  direction TEXT,
  box_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (line_id, sequence_no)
);

CREATE TABLE IF NOT EXISTS credit_note_line_tax_details (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  line_id UUID NOT NULL REFERENCES credit_note_lines(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL DEFAULT 1,
  source_tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  taxable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(9,6) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_type TEXT,
  direction TEXT,
  box_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (line_id, sequence_no)
);

CREATE TABLE IF NOT EXISTS debit_note_line_tax_details (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  line_id UUID NOT NULL REFERENCES debit_note_lines(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL DEFAULT 1,
  source_tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  taxable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(9,6) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_type TEXT,
  direction TEXT,
  box_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (line_id, sequence_no)
);

CREATE TABLE IF NOT EXISTS operational_doc_line_tax_details (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  line_id UUID NOT NULL REFERENCES operational_document_lines(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL DEFAULT 1,
  source_tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  taxable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(9,6) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_type TEXT,
  direction TEXT,
  box_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (line_id, sequence_no)
);

INSERT INTO invoice_line_tax_details(line_id, sequence_no, source_tax_code_id, tax_code_id, taxable_amount, tax_rate, tax_amount, tax_type, direction, box_code)
SELECT il.id, 1, il.tax_code_id, il.tax_code_id, COALESCE(il.line_total,0), COALESCE(tc.rate,0), COALESCE(il.tax_amount,0), tc.tax_type, tc.direction, tc.box_code
FROM invoice_lines il
LEFT JOIN tax_codes tc ON tc.id = il.tax_code_id
WHERE il.tax_code_id IS NOT NULL AND COALESCE(il.tax_amount,0) <> 0
  AND NOT EXISTS (SELECT 1 FROM invoice_line_tax_details d WHERE d.line_id = il.id);

INSERT INTO bill_line_tax_details(line_id, sequence_no, source_tax_code_id, tax_code_id, taxable_amount, tax_rate, tax_amount, tax_type, direction, box_code)
SELECT bl.id, 1, bl.tax_code_id, bl.tax_code_id, COALESCE(bl.line_total,0), COALESCE(tc.rate,0), COALESCE(bl.tax_amount,0), tc.tax_type, tc.direction, tc.box_code
FROM bill_lines bl
LEFT JOIN tax_codes tc ON tc.id = bl.tax_code_id
WHERE bl.tax_code_id IS NOT NULL AND COALESCE(bl.tax_amount,0) <> 0
  AND NOT EXISTS (SELECT 1 FROM bill_line_tax_details d WHERE d.line_id = bl.id);

INSERT INTO credit_note_line_tax_details(line_id, sequence_no, source_tax_code_id, tax_code_id, taxable_amount, tax_rate, tax_amount, tax_type, direction, box_code)
SELECT cnl.id, 1, cnl.tax_code_id, cnl.tax_code_id, COALESCE(cnl.line_total,0), COALESCE(tc.rate,0), COALESCE(cnl.tax_amount,0), tc.tax_type, tc.direction, tc.box_code
FROM credit_note_lines cnl
LEFT JOIN tax_codes tc ON tc.id = cnl.tax_code_id
WHERE cnl.tax_code_id IS NOT NULL AND COALESCE(cnl.tax_amount,0) <> 0
  AND NOT EXISTS (SELECT 1 FROM credit_note_line_tax_details d WHERE d.line_id = cnl.id);

INSERT INTO debit_note_line_tax_details(line_id, sequence_no, source_tax_code_id, tax_code_id, taxable_amount, tax_rate, tax_amount, tax_type, direction, box_code)
SELECT dnl.id, 1, dnl.tax_code_id, dnl.tax_code_id, COALESCE(dnl.line_total,0), COALESCE(tc.rate,0), COALESCE(dnl.tax_amount,0), tc.tax_type, tc.direction, tc.box_code
FROM debit_note_lines dnl
LEFT JOIN tax_codes tc ON tc.id = dnl.tax_code_id
WHERE dnl.tax_code_id IS NOT NULL AND COALESCE(dnl.tax_amount,0) <> 0
  AND NOT EXISTS (SELECT 1 FROM debit_note_line_tax_details d WHERE d.line_id = dnl.id);

INSERT INTO operational_doc_line_tax_details(line_id, sequence_no, source_tax_code_id, tax_code_id, taxable_amount, tax_rate, tax_amount, tax_type, direction, box_code)
SELECT odl.id, 1, odl.tax_code_id, odl.tax_code_id,
       COALESCE(odl.taxable_amount, GREATEST(COALESCE(odl.line_total,0) - COALESCE(odl.tax_amount,0), 0)),
       COALESCE(tc.rate,0), COALESCE(odl.tax_amount,0), tc.tax_type, tc.direction, tc.box_code
FROM operational_document_lines odl
LEFT JOIN tax_codes tc ON tc.id = odl.tax_code_id
WHERE odl.tax_code_id IS NOT NULL AND COALESCE(odl.tax_amount,0) <> 0
  AND NOT EXISTS (SELECT 1 FROM operational_doc_line_tax_details d WHERE d.line_id = odl.id);

INSERT INTO permissions(code, description) VALUES
  ('tax.component.read', 'Read tax code components'),
  ('tax.component.manage', 'Manage tax code components')
ON CONFLICT (code) DO NOTHING;

COMMIT;
