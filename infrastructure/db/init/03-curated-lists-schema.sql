-- Curated Lists Agent Schema Extension
-- Adds columns and indexes for curated-list-discovered products

-- Add curated list metadata to products table
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS curated_list TEXT,
  ADD COLUMN IF NOT EXISTS list_rank INTEGER,
  ADD COLUMN IF NOT EXISTS list_category TEXT,
  ADD COLUMN IF NOT EXISTS source_agent TEXT DEFAULT 'deal-discovery';

-- Index for curated list queries
CREATE INDEX IF NOT EXISTS idx_products_curated_list ON products(curated_list) WHERE curated_list IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_source_agent ON products(source_agent);

-- Track curated list extraction runs
CREATE TABLE IF NOT EXISTS curated_list_runs (
  id          SERIAL PRIMARY KEY,
  list_name   TEXT NOT NULL,
  list_url    TEXT NOT NULL,
  started_at  TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  items_found INTEGER DEFAULT 0,
  items_queued INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'running',
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_curated_list_runs_status ON curated_list_runs(status);
CREATE INDEX IF NOT EXISTS idx_curated_list_runs_started ON curated_list_runs(started_at DESC);

-- Curated list configuration
CREATE TABLE IF NOT EXISTS curated_list_configs (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  url         TEXT NOT NULL,
  category    TEXT,
  is_active   BOOLEAN DEFAULT true,
  priority    INTEGER DEFAULT 0,
  max_items   INTEGER DEFAULT 30,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default curated lists
INSERT INTO curated_list_configs (name, url, category, priority)
VALUES
  ('bestsellers', 'https://www.amazon.in/gp/bestsellers', 'all', 1),
  ('most_gifted', 'https://www.amazon.in/gp/most-gifted', 'all', 2),
  ('movers_shakers', 'https://www.amazon.in/gp/movers-and-shakers', 'trending', 3),
  ('new_releases', 'https://www.amazon.in/gp/new-releases', 'new', 4)
ON CONFLICT (name) DO NOTHING;

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_curated_config_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_curated_config_updated ON curated_list_configs;
CREATE TRIGGER trg_curated_config_updated
  BEFORE UPDATE ON curated_list_configs
  FOR EACH ROW EXECUTE FUNCTION update_curated_config_timestamp();

-- View: products discovered from curated lists
CREATE OR REPLACE VIEW v_curated_products AS
SELECT
  p.*,
  c.name AS list_config_name,
  c.category AS list_category
FROM products p
LEFT JOIN curated_list_configs c ON p.curated_list = c.name
WHERE p.source_agent = 'curated-lists';
