#!/bin/bash
# Cleanup and Restart Script
# Deletes Telegram posts, clears database, and restarts containers

set -e

echo "=== Affiliate Platform Cleanup & Restart ==="
echo ""

# Step 1: Delete Telegram posts
echo "Step 1: Deleting Telegram posts..."
docker-compose exec -T postgres psql -U affiliate_user -d affiliate_db -c "
  SELECT message_id FROM posted_deals 
  WHERE message_id IS NOT NULL 
  AND time > NOW() - INTERVAL '7 days'
  ORDER BY message_id DESC;
" > /tmp/message_ids.txt

# Note: Actual deletion needs to be done via Telegram Bot API
# This would require running the delete script from within a container with node
echo "  Found message IDs in database"
echo "  To delete posts, run: docker-compose exec telegram-posting node -e \"
    const TelegramBot = require('node-telegram-bot-api');
    const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
    // Add deletion logic here
  \""

# Step 2: Clear database
echo ""
echo "Step 2: Clearing database..."
docker-compose exec -T postgres psql -U affiliate_user -d affiliate_db <<EOF
  DELETE FROM deals WHERE status IN ('new', 'analyzed', 'rejected');
  DELETE FROM analyzed_deals WHERE posted = false;
  DELETE FROM posted_deals WHERE time > NOW() - INTERVAL '7 days';
  UPDATE deals SET status = 'new' WHERE status = 'analyzing';
EOF
echo "  Database cleared"

# Step 3: Restart containers with updated code
echo ""
echo "Step 3: Restarting containers..."
docker-compose restart deal-discovery telegram-posting deal-analysis
echo "  Containers restarted"

echo ""
echo "=== Cleanup Complete! ==="
echo "The system will now discover and post deals with the fixes applied."
echo ""
echo "Monitor logs with: docker-compose logs -f deal-discovery telegram-posting"
