-- 008_tier11_scheduled_tasks.sql
-- Tier 11: DB-backed scheduler (free, restart-safe)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE, -- nullable = global task

  code TEXT NOT NULL UNIQUE,        -- e.g. "accruals.run_due.daily"
  name TEXT NOT NULL,

  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('interval_seconds','daily_at_utc')),
  interval_seconds INT CHECK (interval_seconds IS NULL OR interval_seconds > 0),

  daily_hour_utc INT CHECK (daily_hour_utc IS NULL OR (daily_hour_utc >= 0 AND daily_hour_utc <= 23)),
  daily_minute_utc INT CHECK (daily_minute_utc IS NULL OR (daily_minute_utc >= 0 AND daily_minute_utc <= 59)),

  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,

  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,

  max_attempts INT NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),

  locked_at TIMESTAMPTZ,
  locked_by TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_code TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','failed','skipped')),
  message TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(is_enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_code ON scheduled_task_runs(task_code, started_at DESC);
