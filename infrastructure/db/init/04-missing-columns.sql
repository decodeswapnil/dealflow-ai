-- Schema Migration 04: Products table + posted_deals missing columns
-- Run this to fix the "column does not exist" errors in deal-analysis and saturation queries

-- ── Products table: add deal scoring columns ──────────────────────────────────
-- The original schema was missing price/mrp/deal_score/verdict columns
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS price REAL,
    ADD COLUMN IF NOT EXISTS mrp REAL,
    ADD COLUMN IF NOT EXISTS discount_pct REAL,
    ADD COLUMN IF NOT EXISTS deal_score REAL,
    ADD COLUMN IF NOT EXISTS verdict TEXT;

-- ── posted_deals: add category for saturation queries ────────────────────────
-- demand-intelligence.js queries posted_deals.category to count recent posts per category
ALTER TABLE posted_deals
    ADD COLUMN IF NOT EXISTS category TEXT;

-- ── Indexes for new columns ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_products_price ON products(price) WHERE price IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_verdict ON products(verdict) WHERE verdict IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_deal_score ON products(deal_score DESC) WHERE deal_score IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posted_deals_category ON posted_deals(category, time DESC) WHERE category IS NOT NULL;

-- Confirm what we have now
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'products'
ORDER BY ordinal_position;
