#!/usr/bin/env node
/**
 * Clear DB for Testing
 * Wipes all deal/posted data so deals can be re-discovered and re-posted
 */
import 'dotenv/config';
import { createLogger } from '../shared/utils/logger.js';
import { query } from '../shared/utils/db.js';
import { redis } from '../shared/utils/redis.js';

const logger = createLogger('clear-db-testing');

async function clearDatabase() {
  logger.info('=== CLEARING DATABASE FOR TESTING ===');

  // 1. Clear posted_deals (so deals can be re-posted)
  const postedRes = await query(`DELETE FROM posted_deals`);
  logger.info(`Cleared ${postedRes?.rowCount || 0} posted_deals records`);

  // 2. Clear products (so deals can be re-discovered and re-analyzed)
  const productsRes = await query(`DELETE FROM products`);
  logger.info(`Cleared ${productsRes?.rowCount || 0} products records`);

  // 3. Clear price_history (fresh price tracking)
  const priceRes = await query(`DELETE FROM price_history`);
  logger.info(`Cleared ${priceRes?.rowCount || 0} price_history records`);

  // 4. Clear curated_lists
  const curatedRes = await query(`DELETE FROM curated_lists`);
  logger.info(`Cleared ${curatedRes?.rowCount || 0} curated_lists records`);

  // 5. Clear WhatsApp ingestion
  const waRes = await query(`DELETE FROM whatsapp_ingestion`);
  logger.info(`Cleared ${waRes?.rowCount || 0} whatsapp_ingestion records`);

  // 6. Clear engagement posts
  const engRes = await query(`DELETE FROM engagement_posts`);
  logger.info(`Cleared ${engRes?.rowCount || 0} engagement_posts records`);

  // 7. Clear affiliate clicks
  const clicksRes = await query(`DELETE FROM affiliate_clicks`);
  logger.info(`Cleared ${clicksRes?.rowCount || 0} affiliate_clicks records`);

  // 8. Clear agent metrics
  const metricsRes = await query(`DELETE FROM agent_metrics`);
  logger.info(`Cleared ${metricsRes?.rowCount || 0} agent_metrics records`);

  // 9. Clear A/B test assignments
  const abRes = await query(`DELETE FROM ab_test_assignments`);
  logger.info(`Cleared ${abRes?.rowCount || 0} ab_test_assignments records`);

  // 10. Clear curated list runs (but keep configs)
  const runsRes = await query(`DELETE FROM curated_list_runs`);
  logger.info(`Cleared ${runsRes?.rowCount || 0} curated_list_runs records`);

  // 11. Clear posted digests
  const digestRes = await query(`DELETE FROM posted_digests`);
  logger.info(`Cleared ${digestRes?.rowCount || 0} posted_digests records`);

  // 12. Clear price alerts (optional - keep user alerts)
  // const alertsRes = await query(`DELETE FROM price_alerts`);
  // logger.info(`Cleared ${alertsRes?.rowCount || 0} price_alerts records`);

  logger.info('=== DATABASE CLEARED ===');
}

async function clearRedisCache() {
  try {
    // Clear all deal/post/price related keys
    const patterns = ['deals:*', 'posts:*', 'published-deals:*', 'price:*', 'analysis:*', 'queue:*'];
    let totalCleared = 0;
    for (const pattern of patterns) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
        totalCleared += keys.length;
        logger.info(`Cleared ${keys.length} Redis keys matching ${pattern}`);
      }
    }
    // Also flush queues specifically
    const allKeys = await redis.keys('*');
    const queueKeys = allKeys.filter(k => k.includes('bull') || k.includes('queue'));
    if (queueKeys.length > 0) {
      await redis.del(...queueKeys);
      totalCleared += queueKeys.length;
    }
    logger.info(`Total Redis keys cleared: ${totalCleared}`);
  } catch (err) {
    logger.warn('Redis clear failed (may not be running)', { error: err.message });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const skipRedis = args.includes('--skip-redis');

  logger.info('=== Clear DB for Testing ===');

  await clearDatabase();
  if (!skipRedis) {
    await clearRedis();
  }

  logger.info('=== Done! Deals can now be re-discovered and re-posted ===');
  process.exit(0);
}

main().catch(err => {
  logger.error('Script failed', { error: err.message });
  process.exit(1);
});
