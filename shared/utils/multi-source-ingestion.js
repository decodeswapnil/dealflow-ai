import { createLogger } from './logger.js';
import { createQueue } from './redis.js';

const logger = createLogger('multi-source-ingestion');

// Lazy-initialized queue — avoids creating a Redis connection on import
let _dealQueue = null;
function getDealQueue() {
  if (!_dealQueue) _dealQueue = createQueue('deals');
  return _dealQueue;
}

// Source configurations
const SOURCES = {
  telegram: {
    name: 'Telegram Channels',
    enabled: process.env.TELEGRAM_SOURCE_ENABLED === 'true',
    channels: process.env.TELEGRAM_SOURCE_CHANNELS?.split(',') || [],
    weight: 0.8, // Trust weight
  },
  whatsapp: {
    name: 'WhatsApp Groups',
    enabled: process.env.WHATSAPP_SOURCE_ENABLED === 'true',
    groups: process.env.WHATSAPP_SOURCE_GROUPS?.split(',') || [],
    weight: 0.6,
  },
  affiliate_feed: {
    name: 'Affiliate Feeds',
    enabled: process.env.AFFILIATE_FEED_ENABLED === 'true',
    feeds: process.env.AFFILIATE_FEED_URLS?.split(',') || [],
    weight: 0.9,
  },
  deal_aggregator: {
    name: 'Deal Aggregators',
    enabled: process.env.DEAL_AGGREGATOR_ENABLED === 'true',
    sites: process.env.DEAL_AGGREGATOR_SITES?.split(',') || [],
    weight: 0.5,
  },
};

export class MultiSourceIngestion {
  constructor() {
    this.sources = new Map();
    this.ingestionStats = {
      totalProcessed: 0,
      bySource: {},
      duplicatesFiltered: 0,
      qualityFiltered: 0,
    };
  }

  registerSource(name, handler) {
    this.sources.set(name, handler);
    logger.info(`Registered source: ${name}`);
  }

  async ingestFromAllSources() {
    logger.info('Starting multi-source ingestion cycle');
    const results = [];

    for (const [sourceName, config] of Object.entries(SOURCES)) {
      if (!config.enabled) {
        logger.info(`Source ${sourceName} is disabled, skipping`);
        continue;
      }

      try {
        const deals = await this.ingestFromSource(sourceName, config);
        results.push({ source: sourceName, deals: deals.length });
        logger.info(`Ingested ${deals.length} deals from ${sourceName}`);
      } catch (error) {
        logger.error(`Failed to ingest from ${sourceName}`, { error: error.message });
        results.push({ source: sourceName, deals: 0, error: error.message });
      }
    }

    return results;
  }

  async ingestFromSource(sourceName, config) {
    const handler = this.sources.get(sourceName);
    if (!handler) {
      throw new Error(`No handler registered for source: ${sourceName}`);
    }

    const rawDeals = await handler.fetch(config);
    const processedDeals = [];

    for (const deal of rawDeals) {
      try {
        // Add source metadata
        deal.source = sourceName;
        deal.sourceWeight = config.weight;
        deal.ingestedAt = new Date().toISOString();

        // Validate and normalize
        const normalizedDeal = await this.normalizeDeal(deal);
        if (!normalizedDeal) {
          this.ingestionStats.qualityFiltered++;
          continue;
        }

        // Check for duplicates
        const isDuplicate = await this.checkDuplicate(normalizedDeal);
        if (isDuplicate) {
          this.ingestionStats.duplicatesFiltered++;
          continue;
        }

        // Queue for analysis
        await getDealQueue().add('analyze-deal', normalizedDeal, {
          priority: this.calculatePriority(normalizedDeal),
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
        });

        processedDeals.push(normalizedDeal);
        this.ingestionStats.totalProcessed++;
        
        // Update source stats
        this.ingestionStats.bySource[sourceName] = (this.ingestionStats.bySource[sourceName] || 0) + 1;

      } catch (error) {
        logger.error(`Failed to process deal from ${sourceName}`, { error: error.message });
      }
    }

    return processedDeals;
  }

  async normalizeDeal(deal) {
    // Extract ASIN if present
    const asin = this.extractASIN(deal.url || deal.productUrl || '');
    if (!asin && !deal.asin) {
      logger.warn('Deal missing ASIN, skipping');
      return null;
    }

    // Normalize price fields
    const price = this.parsePrice(deal.price);
    const mrp = this.parsePrice(deal.mrp || deal.originalPrice);

    if (!price || price <= 0) {
      logger.warn('Invalid price, skipping deal');
      return null;
    }

    return {
      asin: deal.asin || asin,
      title: this.sanitizeTitle(deal.title),
      price,
      mrp: mrp || null,
      discount: mrp ? Math.round(((mrp - price) / mrp) * 100) : 0,
      imageUrl: deal.imageUrl,
      productUrl: deal.url || deal.productUrl || `https://www.amazon.in/dp/${asin}`,
      rating: deal.rating ? parseFloat(deal.rating) : null,
      reviewCount: deal.reviewCount ? parseInt(deal.reviewCount) : null,
      category: deal.category || 'general',
      source: deal.source,
      sourceWeight: deal.sourceWeight,
      ingestedAt: deal.ingestedAt,
    };
  }

  extractASIN(url) {
    if (!url) return null;
    
    // Match ASIN patterns
    const patterns = [
      /\/dp\/([A-Z0-9]{10})/,
      /\/gp\/product\/([A-Z0-9]{10})/,
      /\/ASIN\/([A-Z0-9]{10})/,
      /[?&]asin=([A-Z0-9]{10})/i,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }

    return null;
  }

  parsePrice(priceText) {
    if (typeof priceText === 'number') return priceText;
    if (!priceText) return null;

    // Remove currency symbols and commas
    const cleaned = priceText.toString().replace(/[₹,\s]/g, '');
    const match = cleaned.match(/[\d.]+/);
    return match ? parseFloat(match[0]) : null;
  }

  sanitizeTitle(title) {
    if (!title) return 'Unknown Product';
    
    return title
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 500);
  }

  async checkDuplicate(deal) {
    // Check Redis cache for recent duplicates
    const { redis } = await import('./redis.js');
    const key = `deal:asin:${deal.asin}`;
    const exists = await redis.get(key);
    
    if (exists) {
      return true;
    }

    // Set cache for 24 hours
    await redis.setex(key, 86400, '1');
    return false;
  }

  calculatePriority(deal) {
    let priority = 2; // Default

    // Higher priority for better deals
    if (deal.discount > 50) priority = 1;
    if (deal.discount > 70) priority = 0;

    // Adjust by source weight
    if (deal.sourceWeight > 0.8) priority = Math.max(0, priority - 1);

    return priority;
  }

  getStats() {
    return {
      ...this.ingestionStats,
      sources: Object.keys(this.sources).length,
      activeSources: Object.entries(SOURCES).filter(([_, config]) => config.enabled).length,
    };
  }
}

// Source handlers
export class TelegramSourceHandler {
  constructor() {
    this.logger = createLogger('telegram-source');
  }

  async fetch(config) {
    // This would integrate with Telegram API to fetch messages
    // For now, return empty array as placeholder
    this.logger.info('Fetching from Telegram channels', { channels: config.channels });
    return [];
  }
}

export class WhatsAppSourceHandler {
  constructor() {
    this.logger = createLogger('whatsapp-source');
  }

  async fetch(config) {
    // This would integrate with WhatsApp Web to fetch messages
    this.logger.info('Fetching from WhatsApp groups', { groups: config.groups });
    return [];
  }
}

export class AffiliateFeedHandler {
  constructor() {
    this.logger = createLogger('affiliate-feed');
  }

  async fetch(config) {
    const deals = [];
    
    for (const feedUrl of config.feeds) {
      try {
        const response = await fetch(feedUrl, {
          headers: {
            'Accept': 'application/json,application/xml,text/xml',
            'User-Agent': 'Mozilla/5.0 (compatible; DealBot/1.0)',
          },
        });

        if (!response.ok) continue;

        const contentType = response.headers.get('content-type');
        if (contentType?.includes('json')) {
          const data = await response.json();
          deals.push(...this.parseJsonFeed(data));
        } else if (contentType?.includes('xml')) {
          const text = await response.text();
          deals.push(...this.parseXmlFeed(text));
        }
      } catch (error) {
        this.logger.error(`Failed to fetch feed ${feedUrl}`, { error: error.message });
      }
    }

    return deals;
  }

  parseJsonFeed(data) {
    // Handle common affiliate feed formats
    if (Array.isArray(data)) return data;
    if (data.products) return data.products;
    if (data.items) return data.items;
    if (data.deals) return data.deals;
    return [];
  }

  parseXmlFeed(xmlText) {
    // Basic XML parsing for RSS/Atom feeds
    const deals = [];
    const itemRegex = /<item>[\s\S]*?<\/item>/g;
    const items = xmlText.match(itemRegex) || [];

    for (const item of items) {
      const title = item.match(/<title>(.*?)<\/title>/)?.[1] || '';
      const link = item.match(/<link>(.*?)<\/link>/)?.[1] || '';
      const description = item.match(/<description>(.*?)<\/description>/)?.[1] || '';

      // Try to extract price from description
      const priceMatch = description.match(/₹([\d,]+)/);
      const price = priceMatch ? priceMatch[1].replace(/,/g, '') : null;

      if (title && link) {
        deals.push({
          title,
          url: link,
          price,
          description,
        });
      }
    }

    return deals;
  }
}

export class DealAggregatorHandler {
  constructor() {
    this.logger = createLogger('deal-aggregator');
  }

  async fetch(config) {
    // This would scrape deal aggregator websites
    this.logger.info('Fetching from deal aggregators', { sites: config.sites });
    return [];
  }
}

// Export singleton instance
export const multiSourceIngestion = new MultiSourceIngestion();
