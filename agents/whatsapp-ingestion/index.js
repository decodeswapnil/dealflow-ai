import 'dotenv/config';
import { createLogger } from '../../shared/utils/logger.js';
import { query } from '../../shared/utils/db.js';
import { createQueue } from '../../shared/utils/redis.js';
import { chromium } from 'playwright';
import cron from 'node-cron';

const logger = createLogger('whatsapp-ingestion');
const dealQueue = createQueue('deals');

class WhatsAppIngestionAgent {
  constructor() {
    this.browser = null;
    this.isRunning = false;
    this.groupNames = (process.env.WHATSAPP_GROUP_NAMES || '').split(',').filter(Boolean);
  }

  async init() {
    logger.info('Initializing WhatsApp Ingestion Agent');
    if (this.groupNames.length === 0) {
      logger.warn('No WhatsApp groups configured');
      return;
    }

    this.browser = await chromium.launch({ 
      headless: false, // Need UI for QR scan
      args: ['--no-sandbox']
    });

    // Run every 10 minutes
    cron.schedule('*/10 * * * *', () => this.ingestMessages());
  }

  async ingestMessages() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const context = await this.browser.newContext({
        storageState: 'whatsapp-auth.json' // Persist session
      });
      const page = await context.newPage();

      await page.goto('https://web.whatsapp.com', { waitUntil: 'networkidle' });
      
      // Wait for chat list (means logged in)
      await page.waitForSelector('[data-testid="chat-list"]', { timeout: 30000 });
      
      for (const groupName of this.groupNames) {
        try {
          await this.processGroup(page, groupName);
        } catch (err) {
          logger.error(`Failed to process group: ${groupName}`, { error: err.message });
        }
      }

      await context.storageState({ path: 'whatsapp-auth.json' });
      await context.close();
    } catch (err) {
      logger.error('Ingestion cycle failed', { error: err.message });
    } finally {
      this.isRunning = false;
    }
  }

  async processGroup(page, groupName) {
    // Search for the group by name (since we have names, not URLs)
    const searchSelector = '[data-testid="chat-list-search"], [title="Search input textbox"]';
    await page.waitForSelector(searchSelector, { timeout: 10000 });
    await page.click(searchSelector);
    await page.fill(searchSelector, groupName);
    await page.waitForTimeout(2000);
    
    // Click the first matching group result
    const groupResult = await page.$(`span[title="${groupName}"]`);
    if (!groupResult) {
      logger.warn(`Group "${groupName}" not found in WhatsApp`);
      return;
    }
    await groupResult.click();
    await page.waitForSelector('[data-testid="conversation-panel-messages"]', { timeout: 10000 });

    // Get messages
    const messages = await page.$$eval('[data-testid="msg-container"]', msgs => 
      msgs.slice(-50).map(m => ({
        text: m.innerText,
        html: m.innerHTML,
      }))
    );

    for (const msg of messages) {
      const asin = this.extractAsin(msg.text);
      if (!asin) continue;

      // Check if already processed
      const existing = await query(
        'SELECT 1 FROM whatsapp_ingestion WHERE extracted_asin = $1 AND time > NOW() - INTERVAL \'24 hours\'',
        [asin]
      );
      if (existing.rowCount > 0) continue;

      // Extract deal info
      const deal = {
        asin,
        title: this.extractTitle(msg.text) || 'WhatsApp Deal',
        price: this.extractPrice(msg.text),
        source: 'whatsapp',
        discoveredAt: new Date(),
      };

      // Log ingestion
      await query(
        'INSERT INTO whatsapp_ingestion (time, source_group, raw_text, extracted_asin, extracted_url, processed) VALUES (NOW(), $1, $2, $3, $4, TRUE)',
        [groupName, msg.text, asin, `https://www.amazon.in/dp/${asin}`]
      );

      // Queue for analysis
      await dealQueue.add('analyze-deal', deal);
    }
  }

  extractAsin(text) {
    const match = text.match(/(?:dp\/|asin\/)([A-Z0-9]{10})/);
    return match ? match[1] : null;
  }

  extractPrice(text) {
    const match = text.match(/₹\s*([\d,]+(?:\.\d{2})?)/);
    return match ? parseFloat(match[1].replace(/,/g, '')) : null;
  }

  extractTitle(text) {
    const lines = text.split('\n').filter(l => l.length > 5 && !l.includes('₹') && !l.includes('http'));
    return lines[0]?.slice(0, 200);
  }

  async shutdown() {
    if (this.browser) await this.browser.close();
    logger.info('WhatsApp Ingestion Agent shutdown');
  }
}

const agent = new WhatsAppIngestionAgent();
process.on('SIGINT', () => agent.shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => agent.shutdown().then(() => process.exit(0)));
agent.init().catch(err => {
  logger.error('Failed to start', err);
  process.exit(1);
});