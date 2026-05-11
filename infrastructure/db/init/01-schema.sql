-- Initialize TimescaleDB for affiliate platform
-- Products table
CREATE TABLE IF NOT EXISTS products (
    asin TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT,
    image_url TEXT,
    product_url TEXT,
    rating REAL,
    review_count INTEGER,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    last_updated TIMESTAMPTZ DEFAULT NOW()
);

-- Convert to hypertable for time-series price data
CREATE TABLE IF NOT EXISTS price_history (
    time TIMESTAMPTZ NOT NULL,
    asin TEXT NOT NULL,
    price REAL NOT NULL,
    mrp REAL,
    discount_pct REAL,
    source TEXT DEFAULT 'amazon'
);

SELECT create_hypertable('price_history', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_price_history_asin ON price_history(asin, time DESC);

-- Posted deals tracking
CREATE TABLE IF NOT EXISTS posted_deals (
    time TIMESTAMPTZ NOT NULL,
    asin TEXT NOT NULL,
    deal_score REAL,
    post_template TEXT,
    channel TEXT DEFAULT 'telegram',
    engagement_views INTEGER DEFAULT 0,
    engagement_clicks INTEGER DEFAULT 0
);

SELECT create_hypertable('posted_deals', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_posted_deals_asin ON posted_deals(asin, time DESC);

-- WhatsApp ingestion log
CREATE TABLE IF NOT EXISTS whatsapp_ingestion (
    time TIMESTAMPTZ NOT NULL,
    message_id TEXT,
    source_group TEXT,
    raw_text TEXT,
    extracted_asin TEXT,
    extracted_url TEXT,
    processed BOOLEAN DEFAULT FALSE,
    duplicate_of TEXT
);

SELECT create_hypertable('whatsapp_ingestion', 'time', if_not_exists => TRUE);

-- Affiliate link tracking
CREATE TABLE IF NOT EXISTS affiliate_clicks (
    time TIMESTAMPTZ NOT NULL,
    short_url TEXT,
    original_url TEXT,
    asin TEXT,
    channel TEXT,
    user_agent TEXT,
    ip_hash TEXT
);

SELECT create_hypertable('affiliate_clicks', 'time', if_not_exists => TRUE);

-- Agent performance metrics
CREATE TABLE IF NOT EXISTS agent_metrics (
    time TIMESTAMPTZ NOT NULL,
    agent_name TEXT NOT NULL,
    task_type TEXT,
    status TEXT,
    duration_ms INTEGER,
    error_message TEXT
);

SELECT create_hypertable('agent_metrics', 'time', if_not_exists => TRUE);