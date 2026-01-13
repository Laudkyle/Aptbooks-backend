-- Adds dimension_json to cost_allocation_lines for traceability (source -> target dimensions)

ALTER TABLE cost_allocation_lines
  ADD COLUMN IF NOT EXISTS dimension_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_cost_allocation_lines_dimension_json
  ON cost_allocation_lines USING GIN (dimension_json);
