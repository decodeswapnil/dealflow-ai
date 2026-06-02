import 'dotenv/config';
import { createLogger } from '../shared/utils/logger.js';
import { query } from '../shared/utils/db.js';
import TelegramBot from 'node-telegram-bot-api';

const logger = createLogger('delete-posts');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

async function deleteAllPosts() {
  logger.info('Starting mass deletion of Telegram posts...');
  logger.info('Channel:', CHANNEL_ID);

  try {
    // Get all message IDs from database
    const result = await query(
      `SELECT message_id, asin, time 
       FROM posted_deals 
       WHERE message_id IS NOT NULL 
       ORDER BY time DESC`
    );

    logger.info(`Found ${result.rowCount} posts with message_ids in database`);

    let deleted = 0;
    let failed = 0;

    for (const row of result.rows) {
      try {
        await bot.deleteMessage(CHANNEL_ID, row.message_id);
        logger.info(`Deleted post ${row.message_id} (ASIN: ${row.asin})`);
        deleted++;
        
        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        logger.warn(`Failed to delete post ${row.message_id}: ${err.message}`);
        failed++;
      }
    }

    logger.info(`Deletion complete: ${deleted} deleted, ${failed} failed/skipped`);

    // Clear posted_deals table
    await query(`DELETE FROM posted_deals`);
    logger.info('Cleared posted_deals table');

    // Also clear analyzed_deals to allow re-analysis
    await query(`DELETE FROM analyzed_deals`);
    logger.info('Cleared analyzed_deals table');

    // Reset deals status
    await query(`UPDATE deals SET status = 'new' WHERE status IN ('analyzing', 'analyzed', 'rejected')`);
    logger.info('Reset deals status to new');

    logger.info('All done! You can now re-run deal discovery and posting.');

  } catch (err) {
    logger.error('Failed to delete posts', { error: err.message });
  }
}

deleteAllPosts();
