-- Price alerts: users can register via bot to get notified when price drops
CREATE TABLE IF NOT EXISTS price_alerts (
  id          SERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  chat_id     BIGINT NOT NULL,
  asin        TEXT NOT NULL,
  title       TEXT,
  image_url   TEXT,
  target_price REAL,            -- null = alert on any drop
  last_price   REAL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  triggered_at TIMESTAMPTZ,     -- last time we fired this alert
  active      BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_alerts_asin   ON price_alerts(asin) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_alerts_userid ON price_alerts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_user_asin ON price_alerts(user_id, asin) WHERE active = TRUE;
