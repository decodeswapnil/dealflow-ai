import 'dotenv/config';
import { createLogger } from '../../shared/utils/logger.js';
import { query } from '../../shared/utils/db.js';
import { redis } from '../../shared/utils/redis.js';
import { Worker } from 'bullmq';
import { Telegraf } from 'telegraf';

const logger = createLogger('telegram-posting');

class TelegramPostingAgent {
  constructor() {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    this.channelId = process.env.TELEGRAM_CHANNEL_ID;
    this.rateLimitMs = 2000; // 2 seconds between posts
    this.lastPostTime = 0;
  }

  async init() {
    logger.info('Initializing Telegram Posting Agent');
    
    const worker = new Worker('posts', async (job) => {
      logger.info(`Processing post job ${job.id}`);
      return this.createAndSendPost(job.data);
    }, {
      connection: redis.options,
      concurrency: 1, // Sequential to respect rate limits
    });

    worker.on('completed', (job) => {
      logger.info(`Post completed for ${job.data.deal.asin}`);
    });

    worker.on('failed', (job, err) => {
      logger.error(`Post failed for ${job.data.deal.asin}`, { error: err.message });
    });

    // Handle /status command
    this.bot.command('status', async (ctx) => {
      const stats = await this.getStats();
      ctx.reply(`📊 Platform Status\nDeals today: ${stats.todayDeals}\nQueue size: ${stats.queueSize}`);
    });

    await this.bot.launch();
    logger.info('Telegram bot started');
  }

  async createAndSendPost({ deal, score }) {
    try {
      // Rate limiting
      const now = Date.now();
      const waitTime = this.lastPostTime + this.rateLimitMs - now;
      if (waitTime > 0) {
        await new Promise(r => setTimeout(r, waitTime));
      }

      // Generate caption
      const caption = this.generateCaption(deal, score);
      
      // Generate affiliate URL
      const affiliateUrl = this.generateAffiliateUrl(deal.productUrl);

      // Send to Telegram
      const message = await this.sendPost(deal, caption, affiliateUrl);

      // Record in DB
      await this.recordPost(deal, score, caption, message.message_id);

      this.lastPostTime = Date.now();
      return { messageId: message.message_id, url: affiliateUrl };
    } catch (err) {
      logger.error('Post creation failed', { asin: deal.asin, error: err.message });
      throw err;
    }
  }

  generateCaption(deal, score) {
    const { title, price, mrp, rating, reviewCount } = deal;
    const discount = mrp ? Math.round(((mrp - price) / mrp) * 100) : 0;
    
    const emojis = {
      hot: '🔥⚡💥',
      good: '✅👍',
      average: 'ℹ️',
      skip: '',
    };

    const urgency = score.verdict === 'hot' 
      ? '\n⚡ Limited Time Deal! Grab before it expires!' 
      : '';

    const ratingText = rating 
      ? `⭐ ${rating}/5 (${reviewCount?.toLocaleString() || 0} reviews)\n` 
      : '';

    return `${emojis[score.verdict] || '✅'} <b>${title}</b>

💰 <b>₹${price.toLocaleString()}</b> ${mrp ? `<s>₹${mrp.toLocaleString()}</s>` : ''}
${discount > 0 ? `📉 <b>${discount}% OFF</b>\n` : ''}${ratingText}${urgency}

🛒 Buy Now 👇`;
  }

  generateAffiliateUrl(productUrl) {
    const tag = process.env.AMAZON_ASSOCIATE_TAG;
    if (!tag) return productUrl;
    
    const url = new URL(productUrl);
    url.searchParams.set('tag', tag);
    url.searchParams.set('ref', 'affiliate_dealbot');
    return url.toString();
  }

  async sendPost(deal, caption, affiliateUrl) {
    const keyboard = {
      inline_keyboard: [[
        { text: '🛒 Buy on Amazon', url: affiliateUrl },
        { text: '🔔 Price Alert', callback_data: `alert_${deal.asin}` }
      ]]
    };

    if (deal.imageUrl) {
      return this.bot.telegram.sendPhoto(this.channelId, deal.imageUrl, {
        caption,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    }

    return this.bot.telegram.sendMessage(this.channelId, `${caption}\n\n${affiliateUrl}`, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: false },
    });
  }

  async recordPost(deal, score, caption, messageId) {
    await query(`
      INSERT INTO posted_deals (time, asin, deal_score, post_template, channel)
      VALUES (NOW(), $1, $2, $3, $4)
    `, [deal.asin, score.score, 'standard', this.channelId]);
  }

  async getStats() {
    const todayResult = await query(`
      SELECT COUNT(*) as cnt FROM posted_deals 
      WHERE time >= DATE_TRUNC('day', NOW())
    `);
    
    const queueSize = await redis.llen('bull:posts:wait').catch(() => 0);
    return {
      todayDeals: parseInt(todayResult.rows[0].cnt),
      queueSize,
    };
  }

  async shutdown() {
    this.bot.stop();
    logger.info('Telegram Posting Agent shutdown');
  }
}

const agent = new TelegramPostingAgent();
process.on('SIGINT', () => agent.shutdown().then(() => process.exit(0)));
agent.init().catch(err => {
  logger.error('Failed to start', err);
  process.exit(1);
});