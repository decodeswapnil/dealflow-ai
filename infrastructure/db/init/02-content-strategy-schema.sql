-- Content Strategy Schema Migration
-- Adds content strategy metadata, revenue tracking, and A/B testing tables

-- Add content strategy columns to posted_deals (existing hypertable)
ALTER TABLE posted_deals
    ADD COLUMN IF NOT EXISTS content_strategy TEXT DEFAULT 'standard',
    ADD COLUMN IF NOT EXISTS archetype TEXT,
    ADD COLUMN IF NOT EXISTS ai_generated BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS posting_slot TEXT,
    ADD COLUMN IF NOT EXISTS revenue_multiplier REAL DEFAULT 1.0,
    ADD COLUMN IF NOT EXISTS clicks INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS estimated_revenue REAL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_click_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS final_price REAL,
    ADD COLUMN IF NOT EXISTS deal_price REAL,
    ADD COLUMN IF NOT EXISTS category TEXT,
    ADD COLUMN IF NOT EXISTS caption_source TEXT;

-- Create indexes for new columns
CREATE INDEX IF NOT EXISTS idx_posted_deals_strategy ON posted_deals(content_strategy) WHERE content_strategy IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posted_deals_archetype ON posted_deals(archetype) WHERE archetype IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posted_deals_ai_generated ON posted_deals(ai_generated);

-- A/B Test Assignments table
CREATE TABLE IF NOT EXISTS ab_test_assignments (
    post_id INTEGER NOT NULL,
    experiment_id TEXT NOT NULL,
    variant TEXT NOT NULL,
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (post_id, experiment_id)
);

-- Engagement Posts tracking
CREATE TABLE IF NOT EXISTS engagement_posts (
    time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    post_type TEXT NOT NULL,
    content TEXT NOT NULL,
    ai_generated BOOLEAN DEFAULT FALSE,
    message_id BIGINT,
    clicks INTEGER DEFAULT 0,
    engagement_views INTEGER DEFAULT 0
);

-- Note: TimescaleDB hypertable not available in this pgvector image
-- Using regular B-tree index on time instead
CREATE INDEX IF NOT EXISTS idx_engagement_posts_time ON engagement_posts(time);
