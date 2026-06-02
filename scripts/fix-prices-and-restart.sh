#!/bin/bash
# Fix price issue and restart system
#
# Requires the following environment variables (load them from your .env):
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID, DB_PASSWORD
# Example:  set -a && source .env && set +a && ./scripts/fix-prices-and-restart.sh

set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is not set — load it from .env}"
: "${TELEGRAM_CHANNEL_ID:?TELEGRAM_CHANNEL_ID is not set — load it from .env}"
: "${DB_PASSWORD:?DB_PASSWORD is not set — load it from .env}"

DB_HOST="${DB_HOST:-postgres}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-affiliate_platform}"
DB_USER="${DB_USER:-affiliate_user}"

echo "🔧 Fixing price display issue and restarting system..."
echo ""

# Step 1: Delete Telegram posts
echo "📱 Step 1: Deleting incorrect Telegram posts..."
docker exec \
  -e TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" \
  -e TELEGRAM_CHANNEL_ID="$TELEGRAM_CHANNEL_ID" \
  -e DB_HOST="$DB_HOST" \
  -e DB_PORT="$DB_PORT" \
  -e DB_NAME="$DB_NAME" \
  -e DB_USER="$DB_USER" \
  -e DB_PASSWORD="$DB_PASSWORD" \
  affiliate-platform-telegram-posting-1 node -e '
const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

async function deleteAll() {
  try {
    const result = await pool.query("SELECT message_id FROM posted_deals WHERE message_id IS NOT NULL ORDER BY time DESC");
    console.log("Found", result.rowCount, "posts to delete");

    let deleted = 0, failed = 0;
    for (const row of result.rows) {
      try {
        await bot.deleteMessage(process.env.TELEGRAM_CHANNEL_ID, row.message_id);
        console.log("✓ Deleted message", row.message_id);
        deleted++;
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.log("✗ Failed to delete", row.message_id, ":", err.message);
        failed++;
      }
    }

    console.log("\nDeletion complete:", deleted, "deleted,", failed, "failed");
    await pool.end();
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

deleteAll();
'

echo ""
echo "🗄️  Step 2: Cleaning database (removing incorrect price data)..."
docker exec affiliate-platform-postgres-1 psql -U "$DB_USER" -d "$DB_NAME" -c "
DELETE FROM posted_deals;
DELETE FROM price_history;
UPDATE products SET last_updated = NOW() - INTERVAL '48 hours';
"

echo ""
echo "🔄 Step 3: Rebuilding containers with fixed code..."
docker-compose build deal-discovery

echo ""
echo "🚀 Step 4: Restarting services..."
docker-compose restart deal-discovery deal-analysis telegram-posting

echo ""
echo "✅ All done! System restarted with price fix."
echo ""
echo "📊 Monitoring logs (Ctrl+C to exit):"
docker-compose logs -f deal-discovery telegram-posting
