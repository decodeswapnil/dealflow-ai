#!/usr/bin/env node
/**
 * Delete Telegram Posts Script
 * Deletes all posts from the Telegram channel and clears posted_deals tracking
 */
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { createLogger } from '../shared/utils/logger.js';
import { query } from '../shared/utils/db.js';

const logger = createLogger('delete-posts');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

async function getRecentMessageIds() {
  try {
    // Get message_ids from database (new posts will have this)
    const result = await query(
      `SELECT DISTINCT message_id FROM posted_deals 
       WHERE message_id IS NOT NULL 
       AND time > NOW() - INTERVAL '7 days'
       ORDER BY message_id DESC`
    );
    return result.rows.map(r => r.message_id);
  } catch (err) {
    logger.error('Failed to get message IDs from DB', { error: err.message });
    return [];
  }
}

async function deletePost(messageId) {
  try {
    await bot.deleteMessage(CHANNEL_ID, messageId);
    logger.info(`Deleted message ${messageId}`);
    return true;
  } catch (err) {
    if (err.response?.body?.description?.includes('message to delete not found')) {
      logger.warn(`Message ${messageId} already deleted or too old`);
    } else {
      logger.error(`Failed to delete message ${messageId}`, { error: err.message });
    }
    return false;
  }
}

async function clearPostedDeals() {
  try {
    await query(`DELETE FROM posted_deals WHERE time > NOW() - INTERVAL '7 days'`);
    logger.info('Cleared posted_deals tracking for recent posts');
  } catch (err) {
    logger.error('Failed to clear posted_deals', { error: err.message });
  }
}

async function main() {
  logger.info('Starting Telegram post deletion...');
  logger.info(`Channel: ${CHANNEL_ID}`);

  // Get message IDs from database
  const messageIds = await getRecentMessageIds();
  logger.info(`Found ${messageIds.length} posts with message_ids in database`);

  // Delete each post
  let deleted = 0;
  let failed = 0;

  for (const messageId of messageIds) {
    const success = await deletePost(messageId);
    if (success) deleted++;
    else failed++;

    // Rate limit: max 20 deletions per minute
    await new Promise(r => setTimeout(r, 3500));
  }

  logger.info(`Deletion complete: ${deleted} deleted, ${failed} failed/skipped`);

  // Clear posted_deals tracking so deals can be re-posted
  await clearPostedDeals();

  logger.info('Done! You can now re-run deal discovery and posting.');
  process.exit(0);
}

main().catch(err => {
  logger.error('Script failed', { error: err.message });
  process.exit(1);
});
