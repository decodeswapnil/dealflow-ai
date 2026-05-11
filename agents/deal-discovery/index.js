import 'dotenv/config';
import { createLogger } from '../../shared/utils/logger.js';
import { query } from '../../shared/utils/db.js';
import { createQueue } from '../../shared/utils/redis.js';
import { DealSchema } from '../../shared/types/deal.schema.js';
import { chromium } from 'playwright';
import cron from 'node-cron';

const logger = createLogger('deal-discovery');
const dealQueue = createQueue('deals');

const DEAL_URLS = {
  deals: 'https://www.amazon.in/deals',
  bestsellers: 'https://www.amazon.in/gp/bestsellers',
  lightning: 'https://www.amazon.in/deals?filter=lightning',
  mobile: 'https://www.amazon.in/deals?filter=mobiles',
  electronics: 'https://www.amazon.in/deals?filter=electronics',
};

class DealDiscoveryAgent {
  constructor() {
    this.browser = null;
    this.isRunning = false;
  }

  async init() {
    logger.info('Initializing Deal Discovery Agent');
    this.browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    // Schedule periodic discovery
    cron.schedule('*/30 * * * *', () => this.discoverDeals());
    await this.discoverDeals(); // Immediate first run
  }

  async discoverDeals() {
    if (this.isRunning) {
      logger.warn('Discovery already running, skipping');
      return;
    }
    this.isRunning = true;

    try {
      logger.info('Starting deal discovery cycle');
      const allDeals = [];
      
      for (const [source, url] of Object.entries(DEAL_URLS)) {
        try {
          const deals = await this.scrapeDeals(url, source);
          allDeals.push(...deals);
          logger.info(`Found ${deals.length} deals from ${source}`);
        } catch (err) {
          logger.error(`Failed to scrape ${source}`, { error: err.message });
        }
        await new Promise(r => setTimeout(r, 5000)); // Rate limit
      }

      // Deduplicate and validate
      const uniqueDeals = this.deduplicateDeals(allDeals);
      const validDeals = await this.filterValidDeals(uniqueDeals);

      // Queue for analysis
      for (const deal of validDeals) {
        await dealQueue.add('analyze-deal', deal, {
          priority: deal.discountPct > 50 ? 1 : 2,
        });
      }

      logger.info(`Queued ${validDeals.length} deals for analysis`);
    } catch (err) {
      logger.error('Discovery cycle failed', { error: err.message });
    } finally {
      this.isRunning = false;
    }
  }

  async scrapeDeals(url, source) {
    const context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      viewport: { width: 1920, height: 1080 },
    });

    const page = await context.newPage();
    const deals = [];

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      
      // Handle anti-bot measures
      await this.handleAntiBot(page);
      
      // Extract deal cards
      const cards = await page.$$('[data-testid="deal-card"], .DealCard-module__dealCard_3v4t1, .s-result-item');
      
      for (const card of cards.slice(0, 50)) { // Limit to 50 per source
        try {
          const deal = await this.extractDealData(card, source);
          if (deal) deals.push(deal);
        } catch (err) {
          logger.debug('Failed to extract card', { error: err.message });
        }
      }
    } catch (err) {
      logger.error(`Scraping error for ${source}`, { error: err.message });
    } finally {
      await context.close();
    }

    return deals;
  }

  async handleAntiBot(page) {
    // Handle captcha or verification
    const captcha = await page.$('input[name="field-keywords"]');
    if (!captcha && await page.title().then(t => t.includes('Robot Check'))) {
      logger.warn('Anti-bot detected, rotating proxy/UA');
      throw new Error('Anti-bot triggered');
    }
    
    // Random mouse movements
    await page.mouse.move(
      Math.random() * 1000,
      Math.random() * 800
    );
  }

  async extractDealData(card, source) {
    try {
      const asin = await card.$eval('a[href*="/dp/"]', el => {
        const match = el.href.match(/\/dp\/([A-Z0-9]{10})/);
        return match ? match[1] : null;
      }).catch(() => null);

      if (!asin) return null;

      const title = await card.$eval('h2, .a-size-base-plus', el => el.innerText.trim()).catch(() => null);
      const priceText = await card.$eval('.a-price .a-offscreen', el => el.innerText).catch(() => null);
      const mrpText = await card.$eval('.a-text-price .a-offscreen', el => el.innerText).catch(() => null);
      const imageUrl = await card.$eval('img', el => el.src).catch(() => null);
      const rating = await card.$eval('.a-icon-alt', el => {
        const match = el.innerText.match(/([0-9.]+)/);
        return match ? parseFloat(match[1]) : null;
      }).catch(() => null);

      const price = this.parsePrice(priceText);
      const mrp = this.parsePrice(mrpText);

      if (!price || !title) return null;

      return DealSchema.parse({
        asin,
        title: title.slice(0, 500),
        imageUrl,
        productUrl: `https://www.amazon.in/dp/${asin}`,
        rating: rating || undefined,
        price,
        mrp: mrp || undefined,
        source: 'amazon',
      });
    } catch (err) {
      return null;
    }
  }

  parsePrice(text) {
    if (!text) return null;
    const match = text.replace(/,/g, '').match(/[\d.]+/);
    return match ? parseFloat(match[0]) : null;
  }

  deduplicateDeals(deals) {
    const seen = new Set();
    return deals.filter(d => {
      if (seen.has(d.asin)) return false;
      seen.add(d.asin);
      return true;
    });
  }

  async filterValidDeals(deals) {
    const valid = [];
    for (const deal of deals) {
      try {
        // Check if recently posted
        const result = await query(
          'SELECT 1 FROM posted_deals WHERE asin = $1 AND time > NOW() - INTERVAL \'24 hours\'',
          [deal.asin]
        );
        if (result.rowCount === 0) {
          valid.push(deal);
        }
      } catch (err) {
        logger.error('Validation error', { asin: deal.asin, error: err.message });
      }
    }
    return valid;
  }

  async shutdown() {
    if (this.browser) {
      await this.browser.close();
    }
    logger.info('Deal Discovery Agent shutdown');
  }
}

// Start agent
const agent = new DealDiscoveryAgent();
process.on('SIGINT', () => agent.shutdown().then(() => process.exit(0)));
agent.init().catch(err => {
  logger.error('Failed to start', err);
  process.exit(1);
});