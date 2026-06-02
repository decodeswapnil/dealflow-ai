#!/usr/bin/env node
/**
 * Reset & Re-Run Script
 * Clears deals/analyzed_deals tables and triggers fresh deal discovery
 */
import 'dotenv/config';
import { createLogger } from '../shared/utils/logger.js';
import { query } from '../shared/utils/db.js';
import { getRedis } from '../shared/utils/redis.js';

const logger = createLogger('reset-and-run');

async function resetDatabase() {
  logger.info('Resetting database...');

  // Clear deals that haven't been posted yet
  await query(`DELETE FROM deals WHERE status IN ('new', 'analyzed', 'rejected')`);
  logger.info('Cleared unposted deals');

  // Clear analyzed deals
  await query(`DELETE FROM analyzed_deals WHERE posted = false`);
  logger.info('Cleared unposted analyzed deals');

  // Clear posted_deals tracking (so deals can be re-discovered and re-posted)
  await query(`DELETE FROM posted_deals WHERE time > NOW() - INTERVAL '7 days'`);
  logger.info('Cleared posted_deals tracking');

  // Reset any in-progress statuses
  await query(`UPDATE deals SET status = 'new' WHERE status = 'analyzing'`);
  logger.info('Reset stuck deals');
}

async function clearRedis() {
  try {
    const redis = getRedis();
    const keys = await redis.keys('deals:*');
    if (keys.length > 0) {
      await redis.del(...keys);
      logger.info(`Cleared ${keys.length} Redis keys`);
    }
  } catch (err) {
    logger.warn('Redis clear failed (may not be running)', { error: err.message });
  }
}

async function triggerDealDiscovery() {
  logger.info('Triggering deal discovery...');

  // Import and run deal discovery
  const { runDealDiscovery } = await import('../agents/deal-discovery/index.js');
  await runDealDiscovery();

  logger.info('Deal discovery complete!');
}

async function main() {
  const args = process.argv.slice(2);
  const skipDiscovery = args.includes('--skip-discovery');

  logger.info('=== Reset & Re-Run ===');

  await resetDatabase();
  await clearRedis();

  if (!skipDiscovery) {
    await triggerDealDiscovery();
  } else {
    logger.info('Skipping deal discovery (--skip-discovery flag set)');
  }

  logger.info('=== Done! ===');
  process.exit(0);
}

main().catch(err => {
  logger.error('Script failed', { error: err.message });
  process.exit(1);
});
