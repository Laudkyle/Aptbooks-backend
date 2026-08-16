BEGIN;

-- GRA-1: Canonical rate semantics, reusable catalog tax profiles and a tax subledger.
-- Tax rates are percentage points throughout AptBooks: 15.000000 = 15%.
COMMENT ON COLUMN tax_codes.rate IS 'Percentage-point rate. Example: 15.000000 means 15 percent; calculations divide by 100.';
COMMENT ON COLUMN tax_code_components.rate_override IS 'Percentage-point rate override. Example: 2.500000 means 2.5 percent.';

ALTER TABLE tax_rules ADD COLUMN IF NOT EXISTS rule_group TEXT;
COMMENT ON COLUMN tax_rules.rule_group IS 'Tax determination stacking family. At most one matching rule is selected per group; different groups may stack.';

CREATE TABLE IF NOT EXISTS tax_catalog_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  supply_type TEXT NOT NULL DEFAULT 'goods'
    CHECK (supply_type IN ('goods','services','mixed','import','export')),
  tax_category TEXT,
  sales_tax_scope TEXT NOT NULL DEFAULT 'taxable'
    CHECK (sales_tax_scope IN ('taxable','zero_rated','exempt','out_of_scope','reverse_charge','import','export','non_recoverable')),
  purchase_tax_scope TEXT NOT NULL DEFAULT 'taxable'
    CHECK (purchase_tax_scope IN ('taxable','zero_rated','exempt','out_of_scope','reverse_charge','import','export','non_recoverable')),
  sales_tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  purchase_tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  exemption_reason_code TEXT,
  exemption_reason TEXT,
  hs_code TEXT,
  fiscal_classification_code TEXT,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_tax_catalog_profiles_org_active
  ON tax_catalog_profiles(organization_id, status, effective_from, effective_to);

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS tax_profile_id UUID REFERENCES tax_catalog_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_items_tax_profile
  ON inventory_items(organization_id, tax_profile_id)
  WHERE tax_profile_id IS NOT NULL;

ALTER TABLE tax_partner_profiles
  ADD COLUMN IF NOT EXISTS residency_status TEXT,
  ADD COLUMN IF NOT EXISTS economic_activity_code TEXT;

CREATE TABLE IF NOT EXISTS pos_return_line_taxes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  return_id UUID NOT NULL REFERENCES pos_return_authorizations(id) ON DELETE CASCADE,
  return_line_id UUID NOT NULL REFERENCES pos_return_lines(id) ON DELETE CASCADE,
  sale_line_tax_id UUID NOT NULL REFERENCES pos_sale_line_taxes(id) ON DELETE RESTRICT,
  source_tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  tax_code TEXT,
  tax_name TEXT,
  rate NUMERIC(9,6) NOT NULL DEFAULT 0,
  taxable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_type TEXT,
  tax_scope TEXT,
  direction TEXT NOT NULL DEFAULT 'output',
  box_code TEXT,
  reporting_group TEXT,
  category_code TEXT,
  exemption_reason_code TEXT,
  reverse_charge BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, return_line_id, sale_line_tax_id)
);

CREATE INDEX IF NOT EXISTS idx_pos_return_line_taxes_return
  ON pos_return_line_taxes(organization_id, return_id, return_line_id);

CREATE TABLE IF NOT EXISTS tax_ledger_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  source_line_id UUID,
  source_tax_detail_id UUID NOT NULL,
  document_no TEXT,
  document_date DATE NOT NULL,
  partner_id UUID REFERENCES business_partners(id) ON DELETE SET NULL,
  line_no INTEGER,
  description TEXT,
  source_tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  source_rule_id UUID REFERENCES tax_rules(id) ON DELETE SET NULL,
  tax_type TEXT,
  tax_scope TEXT,
  direction TEXT,
  box_code TEXT,
  category_code TEXT,
  taxable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(9,6) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  recoverable_percent NUMERIC(7,4) NOT NULL DEFAULT 1,
  recoverable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  nonrecoverable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  exemption_reason_code TEXT,
  reverse_charge BOOLEAN NOT NULL DEFAULT FALSE,
  sign_factor SMALLINT NOT NULL DEFAULT 1 CHECK (sign_factor IN (-1,1)),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, source_type, source_tax_detail_id)
);

CREATE INDEX IF NOT EXISTS idx_tax_ledger_entries_org_date
  ON tax_ledger_entries(organization_id, document_date, source_type);
CREATE INDEX IF NOT EXISTS idx_tax_ledger_entries_org_tax
  ON tax_ledger_entries(organization_id, tax_type, direction, box_code, document_date);
CREATE INDEX IF NOT EXISTS idx_tax_ledger_entries_source
  ON tax_ledger_entries(organization_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_tax_ledger_entries_code
  ON tax_ledger_entries(organization_id, tax_code_id, document_date);

COMMENT ON TABLE tax_ledger_entries IS
  'Canonical tax subledger. Tax amounts/classification come from this table; operational documents control whether an entry is reportable by status.';

-- Existing invoice tax detail backfill. Zero-rated/exempt rows are intentionally retained.
INSERT INTO tax_ledger_entries(
  organization_id, source_type, source_id, source_line_id, source_tax_detail_id,
  document_no, document_date, partner_id, line_no, description,
  source_tax_code_id, tax_code_id, source_rule_id, tax_type, tax_scope, direction, box_code, category_code,
  taxable_amount, tax_rate, tax_amount, recoverable_percent, recoverable_amount, nonrecoverable_amount,
  exemption_reason_code, reverse_charge, sign_factor, metadata
)
SELECT i.organization_id, 'invoice', i.id, il.id, d.id,
       i.invoice_no, i.invoice_date, i.customer_id, il.line_no, il.description,
       d.source_tax_code_id, d.tax_code_id, d.source_rule_id,
       COALESCE(d.tax_type,tc.tax_type), COALESCE(d.tax_scope,tc.tax_scope), CASE WHEN COALESCE(d.direction,tc.direction)='both' THEN 'output' ELSE COALESCE(d.direction,tc.direction,'output') END,
       COALESCE(d.box_code,tc.box_code), d.category_code,
       d.taxable_amount, d.tax_rate, d.tax_amount, COALESCE(d.recoverable_percent,1),
       CASE WHEN COALESCE(d.direction,tc.direction)='input' THEN ROUND(d.tax_amount * COALESCE(d.recoverable_percent,1),2) ELSE 0 END,
       CASE WHEN COALESCE(d.direction,tc.direction)='input' THEN ROUND(d.tax_amount * (1-COALESCE(d.recoverable_percent,1)),2) ELSE 0 END,
       d.exemption_reason_code, COALESCE(d.reverse_charge,false), 1, COALESCE(d.metadata,'{}'::jsonb)
  FROM invoice_line_tax_details d
  JOIN invoice_lines il ON il.id=d.line_id
  JOIN invoices i ON i.id=il.invoice_id
  LEFT JOIN tax_codes tc ON tc.id=d.tax_code_id
ON CONFLICT (organization_id, source_type, source_tax_detail_id) DO NOTHING;

INSERT INTO tax_ledger_entries(
  organization_id, source_type, source_id, source_line_id, source_tax_detail_id,
  document_no, document_date, partner_id, line_no, description,
  source_tax_code_id, tax_code_id, source_rule_id, tax_type, tax_scope, direction, box_code, category_code,
  taxable_amount, tax_rate, tax_amount, recoverable_percent, recoverable_amount, nonrecoverable_amount,
  exemption_reason_code, reverse_charge, sign_factor, metadata
)
SELECT b.organization_id, 'bill', b.id, bl.id, d.id,
       b.bill_no, b.bill_date, b.vendor_id, bl.line_no, bl.description,
       d.source_tax_code_id, d.tax_code_id, d.source_rule_id,
       COALESCE(d.tax_type,tc.tax_type), COALESCE(d.tax_scope,tc.tax_scope), CASE WHEN COALESCE(d.direction,tc.direction)='both' THEN 'input' ELSE COALESCE(d.direction,tc.direction,'input') END,
       COALESCE(d.box_code,tc.box_code), d.category_code,
       d.taxable_amount, d.tax_rate, d.tax_amount, COALESCE(d.recoverable_percent,1),
       CASE WHEN COALESCE(d.direction,tc.direction,'input') IN ('input','both') THEN ROUND(d.tax_amount * COALESCE(d.recoverable_percent,1),2) ELSE 0 END,
       CASE WHEN COALESCE(d.direction,tc.direction,'input') IN ('input','both') THEN ROUND(d.tax_amount * (1-COALESCE(d.recoverable_percent,1)),2) ELSE 0 END,
       d.exemption_reason_code, COALESCE(d.reverse_charge,false), 1, COALESCE(d.metadata,'{}'::jsonb)
  FROM bill_line_tax_details d
  JOIN bill_lines bl ON bl.id=d.line_id
  JOIN bills b ON b.id=bl.bill_id
  LEFT JOIN tax_codes tc ON tc.id=d.tax_code_id
ON CONFLICT (organization_id, source_type, source_tax_detail_id) DO NOTHING;

INSERT INTO tax_ledger_entries(
  organization_id, source_type, source_id, source_line_id, source_tax_detail_id,
  document_no, document_date, partner_id, line_no, description,
  source_tax_code_id, tax_code_id, source_rule_id, tax_type, tax_scope, direction, box_code, category_code,
  taxable_amount, tax_rate, tax_amount, recoverable_percent, recoverable_amount, nonrecoverable_amount,
  exemption_reason_code, reverse_charge, sign_factor, metadata
)
SELECT cn.organization_id, 'credit_note', cn.id, cnl.id, d.id,
       cn.credit_note_no, cn.credit_note_date, cn.customer_id, cnl.line_no, cnl.description,
       d.source_tax_code_id, d.tax_code_id, d.source_rule_id,
       COALESCE(d.tax_type,tc.tax_type), COALESCE(d.tax_scope,tc.tax_scope), CASE WHEN COALESCE(d.direction,tc.direction)='both' THEN 'output' ELSE COALESCE(d.direction,tc.direction,'output') END,
       COALESCE(d.box_code,tc.box_code), d.category_code,
       d.taxable_amount, d.tax_rate, d.tax_amount, COALESCE(d.recoverable_percent,1),
       0, 0, d.exemption_reason_code, COALESCE(d.reverse_charge,false), -1, COALESCE(d.metadata,'{}'::jsonb)
  FROM credit_note_line_tax_details d
  JOIN credit_note_lines cnl ON cnl.id=d.line_id
  JOIN credit_notes cn ON cn.id=cnl.credit_note_id
  LEFT JOIN tax_codes tc ON tc.id=d.tax_code_id
ON CONFLICT (organization_id, source_type, source_tax_detail_id) DO NOTHING;

INSERT INTO tax_ledger_entries(
  organization_id, source_type, source_id, source_line_id, source_tax_detail_id,
  document_no, document_date, partner_id, line_no, description,
  source_tax_code_id, tax_code_id, source_rule_id, tax_type, tax_scope, direction, box_code, category_code,
  taxable_amount, tax_rate, tax_amount, recoverable_percent, recoverable_amount, nonrecoverable_amount,
  exemption_reason_code, reverse_charge, sign_factor, metadata
)
SELECT dn.organization_id, 'debit_note', dn.id, dnl.id, d.id,
       dn.debit_note_no, dn.debit_note_date, dn.vendor_id, dnl.line_no, dnl.description,
       d.source_tax_code_id, d.tax_code_id, d.source_rule_id,
       COALESCE(d.tax_type,tc.tax_type), COALESCE(d.tax_scope,tc.tax_scope), CASE WHEN COALESCE(d.direction,tc.direction)='both' THEN 'input' ELSE COALESCE(d.direction,tc.direction,'input') END,
       COALESCE(d.box_code,tc.box_code), d.category_code,
       d.taxable_amount, d.tax_rate, d.tax_amount, COALESCE(d.recoverable_percent,1),
       CASE WHEN COALESCE(d.direction,tc.direction,'input') IN ('input','both') THEN ROUND(d.tax_amount * COALESCE(d.recoverable_percent,1),2) ELSE 0 END,
       CASE WHEN COALESCE(d.direction,tc.direction,'input') IN ('input','both') THEN ROUND(d.tax_amount * (1-COALESCE(d.recoverable_percent,1)),2) ELSE 0 END,
       d.exemption_reason_code, COALESCE(d.reverse_charge,false), -1, COALESCE(d.metadata,'{}'::jsonb)
  FROM debit_note_line_tax_details d
  JOIN debit_note_lines dnl ON dnl.id=d.line_id
  JOIN debit_notes dn ON dn.id=dnl.debit_note_id
  LEFT JOIN tax_codes tc ON tc.id=d.tax_code_id
ON CONFLICT (organization_id, source_type, source_tax_detail_id) DO NOTHING;

INSERT INTO tax_ledger_entries(
  organization_id, source_type, source_id, source_line_id, source_tax_detail_id,
  document_no, document_date, partner_id, line_no, description,
  source_tax_code_id, tax_code_id, source_rule_id, tax_type, tax_scope, direction, box_code, category_code,
  taxable_amount, tax_rate, tax_amount, recoverable_percent, recoverable_amount, nonrecoverable_amount,
  exemption_reason_code, reverse_charge, sign_factor, metadata
)
SELECT od.organization_id, od.module_code, od.id, odl.id, d.id,
       od.document_no, od.document_date, od.counterparty_partner_id, odl.line_no, odl.description,
       d.source_tax_code_id, d.tax_code_id, d.source_rule_id,
       COALESCE(d.tax_type,tc.tax_type), COALESCE(d.tax_scope,tc.tax_scope),
       CASE WHEN od.module_code='return' AND COALESCE(od.meta->>'returnType','')='sales_return' THEN 'output'
            WHEN od.module_code='return' AND COALESCE(od.meta->>'returnType','')='purchase_return' THEN 'input'
            ELSE CASE WHEN COALESCE(d.direction,tc.direction)='both' THEN 'input' ELSE COALESCE(d.direction,tc.direction,'input') END END,
       COALESCE(d.box_code,tc.box_code), d.category_code,
       d.taxable_amount, d.tax_rate, d.tax_amount, COALESCE(d.recoverable_percent,1),
       CASE WHEN (CASE WHEN od.module_code='return' AND COALESCE(od.meta->>'returnType','')='sales_return' THEN 'output'
                       WHEN od.module_code='return' AND COALESCE(od.meta->>'returnType','')='purchase_return' THEN 'input'
                       ELSE CASE WHEN COALESCE(d.direction,tc.direction)='both' THEN 'input' ELSE COALESCE(d.direction,tc.direction,'input') END END)='input'
            THEN ROUND(d.tax_amount * COALESCE(d.recoverable_percent,1),2) ELSE 0 END,
       CASE WHEN (CASE WHEN od.module_code='return' AND COALESCE(od.meta->>'returnType','')='sales_return' THEN 'output'
                       WHEN od.module_code='return' AND COALESCE(od.meta->>'returnType','')='purchase_return' THEN 'input'
                       ELSE CASE WHEN COALESCE(d.direction,tc.direction)='both' THEN 'input' ELSE COALESCE(d.direction,tc.direction,'input') END END)='input'
            THEN ROUND(d.tax_amount * (1-COALESCE(d.recoverable_percent,1)),2) ELSE 0 END,
       d.exemption_reason_code, COALESCE(d.reverse_charge,false),
       CASE WHEN od.module_code='return' AND COALESCE(od.meta->>'returnType','') IN ('sales_return','purchase_return') THEN -1 ELSE 1 END,
       COALESCE(d.metadata,'{}'::jsonb)
  FROM operational_doc_line_tax_details d
  JOIN operational_document_lines odl ON odl.id=d.line_id
  JOIN operational_documents od ON od.id=odl.document_id
  LEFT JOIN tax_codes tc ON tc.id=d.tax_code_id
ON CONFLICT (organization_id, source_type, source_tax_detail_id) DO NOTHING;

INSERT INTO tax_ledger_entries(
  organization_id, source_type, source_id, source_line_id, source_tax_detail_id,
  document_no, document_date, partner_id, line_no, description,
  source_tax_code_id, tax_code_id, tax_type, tax_scope, direction, box_code,
  taxable_amount, tax_rate, tax_amount, recoverable_percent, recoverable_amount, nonrecoverable_amount,
  reverse_charge, sign_factor, metadata
)
SELECT s.organization_id, 'pos_sale', s.id, l.id, t.id,
       s.sale_no, s.sale_date, s.customer_id, l.line_no, l.description,
       t.source_tax_code_id, t.tax_code_id, COALESCE(t.tax_type,tc.tax_type), COALESCE(tc.tax_scope,'taxable'),
       CASE WHEN COALESCE(tc.direction,'output')='both' THEN 'output' ELSE COALESCE(tc.direction,'output') END, COALESCE(t.box_code,tc.box_code),
       t.taxable_amount, t.rate, t.tax_amount, 0, 0, 0, COALESCE(tc.reverse_charge,false), 1,
       jsonb_build_object('reportingGroup', t.reporting_group)
  FROM pos_sale_line_taxes t
  JOIN pos_sale_lines l ON l.id=t.sale_line_id
  JOIN pos_sales s ON s.id=t.sale_id
  LEFT JOIN tax_codes tc ON tc.id=t.tax_code_id
ON CONFLICT (organization_id, source_type, source_tax_detail_id) DO NOTHING;

-- Preserve tax consequences of already-received POS returns as explicit negative subledger entries.
INSERT INTO pos_return_line_taxes(
  organization_id, return_id, return_line_id, sale_line_tax_id,
  source_tax_code_id, tax_code_id, tax_code, tax_name, rate,
  taxable_amount, tax_amount, tax_type, tax_scope, direction, box_code,
  reporting_group, category_code, exemption_reason_code, reverse_charge, metadata
)
SELECT r.organization_id, r.id, rl.id, st.id,
       st.source_tax_code_id, st.tax_code_id, st.tax_code, st.tax_name, st.rate,
       ROUND(st.taxable_amount * (rl.quantity / NULLIF(sl.quantity,0)),2),
       ROUND(st.tax_amount * (rl.quantity / NULLIF(sl.quantity,0)),2),
       COALESCE(st.tax_type,tc.tax_type), COALESCE(tc.tax_scope,'taxable'), CASE WHEN COALESCE(tc.direction,'output')='both' THEN 'output' ELSE COALESCE(tc.direction,'output') END,
       COALESCE(st.box_code,tc.box_code), st.reporting_group, tc.category_code, NULL,
       COALESCE(tc.reverse_charge,false), jsonb_build_object('backfilled',true)
  FROM pos_return_authorizations r
  JOIN pos_return_lines rl ON rl.return_id=r.id
  JOIN pos_sale_lines sl ON sl.id=rl.sale_line_id
  JOIN pos_sale_line_taxes st ON st.sale_line_id=sl.id
  LEFT JOIN tax_codes tc ON tc.id=st.tax_code_id
 WHERE r.status='received'
ON CONFLICT (organization_id, return_line_id, sale_line_tax_id) DO NOTHING;

INSERT INTO tax_ledger_entries(
  organization_id, source_type, source_id, source_line_id, source_tax_detail_id,
  document_no, document_date, partner_id, line_no, description,
  source_tax_code_id, tax_code_id, tax_type, tax_scope, direction, box_code, category_code,
  taxable_amount, tax_rate, tax_amount, recoverable_percent, recoverable_amount, nonrecoverable_amount,
  exemption_reason_code, reverse_charge, sign_factor, metadata
)
SELECT r.organization_id, 'pos_return', r.id, rl.id, rt.id,
       r.return_no, COALESCE(r.received_at::date,r.created_at::date), s.customer_id, sl.line_no, sl.description,
       rt.source_tax_code_id, rt.tax_code_id, rt.tax_type, rt.tax_scope, rt.direction, rt.box_code, rt.category_code,
       rt.taxable_amount, rt.rate, rt.tax_amount, 0, 0, 0,
       rt.exemption_reason_code, rt.reverse_charge, -1,
       rt.metadata || jsonb_build_object('reportingGroup',rt.reporting_group,'saleId',s.id)
  FROM pos_return_line_taxes rt
  JOIN pos_return_lines rl ON rl.id=rt.return_line_id
  JOIN pos_return_authorizations r ON r.id=rt.return_id
  JOIN pos_sales s ON s.id=r.sale_id
  LEFT JOIN pos_sale_lines sl ON sl.id=rl.sale_line_id
 WHERE r.status='received'
ON CONFLICT (organization_id, source_type, source_tax_detail_id) DO NOTHING;

INSERT INTO tax_ledger_entries(
  organization_id, source_type, source_id, source_line_id, source_tax_detail_id,
  document_no, document_date, line_no, description,
  tax_type, direction, box_code, taxable_amount, tax_rate, tax_amount,
  recoverable_percent, recoverable_amount, nonrecoverable_amount, sign_factor, metadata
)
SELECT ta.organization_id, 'tax_adjustment' , ta.id, ta.id, ta.id,
       CONCAT('TAX-ADJ-',LEFT(ta.id::text,8)), ta.adjustment_date, 1, ta.description,
       ta.tax_type, ta.direction, ta.box_code, 0, 0, ABS(ta.amount),
       CASE WHEN ta.direction='input' THEN 1 ELSE 0 END,
       CASE WHEN ta.direction='input' THEN ABS(ta.amount) ELSE 0 END,
       0,
       CASE WHEN ta.amount < 0 THEN -1 ELSE 1 END,
       jsonb_build_object('reference',ta.reference)
  FROM tax_adjustments ta
 WHERE ta.status='posted'
ON CONFLICT (organization_id, source_type, source_tax_detail_id) DO NOTHING;

-- Harden the Ghana pack so the new rule engine can stack distinct statutory tax
-- families while still choosing only one rule within a family.
UPDATE tax_country_packs p
SET version_no='2026.1.1',
    metadata = jsonb_set(
      jsonb_set(
        p.metadata,
        '{taxRules}',
        COALESCE((
          SELECT jsonb_agg(
            CASE
              WHEN e->>'code'='GH_RULE_EXEMPT_SUPPLIES' THEN
                e || '{"ruleGroup":"VAT"}'::jsonb || jsonb_build_object(
                  'conditions', COALESCE(e->'conditions','{}'::jsonb) || '{"taxCategory":"exempt"}'::jsonb
                )
              WHEN e->>'taxCode'='GH_VAT_EFFECTIVE_20' THEN
                e || '{"ruleGroup":"VAT"}'::jsonb || jsonb_build_object(
                  'conditions', COALESCE(e->'conditions','{}'::jsonb) || '{"taxCategory":{"notIn":["exempt","zero_rated"]}}'::jsonb
                )
              WHEN e->>'taxCode' IN ('GH_VAT_ZERO_0','GH_VAT_EXEMPT_0') THEN e || '{"ruleGroup":"VAT"}'::jsonb
              WHEN e->>'taxCode'='GH_CST_5' THEN e || '{"ruleGroup":"CST"}'::jsonb
              WHEN e->>'taxCode'='GH_TOURISM_LEVY_1' THEN e || '{"ruleGroup":"TOURISM"}'::jsonb
              WHEN COALESCE(e->>'taxCode','') LIKE 'GH_WHT_%' THEN e || '{"ruleGroup":"WITHHOLDING"}'::jsonb
              WHEN e->>'taxCode' IN ('GH_VAT_IMPORT_20','GH_IMPORT_DUTY_CONFIG') THEN e || '{"ruleGroup":"IMPORT"}'::jsonb
              WHEN e->>'taxCode'='GH_EXCISE_CONFIG' THEN e || '{"ruleGroup":"EXCISE"}'::jsonb
              ELSE e
            END
          )
          FROM jsonb_array_elements(COALESCE(p.metadata->'taxRules','[]'::jsonb)) e
        ), '[]'::jsonb),
        true
      ),
      '{catalogProfiles}',
      '[
        {"code":"GH_STANDARD_GOODS","name":"Ghana standard-rated goods","supplyType":"goods","taxCategory":"standard","salesTaxScope":"taxable","purchaseTaxScope":"taxable","salesTaxCode":"GH_VAT_EFFECTIVE_20","purchaseTaxCode":"GH_VAT_EFFECTIVE_20","effectiveFrom":"2026-01-01"},
        {"code":"GH_STANDARD_SERVICES","name":"Ghana standard-rated services","supplyType":"services","taxCategory":"standard","salesTaxScope":"taxable","purchaseTaxScope":"taxable","salesTaxCode":"GH_VAT_EFFECTIVE_20","purchaseTaxCode":"GH_VAT_EFFECTIVE_20","effectiveFrom":"2026-01-01"},
        {"code":"GH_EXEMPT_SUPPLY","name":"Ghana exempt supply","supplyType":"services","taxCategory":"exempt","salesTaxScope":"exempt","purchaseTaxScope":"exempt","salesTaxCode":"GH_VAT_EXEMPT_0","purchaseTaxCode":"GH_VAT_EXEMPT_0","exemptionReasonCode":"GH_EXEMPT","exemptionReason":"Supply classified as exempt; retain the item/service legal basis in the profile or transaction metadata.","effectiveFrom":"2026-01-01"},
        {"code":"GH_ZERO_RATED_EXPORT","name":"Ghana zero-rated export","supplyType":"export","taxCategory":"zero_rated","salesTaxScope":"zero_rated","purchaseTaxScope":"out_of_scope","salesTaxCode":"GH_VAT_ZERO_0","effectiveFrom":"2026-01-01"}
      ]'::jsonb,
      true
    )
WHERE p.organization_id IS NULL AND p.pack_code='GH-TAX-2026-COMPLETE';

-- Bring already-installed Ghana rules onto the same grouping/condition semantics.
UPDATE tax_rules tr
SET rule_group = CASE
      WHEN tc.tax_type='VAT' THEN 'VAT'
      WHEN tc.tax_type='WITHHOLDING' THEN 'WITHHOLDING'
      WHEN tc.tax_type='IMPORT' THEN 'IMPORT'
      ELSE COALESCE(tc.reporting_group,tc.tax_type,tr.rule_group)
    END,
    conditions = CASE
      WHEN tr.code='GH_RULE_EXEMPT_SUPPLIES'
        THEN COALESCE(tr.conditions,'{}'::jsonb) || '{"taxCategory":"exempt"}'::jsonb
      WHEN tc.code='GH_VAT_EFFECTIVE_20'
        THEN COALESCE(tr.conditions,'{}'::jsonb) || '{"taxCategory":{"notIn":["exempt","zero_rated"]}}'::jsonb
      ELSE tr.conditions
    END,
    updated_at=NOW()
FROM tax_codes tc
WHERE tc.id=tr.tax_code_id AND tc.organization_id=tr.organization_id;

-- Seed reusable Ghana catalog profiles for organizations that have already
-- installed the Ghana 2026 pack. These are defaults, not item assignments.
WITH gh_orgs AS (
  SELECT DISTINCT i.organization_id
    FROM tax_country_pack_installs i
    JOIN tax_country_packs p ON p.id=i.pack_id
   WHERE p.pack_code='GH-TAX-2026-COMPLETE'
), std AS (
  SELECT g.organization_id, tc.id AS tax_code_id
    FROM gh_orgs g
    JOIN tax_codes tc ON tc.organization_id=g.organization_id AND tc.code='GH_VAT_EFFECTIVE_20'
)
INSERT INTO tax_catalog_profiles(
  organization_id, code, name, supply_type, tax_category,
  sales_tax_scope, purchase_tax_scope, sales_tax_code_id, purchase_tax_code_id,
  effective_from, status, metadata
)
SELECT organization_id, v.code, v.name, v.supply_type, 'standard',
       'taxable','taxable',tax_code_id,tax_code_id,'2026-01-01','active',
       jsonb_build_object('installedFromPack','GH-TAX-2026-COMPLETE')
  FROM std
  CROSS JOIN (VALUES
    ('GH_STANDARD_GOODS','Ghana standard-rated goods','goods'),
    ('GH_STANDARD_SERVICES','Ghana standard-rated services','services')
  ) AS v(code,name,supply_type)
ON CONFLICT (organization_id, code) DO NOTHING;

WITH gh_orgs AS (
  SELECT DISTINCT i.organization_id
    FROM tax_country_pack_installs i
    JOIN tax_country_packs p ON p.id=i.pack_id
   WHERE p.pack_code='GH-TAX-2026-COMPLETE'
), exempt AS (
  SELECT g.organization_id, tc.id AS tax_code_id
    FROM gh_orgs g
    JOIN tax_codes tc ON tc.organization_id=g.organization_id AND tc.code='GH_VAT_EXEMPT_0'
)
INSERT INTO tax_catalog_profiles(
  organization_id, code, name, supply_type, tax_category,
  sales_tax_scope, purchase_tax_scope, sales_tax_code_id, purchase_tax_code_id,
  exemption_reason_code, exemption_reason, effective_from, status, metadata
)
SELECT organization_id,'GH_EXEMPT_SUPPLY','Ghana exempt supply','services','exempt',
       'exempt','exempt',tax_code_id,tax_code_id,'GH_EXEMPT',
       'Supply classified as exempt; retain the item/service legal basis in the profile or transaction metadata.',
       '2026-01-01','active',jsonb_build_object('installedFromPack','GH-TAX-2026-COMPLETE')
  FROM exempt
ON CONFLICT (organization_id, code) DO NOTHING;

WITH gh_orgs AS (
  SELECT DISTINCT i.organization_id
    FROM tax_country_pack_installs i
    JOIN tax_country_packs p ON p.id=i.pack_id
   WHERE p.pack_code='GH-TAX-2026-COMPLETE'
), zr AS (
  SELECT g.organization_id, tc.id AS tax_code_id
    FROM gh_orgs g
    JOIN tax_codes tc ON tc.organization_id=g.organization_id AND tc.code='GH_VAT_ZERO_0'
)
INSERT INTO tax_catalog_profiles(
  organization_id, code, name, supply_type, tax_category,
  sales_tax_scope, purchase_tax_scope, sales_tax_code_id, purchase_tax_code_id,
  effective_from, status, metadata
)
SELECT organization_id,'GH_ZERO_RATED_EXPORT','Ghana zero-rated export','export','zero_rated',
       'zero_rated','out_of_scope',tax_code_id,NULL,'2026-01-01','active',
       jsonb_build_object('installedFromPack','GH-TAX-2026-COMPLETE')
  FROM zr
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO permissions(code, description) VALUES
  ('tax.catalog.read', 'Read reusable tax catalog profiles'),
  ('tax.catalog.manage', 'Manage reusable tax catalog profiles'),
  ('tax.ledger.read', 'Read the canonical tax subledger')
ON CONFLICT (code) DO NOTHING;

COMMIT;
