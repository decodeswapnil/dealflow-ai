#!/bin/bash
# Auto-clear database for testing
# Clears deals/products/posted_deals so fresh deals can be discovered and posted
# Run via cron: 0 0,23 * * * /path/to/auto-clear-for-testing.sh

set -e

echo "=== $(date): Auto-clearing database for testing ==="

# Clear all deal-related tables
docker-compose exec -T postgres psql -U affiliate_user -d affiliate_platform -c "
  TRUNCATE TABLE posted_deals CASCADE;
  TRUNCATE TABLE products CASCADE;
  TRUNCATE TABLE price_history CASCADE;
  TRUNCATE TABLE whatsapp_ingestion CASCADE;
  TRUNCATE TABLE engagement_posts CASCADE;
  TRUNCATE TABLE affiliate_clicks CASCADE;
  TRUNCATE TABLE agent_metrics CASCADE;
  TRUNCATE TABLE ab_test_assignments CASCADE;
  TRUNCATE TABLE curated_list_runs CASCADE;
"

echo "=== Database cleared at $(date) ==="

# Flush Redis
docker-compose exec -T redis redis-cli FLUSHDB || echo "Redis flush failed (may not be running)"

echo "=== Redis flushed ==="

# Restart agents to trigger fresh discovery
docker-compose restart deal-discovery deal-analysis telegram-posting curated-lists

echo "=== Agents restarted, fresh discovery beginning ==="
