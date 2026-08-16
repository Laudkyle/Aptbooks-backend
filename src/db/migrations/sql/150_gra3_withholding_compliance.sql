BEGIN;

-- ============================================================
-- GRA Release 3: Income WHT + VAT Withholding (WHVAT)
-- ============================================================

ALTER TABLE tax_settings
  ADD COLUMN IF NOT EXISTS gh_income_wht_agent_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS gh_vat_withholding_agent_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS gh_wht_annual_threshold NUMERIC(18,2) NOT NULL DEFAULT 2000.00,
  ADD COLUMN IF NOT EXISTS gh_vat_withholding_rate NUMERIC(9,6) NOT NULL DEFAULT 7.000000,
  ADD COLUMN IF NOT EXISTS vat_withholding_payable_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vat_withholding_receivable_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL;

ALTER TABLE vendor_payment_allocations
  ADD COLUMN IF NOT EXISTS vat_withholding_basis NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vat_withholding_applied NUMERIC(18,2) NOT NULL DEFAULT 0;

ALTER TABLE vendor_payments
  ADD COLUMN IF NOT EXISTS vat_withholding_total NUMERIC(18,2) NOT NULL DEFAULT 0;

ALTER TABLE tax_partner_profiles
  ADD COLUMN IF NOT EXISTS withholding_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS withholding_exemption_reference TEXT,
  ADD COLUMN IF NOT EXISTS withholding_exemption_expiry DATE,
  ADD COLUMN IF NOT EXISTS default_withholding_category TEXT,
  ADD COLUMN IF NOT EXISTS vat_withholding_eligible BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE tax_codes
  ADD COLUMN IF NOT EXISTS withholding_regime TEXT,
  ADD COLUMN IF NOT EXISTS withholding_treatment TEXT,
  ADD COLUMN IF NOT EXISTS threshold_basis TEXT,
  ADD COLUMN IF NOT EXISTS threshold_amount NUMERIC(18,2);

ALTER TABLE tax_codes DROP CONSTRAINT IF EXISTS tax_codes_withholding_regime_check;
ALTER TABLE tax_codes ADD CONSTRAINT tax_codes_withholding_regime_check
  CHECK (withholding_regime IS NULL OR withholding_regime IN ('income_wht','vat_withholding'));
ALTER TABLE tax_codes DROP CONSTRAINT IF EXISTS tax_codes_withholding_treatment_check;
ALTER TABLE tax_codes ADD CONSTRAINT tax_codes_withholding_treatment_check
  CHECK (withholding_treatment IS NULL OR withholding_treatment IN ('final','creditable'));
ALTER TABLE tax_codes DROP CONSTRAINT IF EXISTS tax_codes_threshold_basis_check;
ALTER TABLE tax_codes ADD CONSTRAINT tax_codes_threshold_basis_check
  CHECK (threshold_basis IS NULL OR threshold_basis IN ('none','annual_cumulative'));

-- Existing Ghana WHT codes become explicitly income-WHT.
UPDATE tax_codes
   SET withholding_regime='income_wht',
       threshold_basis=CASE WHEN code IN ('GH_WHT_GOODS_RES_3','GH_WHT_WORKS_RES_5','GH_WHT_SERVICES_RES_7_5') THEN 'annual_cumulative' ELSE 'none' END,
       threshold_amount=CASE WHEN code IN ('GH_WHT_GOODS_RES_3','GH_WHT_WORKS_RES_5','GH_WHT_SERVICES_RES_7_5') THEN 2000.00 ELSE NULL END,
       withholding_treatment=CASE
         WHEN code IN (
           'GH_WHT_DIVIDENDS_8','GH_WHT_RENT_RESIDENTIAL_8','GH_WHT_RENT_NONRES_15',
           'GH_WHT_DIRECTORS_20','GH_WHT_NONRES_MGT_TECH_20','GH_WHT_NONRES_GOODS_WORKS_SERVICES_20',
           'GH_WHT_NONRES_TELECOM_TRANSPORT_15','GH_WHT_BRANCH_REPATRIATION_8',
           'GH_WHT_INSURANCE_PREMIUMS_5','GH_WHT_PETROLEUM_SUBCONTRACTOR_RES_7_5',
           'GH_WHT_PETROLEUM_SUBCONTRACTOR_NONRES_15'
         ) THEN 'final'
         ELSE 'creditable'
       END
 WHERE tax_type='WITHHOLDING' AND code LIKE 'GH_WHT_%';

-- Additional current Ghana income-WHT categories.
WITH gh AS (
  SELECT organization_id, id AS jurisdiction_id
  FROM tax_jurisdictions
  WHERE country_code='GH'
), seed(code,name,rate,reporting_group,treatment,threshold_basis,threshold_amount,metadata) AS (
  VALUES
    ('GH_WHT_EXAMINERS_TEACHERS_10','WHT Resident Examiners, Invigilators and Part-time Teachers 10%',10.000000,'WHT_COMPENSATION','final','none',NULL::numeric,'{"ghanaCategory":"examiners_teachers"}'::jsonb),
    ('GH_WHT_COMMISSION_AGENTS_10','WHT Resident Individual Commission Agents 10%',10.000000,'WHT_COMMISSION','creditable','none',NULL::numeric,'{"ghanaCategory":"commission_agents"}'::jsonb),
    ('GH_WHT_PRECIOUS_MINERALS_3','WHT Unprocessed Precious Minerals 3%',3.000000,'WHT_MINERALS','creditable','none',NULL::numeric,'{"ghanaCategory":"unprocessed_precious_minerals"}'::jsonb),
    ('GH_WHT_ROYALTY_NATURAL_RESOURCES_15','WHT Royalty and Natural Resource Payments 15%',15.000000,'WHT_ROYALTY','creditable','none',NULL::numeric,'{"ghanaCategory":"royalty_natural_resources"}'::jsonb)
)
INSERT INTO tax_codes(
  organization_id,jurisdiction_id,code,name,tax_type,rate,is_compound,effective_from,status,
  category_code,tax_scope,application_scope,calculation_method,direction,box_code,reporting_group,
  withholding_regime,withholding_treatment,threshold_basis,threshold_amount,metadata
)
SELECT gh.organization_id,gh.jurisdiction_id,s.code,s.name,'WITHHOLDING',s.rate,FALSE,DATE '2026-01-01','active',
       s.reporting_group,'withholding','purchases','withholding','withholding','WHT_PAYABLE',s.reporting_group,
       'income_wht',s.treatment,s.threshold_basis,s.threshold_amount,s.metadata
FROM gh CROSS JOIN seed s
ON CONFLICT (organization_id,code) DO UPDATE SET
  name=EXCLUDED.name,rate=EXCLUDED.rate,reporting_group=EXCLUDED.reporting_group,
  withholding_regime='income_wht',withholding_treatment=EXCLUDED.withholding_treatment,
  threshold_basis=EXCLUDED.threshold_basis,threshold_amount=EXCLUDED.threshold_amount,
  effective_from=EXCLUDED.effective_from,status='active',metadata=tax_codes.metadata || EXCLUDED.metadata;


-- Correct the prior broad rent rule: Ghana distinguishes residential 8% and non-residential 15%.
UPDATE tax_rules tr
SET conditions = COALESCE(tr.conditions,'{}'::jsonb) || '{"category":"rent","rentType":"non_residential"}'::jsonb,
    updated_at=NOW()
FROM tax_codes tc
WHERE tr.organization_id=tc.organization_id
  AND tr.tax_code_id=tc.id
  AND tr.code='GH_RULE_WHT_RENT'
  AND tc.code='GH_WHT_RENT_NONRES_15';

INSERT INTO tax_rules(
  organization_id,code,name,document_type,partner_type,transaction_scope,jurisdiction_id,tax_code_id,
  priority,effective_from,conditions,status,supply_type
)
SELECT tc.organization_id,'GH_RULE_WHT_RENT_RESIDENTIAL','Ghana withholding tax on residential rent',
       'bill','vendor','purchases',tc.jurisdiction_id,tc.id,80,DATE '2026-01-01',
       '{"category":"rent","rentType":"residential"}'::jsonb,'active','services'
FROM tax_codes tc
WHERE tc.code='GH_WHT_RENT_RESIDENTIAL_8'
ON CONFLICT (organization_id,code) WHERE code IS NOT NULL DO UPDATE SET
  name=EXCLUDED.name,tax_code_id=EXCLUDED.tax_code_id,conditions=EXCLUDED.conditions,status='active',updated_at=NOW();

-- VAT Withholding is deliberately a separate withholding regime from income WHT.
INSERT INTO tax_codes(
  organization_id,jurisdiction_id,code,name,tax_type,rate,is_compound,effective_from,status,
  category_code,tax_scope,application_scope,calculation_method,direction,box_code,reporting_group,
  withholding_regime,withholding_treatment,threshold_basis,metadata
)
SELECT tj.organization_id,tj.id,'GH_WHVAT_7','Ghana VAT Withholding 7%','WITHHOLDING',7.000000,FALSE,DATE '2026-01-01','active',
       'WHVAT','withholding','purchases','withholding','withholding','WHVAT_PAYABLE','WHVAT',
       'vat_withholding','creditable','none',
       '{"basis":"standard_rated_taxable_value","certificate":"Withholding VAT Credit Certificate","returnForm":"WHVAT"}'::jsonb
FROM tax_jurisdictions tj
WHERE tj.country_code='GH'
ON CONFLICT (organization_id,code) DO UPDATE SET
  name=EXCLUDED.name,rate=7.000000,withholding_regime='vat_withholding',withholding_treatment='creditable',
  threshold_basis='none',box_code='WHVAT_PAYABLE',reporting_group='WHVAT',status='active',
  metadata=tax_codes.metadata || EXCLUDED.metadata;

CREATE TABLE IF NOT EXISTS ghana_withholding_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  regime TEXT NOT NULL CHECK (regime IN ('income_wht','vat_withholding')),
  direction TEXT NOT NULL CHECK (direction IN ('payable','receivable')),
  partner_id UUID REFERENCES business_partners(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL,
  source_id UUID,
  source_line_id UUID,
  source_document_no TEXT,
  event_date DATE NOT NULL,
  tax_year INTEGER NOT NULL,
  category_code TEXT,
  tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  gross_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  prior_cumulative_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  cumulative_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  threshold_amount NUMERIC(18,2),
  threshold_basis TEXT,
  taxable_basis NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(9,6) NOT NULL DEFAULT 0,
  withheld_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  withholding_treatment TEXT CHECK (withholding_treatment IS NULL OR withholding_treatment IN ('final','creditable')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','remitted','credited','voided')),
  certificate_no TEXT,
  certificate_date DATE,
  remittance_id UUID REFERENCES withholding_remittances(id) ON DELETE SET NULL,
  certificate_id UUID REFERENCES withholding_certificates(id) ON DELETE SET NULL,
  return_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,event_key)
);
CREATE INDEX IF NOT EXISTS idx_ghana_withholding_events_period
  ON ghana_withholding_events(organization_id,regime,event_date,status);
CREATE INDEX IF NOT EXISTS idx_ghana_withholding_events_partner_year
  ON ghana_withholding_events(organization_id,partner_id,tax_year,category_code,regime);

CREATE TABLE IF NOT EXISTS ghana_withholding_returns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  regime TEXT NOT NULL CHECK (regime IN ('income_wht','vat_withholding')),
  form_code TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized','filed','amended','voided')),
  version_no INTEGER NOT NULL DEFAULT 1,
  amends_return_id UUID REFERENCES ghana_withholding_returns(id) ON DELETE SET NULL,
  total_taxable_basis NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_withheld NUMERIC(18,2) NOT NULL DEFAULT 0,
  gra_reference TEXT,
  filed_at TIMESTAMPTZ,
  filed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  finalized_at TIMESTAMPTZ,
  finalized_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (period_end >= period_start),
  UNIQUE (organization_id,regime,period_start,period_end,version_no)
);

CREATE TABLE IF NOT EXISTS ghana_withholding_return_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  return_id UUID NOT NULL REFERENCES ghana_withholding_returns(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES ghana_withholding_events(id) ON DELETE RESTRICT,
  partner_id UUID REFERENCES business_partners(id) ON DELETE SET NULL,
  partner_tax_identifier TEXT,
  source_document_no TEXT,
  event_date DATE NOT NULL,
  category_code TEXT,
  taxable_basis NUMERIC(18,2) NOT NULL,
  tax_rate NUMERIC(9,6) NOT NULL,
  withheld_amount NUMERIC(18,2) NOT NULL,
  certificate_no TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (return_id,event_id)
);

ALTER TABLE ghana_withholding_events
  ADD CONSTRAINT ghana_withholding_events_return_fk
  FOREIGN KEY (return_id) REFERENCES ghana_withholding_returns(id) ON DELETE SET NULL;

ALTER TABLE withholding_remittances
  ADD COLUMN IF NOT EXISTS withholding_regime TEXT NOT NULL DEFAULT 'income_wht',
  ADD COLUMN IF NOT EXISTS due_date DATE,
  ADD COLUMN IF NOT EXISTS gra_reference TEXT;
ALTER TABLE withholding_remittances DROP CONSTRAINT IF EXISTS withholding_remittances_regime_check;
ALTER TABLE withholding_remittances ADD CONSTRAINT withholding_remittances_regime_check
  CHECK (withholding_regime IN ('income_wht','vat_withholding'));

ALTER TABLE withholding_certificates
  ADD COLUMN IF NOT EXISTS withholding_regime TEXT NOT NULL DEFAULT 'income_wht',
  ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES business_partners(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS certificate_role TEXT NOT NULL DEFAULT 'received',
  ADD COLUMN IF NOT EXISTS gra_reference TEXT;
ALTER TABLE withholding_certificates DROP CONSTRAINT IF EXISTS withholding_certificates_regime_check;
ALTER TABLE withholding_certificates ADD CONSTRAINT withholding_certificates_regime_check
  CHECK (withholding_regime IN ('income_wht','vat_withholding'));
ALTER TABLE withholding_certificates DROP CONSTRAINT IF EXISTS withholding_certificates_role_check;
ALTER TABLE withholding_certificates ADD CONSTRAINT withholding_certificates_role_check
  CHECK (certificate_role IN ('issued','received'));


CREATE TABLE IF NOT EXISTS ghana_withholding_certificates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES ghana_withholding_events(id) ON DELETE RESTRICT,
  regime TEXT NOT NULL CHECK (regime IN ('income_wht','vat_withholding')),
  certificate_role TEXT NOT NULL DEFAULT 'issued' CHECK (certificate_role IN ('issued','received')),
  certificate_no TEXT NOT NULL,
  certificate_date DATE NOT NULL,
  partner_id UUID REFERENCES business_partners(id) ON DELETE SET NULL,
  taxable_basis NUMERIC(18,2) NOT NULL DEFAULT 0,
  withheld_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('draft','issued','voided')),
  gra_reference TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,certificate_no),
  UNIQUE (organization_id,event_id,certificate_role)
);

CREATE TABLE IF NOT EXISTS ghana_withholding_remittance_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  remittance_id UUID NOT NULL REFERENCES withholding_remittances(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES ghana_withholding_events(id) ON DELETE RESTRICT,
  applied_amount NUMERIC(18,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (remittance_id,event_id)
);

-- Ghana return templates: DT110 for income WHT and WHVAT for VAT withholding.
INSERT INTO tax_return_templates(organization_id,tax_type,code,name)
SELECT o.id,'WITHHOLDING','GH_DT110_2026','Ghana DT 110 Withholding Tax Return 2026'
FROM organizations o
ON CONFLICT (organization_id,tax_type,code) DO NOTHING;

INSERT INTO tax_return_template_boxes(template_id,box_code,label,sort_order,direction)
SELECT t.id,x.box_code,x.label,x.sort_order,'output'
FROM tax_return_templates t
CROSS JOIN (VALUES
  ('WHT_TAXABLE_BASIS','Qualifying payments subject to withholding',10),
  ('WHT_PAYABLE','Income tax withheld',20)
) x(box_code,label,sort_order)
WHERE t.code='GH_DT110_2026'
ON CONFLICT (template_id,box_code) DO UPDATE SET label=EXCLUDED.label,sort_order=EXCLUDED.sort_order;

INSERT INTO tax_return_templates(organization_id,tax_type,code,name)
SELECT o.id,'WITHHOLDING','GH_WHVAT_2026','Ghana Withholding VAT Return 2026'
FROM organizations o
ON CONFLICT (organization_id,tax_type,code) DO NOTHING;

INSERT INTO tax_return_template_boxes(template_id,box_code,label,sort_order,direction)
SELECT t.id,x.box_code,x.label,x.sort_order,'output'
FROM tax_return_templates t
CROSS JOIN (VALUES
  ('WHVAT_TAXABLE_BASIS','Standard-rated taxable value subject to VAT withholding',10),
  ('WHVAT_PAYABLE','VAT withheld at 7%',20)
) x(box_code,label,sort_order)
WHERE t.code='GH_WHVAT_2026'
ON CONFLICT (template_id,box_code) DO UPDATE SET label=EXCLUDED.label,sort_order=EXCLUDED.sort_order;


-- Upgrade the reusable Ghana country pack so organizations created later receive GRA-3 metadata too.
UPDATE tax_country_packs p
SET version_no='2026.3.0',
    metadata=jsonb_set(
      p.metadata,
      '{taxCodes}',
      COALESCE((
        SELECT jsonb_agg(
          CASE
            WHEN e->>'code' IN ('GH_WHT_GOODS_RES_3','GH_WHT_WORKS_RES_5','GH_WHT_SERVICES_RES_7_5')
              THEN e || jsonb_build_object('withholdingRegime','income_wht','withholdingTreatment','creditable','thresholdBasis','annual_cumulative','thresholdAmount','2000.00')
            WHEN e->>'code' LIKE 'GH_WHT_%'
              THEN e || jsonb_build_object('withholdingRegime','income_wht')
            ELSE e
          END
        )
        FROM jsonb_array_elements(COALESCE(p.metadata->'taxCodes','[]'::jsonb)) e
      ),'[]'::jsonb)
      || '[
        {"code":"GH_WHT_EXAMINERS_TEACHERS_10","name":"WHT Resident Examiners, Invigilators and Part-time Teachers 10%","taxType":"WITHHOLDING","rate":"10.000000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_COMPENSATION","effectiveFrom":"2026-01-01","withholdingRegime":"income_wht","withholdingTreatment":"final","thresholdBasis":"none"},
        {"code":"GH_WHT_COMMISSION_AGENTS_10","name":"WHT Resident Individual Commission Agents 10%","taxType":"WITHHOLDING","rate":"10.000000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_COMMISSION","effectiveFrom":"2026-01-01","withholdingRegime":"income_wht","withholdingTreatment":"creditable","thresholdBasis":"none"},
        {"code":"GH_WHT_PRECIOUS_MINERALS_3","name":"WHT Unprocessed Precious Minerals 3%","taxType":"WITHHOLDING","rate":"3.000000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_MINERALS","effectiveFrom":"2026-01-01","withholdingRegime":"income_wht","withholdingTreatment":"creditable","thresholdBasis":"none"},
        {"code":"GH_WHT_ROYALTY_NATURAL_RESOURCES_15","name":"WHT Royalty and Natural Resource Payments 15%","taxType":"WITHHOLDING","rate":"15.000000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_ROYALTY","effectiveFrom":"2026-01-01","withholdingRegime":"income_wht","withholdingTreatment":"creditable","thresholdBasis":"none"},
        {"code":"GH_WHVAT_7","name":"Ghana VAT Withholding 7%","taxType":"WITHHOLDING","rate":"7.000000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHVAT_PAYABLE","reportingGroup":"WHVAT","effectiveFrom":"2026-01-01","withholdingRegime":"vat_withholding","withholdingTreatment":"creditable","thresholdBasis":"none"}
      ]'::jsonb,
      true
    ),
    default_templates = p.default_templates || '[
      {"taxType":"WITHHOLDING","code":"GH_DT110_2026","name":"Ghana DT 110 Withholding Tax Return 2026","boxes":[{"boxCode":"WHT_TAXABLE_BASIS","label":"Qualifying payments subject to withholding","sortOrder":10,"direction":"output"},{"boxCode":"WHT_PAYABLE","label":"Income tax withheld","sortOrder":20,"direction":"output"}]},
      {"taxType":"WITHHOLDING","code":"GH_WHVAT_2026","name":"Ghana Withholding VAT Return 2026","boxes":[{"boxCode":"WHVAT_TAXABLE_BASIS","label":"Standard-rated taxable value subject to VAT withholding","sortOrder":10,"direction":"output"},{"boxCode":"WHVAT_PAYABLE","label":"VAT withheld at 7%","sortOrder":20,"direction":"output"}]}
    ]'::jsonb
WHERE p.organization_id IS NULL AND p.pack_code='GH-TAX-2026-COMPLETE';


-- Vendor-payment cash is net of VAT withholding; A/P settlement includes cash + discount + WHVAT.
CREATE OR REPLACE VIEW reporting_ap_open_items AS
WITH palloc AS (
  SELECT vpa.bill_id,
         SUM(vpa.amount_applied + COALESCE(vpa.discount_taken,0) + COALESCE(vpa.vat_withholding_applied,0)) AS allocated
  FROM vendor_payment_allocations vpa
  JOIN vendor_payments vp ON vp.id = vpa.vendor_payment_id
  WHERE vp.status='posted'
  GROUP BY vpa.bill_id
), dnalloc AS (
  SELECT dna.bill_id, SUM(dna.amount_applied) AS applied
  FROM debit_note_applications dna
  JOIN debit_notes dn ON dn.id = dna.debit_note_id
  WHERE dn.status='issued'
  GROUP BY dna.bill_id
), woff AS (
  SELECT w.entity_id AS bill_id, SUM(w.amount) AS written_off
  FROM writeoffs w
  WHERE w.entity_type='bill' AND w.status='posted'
  GROUP BY w.entity_id
)
SELECT
  b.organization_id,
  b.id AS bill_id,
  b.vendor_id,
  b.bill_no,
  b.bill_date,
  b.due_date,
  b.currency_code,
  b.total,
  COALESCE(b.withholding_total,0) AS withholding_total,
  COALESCE(b.net_settlement_total, b.total) AS settlement_total,
  COALESCE(p.allocated,0) AS allocated,
  COALESCE(dn.applied,0) AS notes_applied,
  COALESCE(w.written_off,0) AS written_off,
  (COALESCE(b.net_settlement_total, b.total) - COALESCE(p.allocated,0) - COALESCE(dn.applied,0) - COALESCE(w.written_off,0)) AS outstanding
FROM bills b
LEFT JOIN palloc p ON p.bill_id=b.id
LEFT JOIN dnalloc dn ON dn.bill_id=b.id
LEFT JOIN woff w ON w.bill_id=b.id;

COMMENT ON TABLE ghana_withholding_events IS
  'Canonical Ghana withholding event ledger. Income WHT and VAT withholding are distinct regimes; events are recorded at the withholding/payment event and frozen into statutory returns.';
COMMENT ON TABLE ghana_withholding_returns IS
  'Versioned Ghana withholding return snapshots for DT110 and WHVAT. Finalized return membership is immutable by application convention.';

COMMIT;
