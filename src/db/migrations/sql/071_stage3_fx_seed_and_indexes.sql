-- Stage 3: Seed FX rate types + indexes

INSERT INTO exchange_rate_types (code, name)
VALUES
  ('SPOT', 'Spot rate'),
  ('AVERAGE', 'Average rate'),
  ('CLOSING', 'Closing rate')
ON CONFLICT (code) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_exchange_rates_lookup
  ON exchange_rates (organization_id, rate_type_id, from_currency, to_currency, effective_date DESC);
