import 'dotenv/config';
import { createLogger } from '../../shared/utils/logger.js';
import { query } from '../../shared/utils/db.js';
import { createQueue } from '../../shared/utils/redis.js';
import { DealSchema } from '../../shared/types/deal.schema.js';
import { 
  createStealthBrowser, 
  createStealthContext, 
  humanLikeScroll, 
  humanLikeMouseMove, 
  randomDelay, 
  safeGoto,
  closeBrowser 
} from '../../shared/utils/stealth-browser.js';
import { multiSourceIngestion, AffiliateFeedHandler } from '../../shared/utils/multi-source-ingestion.js';
import { Registry, Counter, Gauge, Histogram } from 'prom-client';
import express from 'express';
import cron from 'node-cron';
import {
  getScrapingQuota,
  tagDemandSignals,
  DEMAND_TIERS,
  MIN_PRICE_INR,
  MIN_PRICE_GROCERY_INR,
} from '../../shared/utils/demand-intelligence.js';

const logger = createLogger('deal-discovery');
const dealQueue = createQueue('deals');

// Prometheus metrics
const register = new Registry();
register.setDefaultLabels({ app: 'deal-discovery' });

const dealsDiscoveredTotal = new Counter({
  name: 'deals_discovered_total',
  help: 'Total deals discovered',
  labelNames: ['source'],
  registers: [register],
});

const dealsQueuedTotal = new Counter({
  name: 'deals_queued_total',
  help: 'Total deals queued for analysis',
  registers: [register],
});

const discoveryErrorsTotal = new Counter({
  name: 'discovery_errors_total',
  help: 'Total discovery errors',
  labelNames: ['source', 'type'],
  registers: [register],
});

const discoveryDuration = new Histogram({
  name: 'discovery_duration_seconds',
  help: 'Time spent discovering deals',
  labelNames: ['source'],
  buckets: [1, 5, 10, 30, 60, 120],
  registers: [register],
});

const activeDiscoveryGauge = new Gauge({
  name: 'discovery_active',
  help: 'Whether discovery is currently running',
  registers: [register],
});

// Worker status tracking
let isDiscoveryBusy = false;

// Start metrics server
const metricsApp = express();
metricsApp.use(express.json());

metricsApp.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Status endpoint - returns whether worker is idle
metricsApp.get('/status', (req, res) => {
  res.json({
    busy: isDiscoveryBusy,
    lastRun: agent.stats.lastRun,
    totalQueued: agent.stats.totalQueued,
  });
});

metricsApp.listen(3001, () => {
  logger.info('Metrics server running on port 3001');
});

// ── Affiliate configuration ──────────────────────────────
const AMAZON_AFFILIATE_TAG = process.env.AMAZON_AFFILIATE_TAG || process.env.AMAZON_ASSOCIATE_TAG;

// ── Helper to build affiliate URL ──────────────────────────────
function buildAffiliateUrl(productUrl, asin) {
  if (!AMAZON_AFFILIATE_TAG) {
    logger.warn('AMAZON_AFFILIATE_TAG not set, using product URL without affiliate tag');
    return productUrl;
  }
  
  try {
    // Ensure we have a valid product URL
    let url;
    if (!productUrl || productUrl === 'undefined') {
      url = new URL(`https://www.amazon.in/dp/${asin}`);
    } else {
      url = new URL(productUrl);
    }
    
    // Remove any existing affiliate tags
    url.searchParams.delete('tag');
    url.searchParams.delete('linkCode');
    url.searchParams.delete('ref');
    
    // Add our affiliate tag
    url.searchParams.set('tag', AMAZON_AFFILIATE_TAG);
    url.searchParams.set('linkCode', 'll1');
    url.searchParams.set('ref', 'as_li_ss_tl');
    
    return url.toString();
  } catch (e) {
    // Fallback: construct from ASIN
    return `https://www.amazon.in/dp/${asin}?tag=${AMAZON_AFFILIATE_TAG}&linkCode=ll1&ref=as_li_ss_tl`;
  }
}

// ── Helper to ensure product URL is valid ──────────────────────────────
function ensureValidProductUrl(href, asin) {
  if (!href || href === 'undefined' || href === 'null') {
    return `https://www.amazon.in/dp/${asin}`;
  }
  
  try {
    // If it's already a full URL
    if (href.startsWith('http')) {
      return href.split('?')[0];
    }
    
    // If it's a relative path
    if (href.startsWith('/')) {
      return `https://www.amazon.in${href.split('?')[0]}`;
    }
    
    // Default fallback
    return `https://www.amazon.in/dp/${asin}`;
  } catch (e) {
    return `https://www.amazon.in/dp/${asin}`;
  }
}

// Amazon.in URLs to scrape — balanced for volume + quality
// During sales, /deals often redirects to /events/* — include both
const DEAL_URLS = {
  // ── Main deal pages (highest priority) ──
  deals: 'https://www.amazon.in/deals',
  greatsale: 'https://www.amazon.in/events/greatsummersale',
  todaysdeals: 'https://www.amazon.in/gp/goldbox',
  lightning: 'https://www.amazon.in/deals?filter=lightning',

  // ── Trending / New product discovery ── (ADDED)
  // These surface products with high current demand, not just discounts
  newreleases:   'https://www.amazon.in/gp/new-releases',
  moversshakers: 'https://www.amazon.in/gp/movers-and-shakers',

  // ── Top-converting category bestsellers ──
  electronics: 'https://www.amazon.in/gp/bestsellers/electronics',
  mobiles: 'https://www.amazon.in/gp/bestsellers/electronics/1389432031',
  kitchen: 'https://www.amazon.in/gp/bestsellers/kitchen',
  fashion: 'https://www.amazon.in/gp/bestsellers/apparel',
  beauty: 'https://www.amazon.in/gp/bestsellers/beauty',
  headphones: 'https://www.amazon.in/gp/bestsellers/electronics/1388921031',
  laptops: 'https://www.amazon.in/gp/bestsellers/computers/1375424031',
  appliances: 'https://www.amazon.in/gp/bestsellers/appliances',
};

// Comprehensive selector sets for Amazon.in (updated May 2026)
// Amazon's deals page now uses hashed CSS module classes (ProductCard-module__card_*)
// and redirects /deals to /events/greatsummersale during sales
const DEAL_CARD_SELECTORS = [
  // ── New Amazon.in DOM (2026 Great Summer Sale onwards) ──
  '[class*="ProductCard-module__card"]',       // Primary: hashed card class
  '[class*="ProductCard-module__cardWrapper"]', // Card wrapper variant
  // ── Legacy selectors (fallback for non-sale pages) ──
  '[data-testid="deal-card"]',
  '[data-deal-id]',
  '[class*="DealCard-module"]',
  // Search result items
  '[data-component-type="s-search-result"]',
  '.s-result-item[data-asin]',
  // Bestseller items
  '.zg-grid-general-faceout',
  '.p13n-sc-uncoverable-faceout',
  '.zg-item-immersion',
  // Generic fallback — any element with data-asin
  '[data-asin]:not([data-asin=""])',
];

const TITLE_SELECTORS = [
  // New Amazon.in DOM
  'p span',                                     // Title inside ProductCard
  '.a-size-base.a-color-base.a-text-normal',
  // Legacy selectors
  'h2 a span',
  'h2 span',
  '.a-size-medium.a-color-base.a-text-normal',
  '.a-size-base-plus.a-color-base.a-text-normal',
  '.a-size-base.a-color-base',
  '.p13n-sc-truncate-desktop-type2',
  '.p13n-sc-truncated',
  '[class*="DealContent-module__truncate"]',
  '[data-testid="deal-title"]',
  'h2',
  '.a-link-normal span',
];

const PRICE_SELECTORS = [
  // New Amazon.in DOM
  'span[class*="a-price"] .a-offscreen',
  '.a-price:not(.a-text-price) .a-offscreen',
  '.a-price .a-offscreen',
  // Bestseller pages
  '.p13n-sc-price',
  '[class*="p13n-sc-price"]',
  '.a-color-price',
  // Legacy selectors
  '.a-price[data-a-color="price"] .a-offscreen',
  '[data-testid="deal-price"] .a-offscreen',
  '[class*="DealPrice-module"] .a-offscreen',
];

const MRP_SELECTORS = [
  // Standard deal pages
  '.a-text-price .a-offscreen',
  '.a-price.a-text-price .a-offscreen',
  '[data-a-strike="true"] .a-offscreen',
  '.a-text-strike',
  // Bestseller pages — strikethrough price
  'span.a-price[data-a-strike="true"] .a-offscreen',
  '.a-price[data-a-color="secondary"] .a-offscreen',
  '.a-text-price span.a-offscreen',
  // List price on bestseller cards
  '.a-size-small.a-color-secondary .a-text-price .a-offscreen',
  '.a-row .a-text-price .a-offscreen',
];

class DealDiscoveryAgent {
  constructor() {
    this.browser = null;
    this.isRunning = false;
    this.stats = {
      totalDiscovered: 0,
      totalQueued: 0,
      errors: 0,
      lastRun: null,
    };
  }

  async init() {
    logger.info('Initializing Deal Discovery Agent with stealth mode');
    this.browser = await createStealthBrowser();
    
    // Register multi-source handlers
    multiSourceIngestion.registerSource('affiliate_feed', new AffiliateFeedHandler());
    
    // Schedule periodic discovery — aggressive for growth phase
    // Main deal discovery every 45 min (deals expire fast on Amazon)
    cron.schedule('*/45 * * * *', () => this.discoverDeals());
    // Multi-source ingestion every 30 min
    cron.schedule('*/30 * * * *', () => this.ingestFromSources());
    // DISABLED: No longer wiping DB nightly — products now carry semantic tags worth preserving
    // cron.schedule('55 0 * * *', () => this.dailyDatabaseReset('end-of-day-shutdown'));
    
    // Fire-and-forget initial run — if it fails, cron will retry in 30 min
    this.discoverDeals().catch(err => logger.error('Initial discovery failed, cron will retry', { error: err.message }));
  }

  async ingestFromSources() {
    try {
      logger.info('Starting multi-source ingestion');
      const results = await multiSourceIngestion.ingestFromAllSources();
      logger.info('Multi-source ingestion completed', { results });
    } catch (error) {
      logger.error('Multi-source ingestion failed', { error: error.message });
    }
  }

  async cleanupOldProducts() {
    try {
      logger.info('Starting nightly database cleanup (deleting records older than 3 days)');
      
      const histResult = await query(`
        DELETE FROM price_history
        WHERE timestamp < NOW() - INTERVAL '3 days';
      `);
      logger.info(`Cleaned up ${histResult?.rowCount || 0} old price_history records`);

      const productResult = await query(`
        DELETE FROM products
        WHERE last_updated < NOW() - INTERVAL '3 days';
      `);
      logger.info(`Cleaned up ${productResult?.rowCount || 0} old products`);

    } catch (error) {
      logger.error('Database cleanup failed', { error: error.message });
    }
  }

  async dailyDatabaseReset(trigger = 'manual') {
    if (process.env.TESTING_MODE === 'true') {
      logger.info('TESTING_MODE is active, skipping daily production DB wipe', { trigger });
      return;
    }

    try {
      logger.info(`=== ${trigger}: Daily database reset before shutdown ===`);

      // Truncate all deal/posted tables so fresh deals can be discovered tomorrow
      const tables = [
        'posted_deals', 'products', 'price_history',
        'whatsapp_ingestion', 'engagement_posts',
        'affiliate_clicks', 'agent_metrics',
        'ab_test_assignments'
      ];

      for (const table of tables) {
        try {
          await query(`TRUNCATE TABLE ${table} CASCADE`);
          logger.info(`Cleared table: ${table}`);
        } catch (err) {
          logger.warn(`Failed to clear ${table}`, { error: err.message });
        }
      }

      logger.info(`=== ${trigger}: Database cleared successfully ===`);
    } catch (error) {
      logger.error('Failed to clear database', { error: error.message });
    }
  }

  async discoverDeals() {
    if (this.isRunning) {
      logger.warn('Discovery already running, skipping');
      return;
    }
    this.isRunning = true;
    isDiscoveryBusy = true;
    activeDiscoveryGauge.set(1);

    try {
      logger.info('Starting deal discovery cycle');
      const seenAsins = new Set(); // Cross-category dedup within this cycle
      let totalDiscovered = 0;
      let totalQueued = 0;
      
      for (const [source, url] of Object.entries(DEAL_URLS)) {
        const sourceStart = Date.now();
        try {
          const deals = await this.scrapeDeals(url, source);
          dealsDiscoveredTotal.inc({ source }, deals.length);
          logger.info(`Found ${deals.length} deals from ${source}`);
          
          if (deals.length === 0) {
            discoveryDuration.observe({ source }, (Date.now() - sourceStart) / 1000);
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }

          // ── Demand gate: apply per-category quota ──────────────────────────────
          // S-tier: 15 items, A-tier: 10, B-tier: 3, C-tier: 1
          const quota = getScrapingQuota(source);
          const quotaApplied = deals.slice(0, quota);
          if (deals.length > quota) {
            logger.info(`Quota applied for ${source}: ${deals.length} → ${quotaApplied.length} (tier quota: ${quota})`);
          }

          // ── Price floor pre-filter ────────────────────────────────────────────
          // Skip items below minimum price threshold before wasting analysis cycles
          const priceFiltered = quotaApplied.filter(deal => {
            const cat = (deal.category || source || 'general').toLowerCase();
            const floor = cat === 'grocery' ? MIN_PRICE_GROCERY_INR : MIN_PRICE_INR;
            if (deal.price && deal.price < floor) {
              logger.debug(`Pre-filter: ${deal.asin} below price floor (₹${deal.price} < ₹${floor})`);
              return false;
            }
            return true;
          });

          // ── Tag demand signals on each deal ────────────────────────────────
          // Enriches deal objects with newLaunch, trending, risingStar flags
          // These propagate to deal-analysis for demand scoring + AI context
          const taggedDeals = priceFiltered.map(deal => tagDemandSignals(deal));

          // Dedup within this cycle (across categories)
          const uniqueDeals = taggedDeals.filter(d => {
            if (seenAsins.has(d.asin)) return false;
            seenAsins.add(d.asin);
            return true;
          });
          
          // Filter against DB (already posted in 24h etc.)
          const validDeals = await this.filterValidDeals(uniqueDeals);
          
          if (validDeals.length > 0) {
            // Immediately stream to analysis — don't wait for all categories
            logger.info(`Streaming ${validDeals.length} deals from ${source} to analysis`);
            let sent = 0;
            for (const deal of validDeals) {
              // ── Deep Scrape Bank Offers for High-Value Items ──
              if (deal.price >= 1000) {
                logger.info(`Deep scraping bank offers for high-value deal ${deal.asin} (₹${deal.price})`);
                const bankOffers = await this.deepScrapeBankOffers(deal.productUrl);
                if (bankOffers) {
                  deal.bankOffers = bankOffers;
                  logger.info(`Found bank offer: ${bankOffers}`, { asin: deal.asin });
                }
              }

              try {
                await fetch('http://deal-analysis:3002/direct-analyze', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(deal),
                });
                sent++;
              } catch (err) {
                // Fallback to queue
                await dealQueue.add('analyze-deal', deal, {
                  priority: (deal.mrp && deal.price && ((deal.mrp - deal.price) / deal.mrp * 100) > 50) ? 1 : 2,
                });
                sent++;
              }
            }
            totalQueued += sent;
            logger.info(`Sent ${sent} deals from ${source} to analysis pipeline`);
          }
          
          totalDiscovered += deals.length;
        } catch (err) {
          discoveryErrorsTotal.inc({ source, type: 'scrape' });
          logger.error(`Failed to scrape ${source}`, { error: err.message });
        }
        discoveryDuration.observe({ source }, (Date.now() - sourceStart) / 1000);
        await new Promise(r => setTimeout(r, 3000)); // Rate limit between sources
      }

      dealsQueuedTotal.inc(totalQueued);
      this.stats.totalDiscovered += totalDiscovered;
      this.stats.totalQueued += totalQueued;
      
      logger.info(`Discovery cycle complete: ${totalDiscovered} found, ${seenAsins.size} unique, ${totalQueued} queued`);
    } catch (err) {
      discoveryErrorsTotal.inc({ source: 'all', type: 'cycle' });
      logger.error('Discovery cycle failed', { error: err.message });
    } finally {
      this.isRunning = false;
      isDiscoveryBusy = false;
      activeDiscoveryGauge.set(0);
      this.stats.lastRun = new Date().toISOString();
    }
  }

  async scrapeDeals(url, source) {
    const context = await createStealthContext(this.browser);
    const page = await context.newPage();
    const deals = [];

    try {
      // Use stealth navigation with retry logic
      await safeGoto(page, url);
      
      // Human-like behavior
      await humanLikeMouseMove(page);
      await randomDelay(2000, 4000);
      await humanLikeScroll(page);
      await randomDelay(1000, 2000);

      // Wait for page to settle
      await page.waitForLoadState('networkidle').catch(() => {});
      await randomDelay(1000, 2000);

      // Try to find deal cards using multiple selector strategies
      let cards = [];

      // Strategy 1: Try each selector set individually
      for (const selector of DEAL_CARD_SELECTORS) {
        try {
          const found = await page.$$(selector);
          if (found.length > 0) {
            logger.info(`Found ${found.length} cards with selector: ${selector} on ${source}`);
            cards = found;
            break;
          }
        } catch (e) {
          // continue
        }
      }

      // Strategy 2: If no cards found, try page-level extraction via evaluate
      if (cards.length === 0) {
        logger.warn(`No cards via selectors for ${source}, trying page-level extraction`);
        const pageDeals = await this.extractDealsFromPage(page, source);
        deals.push(...pageDeals);
      } else {
        // Extract from found cards — 18 per source for good volume
        for (const card of cards.slice(0, 18)) {
          try {
            const deal = await this.extractDealData(card, page, source);
            if (deal) deals.push(deal);
          } catch (err) {
            logger.debug('Failed to extract card', { error: err.message });
          }
        }
      }

      this.stats.totalDiscovered += deals.length;
      logger.info(`Extracted ${deals.length} deals from ${source}`);
    } catch (err) {
      logger.error(`Scraping error for ${source}`, { error: err.message });
      this.stats.errors++;
    } finally {
      await context.close();
    }

    return deals;
  }

  async deepScrapeBankOffers(url) {
    if (!this.browser) return null;
    const context = await createStealthContext(this.browser);
    const page = await context.newPage();
    try {
      await safeGoto(page, url);
      await page.waitForTimeout(1500); // Wait for dynamic offer sections
      
      const bankOfferText = await page.evaluate(() => {
        // Try to find the exact instant discount text
        const offerBlocks = document.querySelectorAll('#itembox-Bank-Offer, #itembox-Instant-Bank-Discount, .offers-items-content, #bank-offers-container');
        for (const block of offerBlocks) {
          const text = block.innerText || block.textContent;
          if (text && (text.includes('HDFC') || text.includes('ICICI') || text.includes('SBI') || text.includes('Axis') || text.includes('Kotak'))) {
            return text.trim();
          }
        }
        
        // Fallback: look for generic bank offer tags
        const bullets = document.querySelectorAll('#feature-bullets li span');
        for (const bullet of bullets) {
          const text = bullet.innerText || bullet.textContent;
          if (text && text.includes('Bank Offer') && (text.includes('HDFC') || text.includes('ICICI') || text.includes('SBI'))) {
            return text.trim();
          }
        }
        return null;
      });
      
      if (bankOfferText) {
        let clean = bankOfferText.replace(/\s+/g, ' ').trim();
        
        // Deduplicate common Amazon offer text repetitions using intelligent splitting
        const splitMatch = clean.substring(1).match(/\s+(Upto|Up to|Flat|Extra|₹\d+|INR \d+|\d+%)\s+/i);
        if (splitMatch) {
          const index = splitMatch.index + 1;
          const part1 = clean.substring(0, index).trim();
          const part2 = clean.substring(index).trim();
          if (part1.startsWith(part2.substring(0, 15)) || part2.startsWith(part1.substring(0, 15))) {
            clean = part1;
          }
        }
        
        // General exact duplication fallback
        clean = clean.replace(/(.{15,}?)\s+\1/gi, '$1').trim();

        // If it's still a massive block of text, try to extract just the first relevant offer
        if (clean.length > 120) {
           const match = clean.match(/(?:(?:Flat|Up to|Extra).*?(?:discount|off|cashback).*?(?:HDFC|ICICI|SBI|Axis|Kotak).*?)(?=\.|\n|$)/i) ||
                         clean.match(/(?:HDFC|ICICI|SBI|Axis|Kotak).*?(?:discount|off|cashback).*?(?:₹\d+|INR \d+|\d+%).*?(?=\.|\n|$)/i);
           if (match) clean = match[0].trim();
           else clean = clean.substring(0, 117) + '...';
        }
        return clean;
      }
      return null;
    } catch (e) {
      logger.debug(`Deep scrape failed for ${url}`, { error: e.message });
      return null;
    } finally {
      await context.close();
    }
  }

  // Page-level extraction using page.evaluate() — more robust against selector changes
  async extractDealsFromPage(page, source) {
    try {
      const rawDeals = await page.evaluate(() => {
        const results = [];
        const seenAsins = new Set();

        // ── Strategy 1: Find all product links with /dp/ASIN pattern ──
        // This is the most reliable method since ASINs always appear in URLs
        const dpLinks = document.querySelectorAll('a[href*="/dp/"]');
        
        for (const link of Array.from(dpLinks).slice(0, 25)) {
          try {
            const match = link.href.match(/\/dp\/([A-Z0-9]{10})/);
            if (!match) continue;
            const asin = match[1];
            if (seenAsins.has(asin)) continue;
            seenAsins.add(asin);

            // Find the scoped container for THIS exact product.
            // Use closest() to find the nearest product-card ancestor.
            // NOTE: do NOT include Amazon's generic layout classes (.a-section, .a-row)
            // — they match broad containers that hold many products.
            let container = link.closest(
              '[class*="ProductCard"], [class*="DealCard"], [class*="s-result-item"], ' +
              '[class*="zg-item"], [class*="p13n-sc-uncoverable"], [class*="zg-grid-general"], ' +
              '[data-asin]'
            );
            // Fallback 1: walk up 2 levels from the link (parent or grandparent)
            if (!container) {
              container = link.parentElement?.parentElement || link.parentElement;
            }
            // Sanity check: container must actually contain the link
            if (!container || !container.contains(link)) {
              container = link.parentElement;
            }

            // Extract title — try multiple strategies
            const titleEl = container.querySelector(
              'p span, h2 a span, h2 span, ' +
              '.a-size-medium, .a-size-base-plus, .a-size-base.a-color-base, ' +
              '.a-size-base.a-text-normal, [class*="truncate"], ' +
              '.p13n-sc-truncated, [data-testid="deal-title"]'
            );
            const title = titleEl?.innerText?.trim() || titleEl?.textContent?.trim();
            if (!title || title.length < 5) continue;

            // Extract price
            const priceEl = container.querySelector(
              '.a-price:not(.a-text-price) .a-offscreen, ' +
              '.a-price .a-offscreen, .a-color-price'
            );
            const priceText = priceEl?.innerText || priceEl?.textContent;

            // Extract MRP (original / strikethrough price)
            const mrpEl = container.querySelector(
              '.a-text-price .a-offscreen, ' +
              '[data-a-strike="true"] .a-offscreen, ' +
              '.a-text-strike, ' +
              'span.a-price[data-a-strike] .a-offscreen, ' +
              '.a-price[data-a-color="secondary"] .a-offscreen, ' +
              '.a-row .a-text-price .a-offscreen'
            );
            const mrpText = mrpEl?.innerText || mrpEl?.textContent;
            
            // If no MRP found, try to get it from a second .a-price element (common on bestseller cards)
            let finalMrpText = mrpText;
            if (!finalMrpText) {
              const allPriceEls = container.querySelectorAll('.a-price .a-offscreen');
              if (allPriceEls.length >= 2) {
                // Second a-price is usually the MRP
                const secondPrice = allPriceEls[1]?.innerText || allPriceEls[1]?.textContent;
                if (secondPrice) finalMrpText = secondPrice;
              }
            }

            // Extract discount percentage to reconstruct MRP if missing
            const fullText = container.innerText || container.textContent || '';
            const discountMatch = fullText.match(/(\d{1,2})%\s*(?:off)?/i);
            const discountText = discountMatch ? discountMatch[1] : null;

            // Extract image
            const imgEl = container.querySelector(
              'img[src*="images-amazon"], img[src*="m.media-amazon"], ' +
              'img[src*="ssl-images"], img[data-src]'
            );
            const imageUrl = imgEl?.src || imgEl?.getAttribute('data-src');

            // Extract rating
            const ratingEl = container.querySelector('.a-icon-alt, [aria-label*="out of 5"]');
            const ratingText = ratingEl?.innerText || ratingEl?.getAttribute('aria-label');

            // Extract review count
            let reviewText = null;
            const reviewEls = container.querySelectorAll('.a-size-small .a-link-normal, [aria-label*="ratings"], .a-size-base.s-underline-text');
            for (const el of reviewEls) {
              const text = el.innerText || el.textContent || el.getAttribute('aria-label') || '';
              if (text.toLowerCase().includes('bought') || text.toLowerCase().includes('view')) continue;
              if (text.match(/^[0-9,.\sKkMm+]+$/) || text.match(/[0-9]+.*ratings?/i)) {
                reviewText = text;
              }
            }

            results.push({ asin, title, priceText, mrpText: finalMrpText, discountText, imageUrl, ratingText, reviewText, href: link.href });
          } catch (e) {
            // skip this element
          }
        }

        // ── Strategy 2 (fallback): data-asin elements (legacy pages) ──
        if (results.length === 0) {
          const asinElements = document.querySelectorAll('[data-asin]:not([data-asin=""])');
          for (const el of Array.from(asinElements).slice(0, 20)) {
            try {
              const asin = el.getAttribute('data-asin');
              if (!asin || asin.length !== 10 || seenAsins.has(asin)) continue;
              seenAsins.add(asin);
              const titleEl = el.querySelector('h2 a span, h2 span, .a-size-medium, .a-size-base-plus');
              const title = titleEl?.innerText?.trim() || titleEl?.textContent?.trim();
              if (!title || title.length < 5) continue;
              const priceEl = el.querySelector('.a-price:not(.a-text-price) .a-offscreen');
              const priceText = priceEl?.innerText || priceEl?.textContent;
              const mrpEl = el.querySelector('.a-text-price .a-offscreen');
              const mrpText = mrpEl?.innerText || mrpEl?.textContent;
              const imgEl = el.querySelector('img[src*="amazon"], img[data-src]');
              const imageUrl = imgEl?.src || imgEl?.getAttribute('data-src');
              const linkEl = el.querySelector('a[href*="/dp/"]');
              const fullText = el.innerText || el.textContent || '';
              const discountMatch = fullText.match(/(\d{1,2})%\s*(?:off)?/i);
              const discountText = discountMatch ? discountMatch[1] : null;
              results.push({ asin, title, priceText, mrpText, discountText, imageUrl, ratingText: null, reviewText: null, href: linkEl?.href });
            } catch (e) { /* skip */ }
          }
        }

        return results;
      });

      const deals = [];
      for (const raw of rawDeals) {
        try {
          const deal = this.buildDealFromRaw(raw, source);
          if (deal) deals.push(deal);
        } catch (e) {
          // skip
        }
      }
      return deals;
    } catch (err) {
      logger.error(`Page-level extraction failed for ${source}`, { error: err.message });
      return [];
    }
  }

  buildDealFromRaw(raw, source) {
    const { asin, title, priceText, mrpText, discountText, imageUrl, ratingText, reviewText, href } = raw;
    if (!asin || !title) return null;

    // Validate: extracted href must contain the ASIN (catches container scope errors)
    if (href && !href.includes(asin)) {
      logger.warn('Scraper scope error: href does not contain ASIN, rejecting deal', { asin, hrefPreview: href.substring(0, 80) });
      return null;
    }

    const price = this.parsePrice(priceText);
    if (!price) return null;

    let mrp = this.parsePrice(mrpText);

    // Reconstruct MRP from discount text if MRP is missing
    if (!mrp && discountText && price) {
      const discountPct = parseInt(discountText, 10);
      if (discountPct > 0 && discountPct < 100) {
        mrp = Math.round(price / (1 - discountPct / 100));
      }
    }

    // Parse rating
    let rating = null;
    if (ratingText) {
      const m = ratingText.match(/([0-9.]+)\s*out of/i) || ratingText.match(/^([0-9.]+)/);
      if (m) rating = parseFloat(m[1]);
    }

    // Parse review count (ratings)
    let reviewCount = null;
    if (reviewText) {
      // Remove rating text if accidentally captured
      const textWithoutRating = reviewText.replace(/[0-9.]+\s*out of\s*[0-9.]+\s*stars?/gi, '');
      const cleaned = textWithoutRating.replace(/,/g, '');
      
      // Look for explicit thousands (K)
      if (cleaned.match(/(\d+(?:\.\d+)?)\s*[Kk]\+?/)) {
        const m = cleaned.match(/(\d+(?:\.\d+)?)\s*[Kk]\+?/);
        reviewCount = Math.round(parseFloat(m[1]) * 1000);
      } else {
        const m = cleaned.match(/([0-9]{2,})/); // Must be at least 2 digits to ignore random '4'
        if (m) reviewCount = parseInt(m[1]);
      }
    }

    // Build product URL (ensure it's valid)
    const productUrl = ensureValidProductUrl(href, asin);
    
    // Build affiliate URL
    const affiliateUrl = buildAffiliateUrl(productUrl, asin);

    try {
      const deal = DealSchema.parse({
        asin,
        title: title.slice(0, 500),
        category: source !== 'deals' && source !== 'bestsellers' ? source : undefined,
        imageUrl: imageUrl || undefined,
        productUrl,
        affiliateUrl,
        rating: rating || undefined,
        reviewCount: reviewCount || undefined,
        price,
        mrp: mrp || undefined,
        source: 'amazon',
      });
      
      return deal;
    } catch (e) {
      return null;
    }
  }

  async validateProductUrl(url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(url, {
        method: 'HEAD',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      return response.status === 200;
    } catch (err) {
      logger.debug(`URL validation error for ${url}: ${err.message}`);
      return false;
    }
  }

  async extractDealData(card, page, source) {
    try {
      // Try to get ASIN from data attribute first
      let asin = await card.getAttribute('data-asin').catch(() => null);
      
      // Fallback: extract from link href
      if (!asin || asin.length !== 10) {
        asin = await card.$eval('a[href*="/dp/"]', el => {
          const match = el.href.match(/\/dp\/([A-Z0-9]{10})/);
          return match ? match[1] : null;
        }).catch(() => null);
      }

      if (!asin || asin.length !== 10) return null;

      // Try multiple title selectors
      let title = null;
      for (const sel of TITLE_SELECTORS) {
        title = await card.$eval(sel, el => el.innerText?.trim() || el.textContent?.trim()).catch(() => null);
        if (title && title.length > 5) break;
      }

      // Try multiple price selectors
      let priceText = null;
      for (const sel of PRICE_SELECTORS) {
        priceText = await card.$eval(sel, el => el.innerText || el.textContent).catch(() => null);
        if (priceText) break;
      }

      // Try multiple MRP selectors
      let mrpText = null;
      for (const sel of MRP_SELECTORS) {
        mrpText = await card.$eval(sel, el => el.innerText || el.textContent).catch(() => null);
        if (mrpText) break;
      }
      
      // Fallback: if no MRP found, try the second .a-price element (common on bestseller cards)
      if (!mrpText) {
        mrpText = await card.$$eval('.a-price .a-offscreen', els => {
          if (els.length >= 2) return els[1].innerText || els[1].textContent;
          return null;
        }).catch(() => null);
      }

      let discountText = null;
      if (!mrpText) {
        discountText = await card.evaluate(el => {
          const match = (el.innerText || el.textContent || '').match(/(\d{1,2})%\s*(?:off)?/i);
          return match ? match[1] : null;
        }).catch(() => null);
      }

      const imageUrl = await card.$eval('img', el => el.src || el.getAttribute('data-src')).catch(() => null);
      
      const ratingText = await card.$eval('.a-icon-alt, [aria-label*="out of 5"]', el => 
        el.innerText || el.getAttribute('aria-label')
      ).catch(() => null);

      // Fallback: look for the second .a-link-normal or something that looks like a count
      let reviewText = await card.evaluate(el => {
        const els = el.querySelectorAll('.a-size-small .a-link-normal, [aria-label*="ratings"], .a-size-base.s-underline-text');
        for (const e of els) {
          const txt = e.innerText || e.textContent || e.getAttribute('aria-label') || '';
          if (txt.toLowerCase().includes('bought') || txt.toLowerCase().includes('view')) continue;
          if (txt.match(/^[0-9,.\sKkMm+]+$/) || txt.match(/[0-9]+.*ratings?/i)) {
            return txt;
          }
        }
        return null;
      }).catch(() => null);

      const price = this.parsePrice(priceText);
      let mrp = this.parsePrice(mrpText);

      // Reconstruct MRP from discount percentage if missing
      if (!mrp && discountText && price) {
        const discountPct = parseInt(discountText, 10);
        if (discountPct > 0 && discountPct < 100) {
          mrp = Math.round(price / (1 - discountPct / 100));
        }
      }

      if (!price || !title) return null;

      // Validate card scope: the card must contain a link with the expected ASIN
      const hrefCheck = await card.$eval('a[href*="/dp/"]', el => el.href).catch(() => null);
      if (!hrefCheck || !hrefCheck.includes(asin)) {
        logger.warn('Card scope error: card does not contain link with ASIN, rejecting', { asin, hrefPreview: hrefCheck?.substring(0, 80) });
        return null;
      }

      let rating = null;
      if (ratingText) {
        const m = ratingText.match(/([0-9.]+)\s*out of/i) || ratingText.match(/^([0-9.]+)/);
        if (m) rating = parseFloat(m[1]);
      }

      let reviewCount = null;
      if (reviewText) {
        const m = reviewText.replace(/,/g, '').match(/([0-9]+)/);
        if (m) reviewCount = parseInt(m[1]);
      }

      const productUrl = `https://www.amazon.in/dp/${asin}`;
      const affiliateUrl = buildAffiliateUrl(productUrl, asin);
      
      const deal = DealSchema.parse({
        asin,
        title: title.slice(0, 500),
        category: source !== 'deals' && source !== 'bestsellers' ? source : undefined,
        imageUrl: imageUrl || undefined,
        productUrl,
        affiliateUrl,
        rating: rating || undefined,
        reviewCount: reviewCount || undefined,
        price,
        mrp: mrp || undefined,
        source: 'amazon',
      });
      
      return deal;
    } catch (err) {
      return null;
    }
  }

  parsePrice(text) {
    if (!text) return null;
    // Remove currency symbols and whitespace
    const cleaned = text.replace(/[₹$,\s]/g, '');
    // Match Indian number formats: 1,234.56 or 1234.00 or 12,999
    const match = cleaned.match(/[\d,]+\.?\d{0,2}/);
    if (!match) return null;
    // Remove commas, keep decimal point for correct parsing
    const numeric = match[0].replace(/,/g, '');
    const val = parseFloat(numeric);
    // Amazon India shows prices in rupees directly (e.g. 270.00 = ₹270)
    return val > 0 ? val : null;
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
        // Check 1: Was this deal posted TODAY (IST calendar day)?
        const postedResult = await query(
          `SELECT time, deal_score FROM posted_deals 
           WHERE asin = $1 AND time > (NOW() AT TIME ZONE 'Asia/Kolkata')::date AT TIME ZONE 'Asia/Kolkata'
           ORDER BY time DESC LIMIT 1`,
          [deal.asin]
        );
        
        if (postedResult.rowCount > 0) {
          // Already posted in last 24h — only allow if price dropped significantly
          const lastPostedPrice = await query(
            `SELECT price FROM price_history 
             WHERE asin = $1 AND time > NOW() - INTERVAL '48 hours'
             ORDER BY time DESC LIMIT 1`,
            [deal.asin]
          );
          
          if (lastPostedPrice.rowCount > 0 && deal.price) {
            const prevPrice = lastPostedPrice.rows[0].price;
            const priceDrop = ((prevPrice - deal.price) / prevPrice) * 100;
            
            if (priceDrop >= 5) {
              // Price dropped 5%+ since last record — worth reposting
              deal._priceDropPct = Math.round(priceDrop);
              deal._isReprice = true;
              logger.info(`Price drop detected for ${deal.asin}: ${priceDrop.toFixed(1)}% (₹${prevPrice} → ₹${deal.price})`);
              valid.push(deal);
            } else {
              // Not worth reposting, but still update DB with fresh scraped data
              await query(
                `UPDATE products SET
                   price = COALESCE($2, price),
                   mrp = COALESCE($3, mrp),
                   rating = COALESCE($4, rating),
                   review_count = COALESCE($5, review_count),
                   discount_pct = COALESCE($6, discount_pct),
                   image_url = COALESCE($7, image_url),
                   last_updated = NOW()
                 WHERE asin = $1`,
                [
                  deal.asin,
                  deal.price || null,
                  deal.mrp || null,
                  deal.rating || null,
                  deal.reviewCount || null,
                  deal.mrp && deal.price ? Math.round((1 - deal.price / deal.mrp) * 100) : null,
                  deal.imageUrl || null,
                ]
              );
              logger.debug(`Updated DB for ${deal.asin} (no repost, price stable)`);
            }
          }
          continue;
        }
        
        // Check 2: Was this deal queued for analysis recently? (avoid redundant analysis work)
        const analyzedResult = await query(
          `SELECT 1 FROM products 
           WHERE asin = $1 AND last_updated > NOW() - INTERVAL '12 hours'`,
          [deal.asin]
        );
        
        if (analyzedResult.rowCount > 0) {
          // Already analyzed in last 12h but not posted — might have been scored too low
          // Still allow it through (scoring thresholds may have changed)
          valid.push(deal);
          continue;
        }
        
        // New deal — always allow
        valid.push(deal);
      } catch (err) {
        // If DB check fails, still include the deal
        logger.warn('DB validation error, including deal anyway', { asin: deal.asin, error: err.message });
        valid.push(deal);
      }
    }
    
    logger.info(`Dedup filter: ${deals.length} in → ${valid.length} valid (${deals.length - valid.length} skipped as recent duplicates)`);
    return valid;
  }

  async shutdown() {
    if (this.browser) {
      await closeBrowser(this.browser);
    }
    logger.info('Deal Discovery Agent shutdown');
  }
}

// Start agent
const agent = new DealDiscoveryAgent();
process.on('SIGINT', () => agent.shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => agent.shutdown().then(() => process.exit(0)));
agent.init().catch(err => {
  logger.error('Failed to start', err);
  process.exit(1);
});
