-- 037_tier8_compliance_ifrs9_stage2_general_ecl.sql
-- IFRS 9 Stage 2: General approach (staging + PD/LGD/EAD)

-- 1) Extend ECL models to support different model types
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ifrs9_ecl_models'
      AND column_name = 'model_type'
  ) THEN
    ALTER TABLE ifrs9_ecl_models
      ADD COLUMN model_type TEXT NOT NULL DEFAULT 'SIMPLIFIED'
        CHECK (model_type IN ('SIMPLIFIED','GENERAL'));
  END IF;
END $$;

-- 2) Settings extensions for staging thresholds and defaults
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ifrs9_settings' AND column_name='stage2_threshold_days'
  ) THEN
    ALTER TABLE ifrs9_settings
      ADD COLUMN stage2_threshold_days INT NOT NULL DEFAULT 30 CHECK (stage2_threshold_days >= 0),
      ADD COLUMN stage3_threshold_days INT NOT NULL DEFAULT 90 CHECK (stage3_threshold_days >= 0),
      ADD COLUMN default_lgd NUMERIC(9,6) NOT NULL DEFAULT 0.450000 CHECK (default_lgd >= 0 AND default_lgd <= 1),
      ADD COLUMN annual_discount_rate NUMERIC(9,6) NOT NULL DEFAULT 0.100000 CHECK (annual_discount_rate >= 0 AND annual_discount_rate <= 1);
  END IF;
END $$;

-- 3) Counterparty risk profile (manual stage overrides + segmentation)
CREATE TABLE IF NOT EXISTS ifrs9_counterparty_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_partner_id UUID NOT NULL REFERENCES business_partners(id) ON DELETE CASCADE,

  segment TEXT,
  stage_override INT CHECK (stage_override IS NULL OR stage_override IN (1,2,3)),
  override_reason TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,

  UNIQUE (organization_id, business_partner_id)
);

CREATE INDEX IF NOT EXISTS idx_ifrs9_cp_profiles_org_bp
  ON ifrs9_counterparty_profiles(organization_id, business_partner_id);

-- 4) General ECL parameters (PD/LGD by stage + ageing bucket)
CREATE TABLE IF NOT EXISTS ifrs9_ecl_parameters (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_id UUID NOT NULL REFERENCES ifrs9_ecl_models(id) ON DELETE CASCADE,

  stage INT NOT NULL CHECK (stage IN (1,2,3)),
  label TEXT NOT NULL,
  days_past_due_from INT NOT NULL DEFAULT 0 CHECK (days_past_due_from >= 0),
  days_past_due_to INT CHECK (days_past_due_to IS NULL OR days_past_due_to >= 0),

  pd_12m NUMERIC(9,6) NOT NULL CHECK (pd_12m >= 0 AND pd_12m <= 1),
  pd_lifetime NUMERIC(9,6) NOT NULL CHECK (pd_lifetime >= 0 AND pd_lifetime <= 1),
  lgd NUMERIC(9,6) CHECK (lgd IS NULL OR (lgd >= 0 AND lgd <= 1)),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,

  UNIQUE (organization_id, model_id, stage, days_past_due_from, days_past_due_to)
);

CREATE INDEX IF NOT EXISTS idx_ifrs9_params_model_stage
  ON ifrs9_ecl_parameters(model_id, stage, days_past_due_from);

-- 5) Extend run lines to store stage + PD/LGD/EAD for auditability
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ifrs9_ecl_run_lines' AND column_name='stage'
  ) THEN
    ALTER TABLE ifrs9_ecl_run_lines
      ADD COLUMN stage INT CHECK (stage IS NULL OR stage IN (1,2,3)),
      ADD COLUMN pd_used NUMERIC(9,6),
      ADD COLUMN lgd_used NUMERIC(9,6),
      ADD COLUMN ead_amount NUMERIC(18,2);
  END IF;
END $$;

-- 6) Extend runs to store approach
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ifrs9_ecl_runs' AND column_name='approach'
  ) THEN
    ALTER TABLE ifrs9_ecl_runs
      ADD COLUMN approach TEXT NOT NULL DEFAULT 'SIMPLIFIED'
        CHECK (approach IN ('SIMPLIFIED','GENERAL'));
  END IF;
END $$;
