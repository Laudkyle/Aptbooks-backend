-- Migration: Add default allocation bases for first organization
-- Date: 2026-02-24

BEGIN;

-- Get the first organization ID
DO $$
DECLARE
  first_org_id UUID;
BEGIN
  -- Select the first organization ID
  SELECT id INTO first_org_id FROM organizations ORDER BY created_at ASC LIMIT 1;
  
  -- Only proceed if an organization exists
  IF first_org_id IS NOT NULL THEN
    -- Insert default allocation bases
    INSERT INTO allocation_bases (
      id,
      organization_id,
      code,
      name,
      basis_type,
      payload_json,
      status,
      created_at,
      updated_at
    ) VALUES 
    -- Headcount based allocations
    (
      gen_random_uuid(),
      first_org_id,
      'HC-DEPT',
      'Headcount by Department',
      'headcount',
      '{"description": "Allocates costs based on number of employees per department", "factors": []}'::jsonb,
      'active',
      NOW(),
      NOW()
    ),
    (
      gen_random_uuid(),
      first_org_id,
      'HC-DIV',
      'Headcount by Division',
      'headcount',
      '{"description": "Allocates costs based on number of employees per division", "factors": []}'::jsonb,
      'active',
      NOW(),
      NOW()
    ),
    -- Area based allocations
    (
      gen_random_uuid(),
      first_org_id,
      'AREA-SQFT',
      'Square Footage',
      'area',
      '{"description": "Allocates costs based on occupied square footage", "unit": "sqft", "factors": []}'::jsonb,
      'active',
      NOW(),
      NOW()
    ),
    (
      gen_random_uuid(),
      first_org_id,
      'AREA-SQM',
      'Square Meters',
      'area',
      '{"description": "Allocates costs based on occupied square meters", "unit": "sqm", "factors": []}'::jsonb,
      'active',
      NOW(),
      NOW()
    ),
    -- Revenue based allocations
    (
      gen_random_uuid(),
      first_org_id,
      'REV-PCT',
      'Revenue Percentage',
      'revenue',
      '{"description": "Allocates costs based on percentage of total revenue", "factors": []}'::jsonb,
      'active',
      NOW(),
      NOW()
    ),
    (
      gen_random_uuid(),
      first_org_id,
      'REV-ABS',
      'Absolute Revenue',
      'revenue',
      '{"description": "Allocates costs based on absolute revenue amounts", "factors": []}'::jsonb,
      'active',
      NOW(),
      NOW()
    ),
    -- Custom allocation bases
    (
      gen_random_uuid(),
      first_org_id,
      'CUST-EVEN',
      'Even Split',
      'custom',
      '{"description": "Splits costs evenly across all targets", "method": "equal", "factors": []}'::jsonb,
      'active',
      NOW(),
      NOW()
    ),
    (
      gen_random_uuid(),
      first_org_id,
      'CUST-WEIGHT',
      'Weighted Distribution',
      'custom',
      '{"description": "Custom weighted distribution based on user-defined factors", "method": "weighted", "factors": []}'::jsonb,
      'active',
      NOW(),
      NOW()
    ),
    (
      gen_random_uuid(),
      first_org_id,
      'CUST-MANUAL',
      'Manual Entry',
      'custom',
      '{"description": "Manually enter allocation percentages", "method": "manual", "factors": []}'::jsonb,
      'active',
      NOW(),
      NOW()
    )
    ON CONFLICT (organization_id, code) DO NOTHING;
    
    RAISE NOTICE 'Added default allocation bases for organization: %', first_org_id;
  ELSE
    RAISE NOTICE 'No organizations found. Skipping default allocation bases.';
  END IF;
END $$;

COMMIT;