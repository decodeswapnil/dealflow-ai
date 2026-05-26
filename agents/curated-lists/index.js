import 'dotenv/config';
import { createLogger } from '../../shared/utils/logger.js';
import { query } from '../../shared/utils/db.js';
import {
  createStealthBrowser,
  createStealthContext,
  randomDelay,
  safeGoto,
  humanLikeScroll,
  closeBrowser,
} from '../../shared/utils/stealth-browser.js';
import { Registry, Counter, Gauge } from 'prom-client';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { callAI as sharedCallAI } from '../../shared/utils/ai-client.js';
import {
  pickWeightedCategory,
  isTopicInDemand,
  getSeasonalContext,
} from '../../shared/utils/demand-intelligence.js';

const logger = createLogger('curated-lists');

// ── Prometheus ─────────────────────────────────────────
const register = new Registry();
register.setDefaultLabels({ app: 'curated-lists' });

const listsPostedTotal = new Counter({
  name: 'curated_lists_posted_total',
  help: 'Total curated list posts published',
  labelNames: ['category'],
  registers: [register],
});
const listsErrorsTotal = new Counter({
  name: 'curated_lists_errors_total',
  help: 'Total errors',
  labelNames: ['stage'],
  registers: [register],
});
const activeGauge = new Gauge({
  name: 'curated_lists_active',
  help: 'Whether agent is running',
  registers: [register],
});

// ── Metrics server ─────────────────────────────────────
const metricsApp = express();
metricsApp.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
metricsApp.get('/status', (_req, res) => res.json({ busy: isRunning, lastRun, stats }));
metricsApp.listen(3006, () => logger.info('Metrics on port 3006'));

// ── Telegram + Affiliate ──────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const AFFILIATE_TAG = process.env.AMAZON_ASSOCIATE_TAG;

function buildAffiliateUrl(asin) {
  return `https://www.amazon.in/dp/${asin}?tag=${AFFILIATE_TAG}&linkCode=ll1&ref=as_li_ss_tl`;
}

// ── State ──────────────────────────────────────────────
let isRunning = false;
let lastRun = null;
const stats = { posted: 0, errors: 0 };

// ── Topic Matrix (demand-weighted for maximum engagement) ─────────────────────
// S-tier categories (high impulse, high CTR) appear most often via weighted picker.
// B-tier (books, stationery, grocery) removed from regular rotation —
// they only appear when seasonally in demand (caught by demand gate).
const CATEGORIES = [
  // S-Tier: Mobiles & Electronics (appear 6x more often)
  'phones', 'smartphones', 'budget phones', '5G phones', 'gaming phones',
  'laptops', 'gaming laptops', 'ultrabooks',
  'earbuds', 'headphones', 'neckband earphones', 'gaming headsets',
  'smartwatches', 'fitness bands',
  'tablets', 'cameras', 'action cameras',
  'speakers', 'bluetooth speakers', 'soundbars',
  'power banks', 'fast chargers', 'wireless chargers',
  'smart TVs', 'streaming devices',
  // S-Tier: Fashion
  'shoes', 'sneakers', 'backpacks', 'handbags', 'sunglasses', 'watches',
  // A-Tier: Kitchen & Home (appear 3x)
  'kitchen appliances', 'cookware', 'air fryers', 'mixer grinders',
  'home decor', 'lighting', 'LED bulbs', 'storage & organization', 'bedding',
  'security cameras', 'smart home devices', 'routers',
  // Seasonal/Weather Appliances
  'air conditioners', 'room coolers', 'refrigerators', 'room heaters', 'water geysers',
  // A-Tier: Health & Beauty
  'skincare', 'sunscreen', 'moisturizers',
  'haircare', 'hair dryers', 'grooming kits', 'perfumes',
  'fitness equipment', 'yoga accessories', 'protein supplements',
  // A-Tier: Kids & Lifestyle
  'toys', 'board games', 'remote control toys',
  'baby products', 'travel accessories', 'water bottles',
  // Gaming
  'gaming accessories', 'gaming mice', 'gaming keyboards', 'gaming monitors',
];

const PRICE_RANGES = [
  { label: 'Under ₹99', min: 0, max: 99, searchMax: 99 },
  { label: 'Under ₹199', min: 0, max: 199, searchMax: 199 },
  { label: 'Under ₹499', min: 0, max: 499, searchMax: 499 },
  { label: 'Under ₹999', min: 0, max: 999, searchMax: 999 },
  { label: 'Under ₹1,999', min: 0, max: 1999, searchMax: 1999 },
  { label: 'Under ₹2,999', min: 0, max: 2999, searchMax: 2999 },
  { label: 'Under ₹4,999', min: 0, max: 4999, searchMax: 4999 },
  { label: 'Under ₹9,999', min: 500, max: 9999, searchMax: 9999 },
  { label: 'Under ₹14,999', min: 1000, max: 14999, searchMax: 14999 },
  { label: 'Under ₹24,999', min: 5000, max: 24999, searchMax: 24999 },
  { label: 'Under ₹34,999', min: 10000, max: 34999, searchMax: 34999 },
  { label: 'Under ₹49,999', min: 15000, max: 49999, searchMax: 49999 },
];

const AUDIENCES = [
  'everyone', 'students', 'business owners', 'gamers', 'WFH professionals',
  'new parents', 'fitness enthusiasts', 'home cooks', 'travellers',
  'college students', 'senior citizens', 'content creators', 'artists',
  'music lovers', 'bookworms', 'pet owners', 'brides-to-be',
];

const ANGLES = [
  'Best Value', 'Most Popular', 'Hidden Gems', 'Editor\'s Pick',
  'Budget Champions', 'Premium Feel', 'Most Reviewed', 'Trending Now',
  'Brand Battle', 'Essentials', 'Must-Haves', 'Upgrade Picks',
];

const LIST_SIZES = [3, 4, 5]; // Telegram captions limit to 1024 chars, 10 items will always truncate

// ── Stage 1: AI Topic Ideation ────────────────────────

async function generateTopicIdea() {
  // Get recently posted topics and categories to avoid repetition
  let recentTopics = [];
  let recentCategories = [];
  try {
    const result = await query(
      `SELECT topic, category FROM curated_lists WHERE time > NOW() - INTERVAL '30 days' ORDER BY time DESC LIMIT 50`
    );
    recentTopics = result.rows.map(r => r.topic);
    recentCategories = result.rows.map(r => r.category).filter(Boolean);
  } catch (e) {
    logger.warn('Could not fetch recent topics', { error: e.message });
  }

  // Get seasonal context to inform topic selection
  const seasonal = getSeasonalContext();

  // ── Demand-weighted category selection ────────────────────────────────────
  // S-tier: 6x weight, A-tier: 3x, B-tier: 1x (never picked here since removed)
  // Recently used categories get 80% weight reduction to ensure variety
  const category = pickWeightedCategory(CATEGORIES, recentCategories.slice(0, 10));

  const priceRange = PRICE_RANGES[Math.floor(Math.random() * PRICE_RANGES.length)];
  const audience = AUDIENCES[Math.floor(Math.random() * AUDIENCES.length)];
  const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)];
  const listSize = LIST_SIZES[Math.floor(Math.random() * LIST_SIZES.length)];

  // Seasonal note for AI context
  let seasonalNote = '';
  if (seasonal.season !== 'regular') {
    seasonalNote = `Current season: ${seasonal.season}. High-demand right now: ${seasonal.boostedCategories.join(', ')}.`;
    if (seasonal.weatherBoosted && seasonal.weatherBoosted.length > 0) {
      seasonalNote += ` MUST ALSO CONSIDER WEATHER-RELATED ITEMS if relevant to category: ${seasonal.weatherBoosted.join(', ')}.`;
    }
  }

  // Use AI to refine into a catchy topic
  const prompt = `You are a content strategist for DealDecode India, a popular Telegram deal channel for Indian shoppers.

Generate ONE catchy, specific listicle topic for a Telegram post. The topic should be in Hinglish (mix of Hindi + English) and feel like a friend recommending products.

Parameters:
- Category: ${category}
- Price range: ${priceRange.label}
- Target audience: ${audience}
- Angle: ${angle}
- List size: Top ${listSize}
${seasonalNote ? `- Seasonal context: ${seasonalNote}` : ''}

Recently posted topics (AVOID similar ones):
${recentTopics.slice(0, 15).map(t => `- ${t}`).join('\n') || '- None yet'}

Requirements:
1. Title must be catchy with emoji, max 60 chars
2. Include a one-line subtitle hook (max 80 chars)
3. The Amazon search query to find these products (English, specific keywords)
4. Prefer high-demand categories: phones, laptops, earbuds, fashion, beauty, kitchen
5. Avoid hyper-niche lists that only interest a tiny audience

Respond ONLY in this exact JSON format:
{
  "title": "🎮 Top 7 Gaming Phones Under ₹25K",
  "subtitle": "BGMI smooth chalega, battery bhi full day chalegi",
  "searchQuery": "gaming phone 5G under 25000",
  "category": "${category}",
  "priceRange": "${priceRange.label}",
  "priceMax": ${priceRange.searchMax},
  "audience": "${audience}",
  "listSize": ${listSize}
}`;

  const aiResult = await callAI(prompt);
  if (!aiResult) return null;

  try {
    // Extract JSON from AI response
    const jsonMatch = aiResult.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const topic = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (!topic.title || !topic.searchQuery || !topic.listSize) return null;

    // Check if this topic is too similar to recent ones
    const isDuplicate = recentTopics.some(rt =>
      rt.toLowerCase().includes(topic.title.toLowerCase().slice(0, 20))
    );
    if (isDuplicate) {
      logger.info('Topic too similar to recent, regenerating...', { topic: topic.title });
      return null;
    }

    // ── Demand validation gate ────────────────────────────────────────────────
    // B-tier categories only pass if they are seasonally boosted right now.
    // This prevents off-season niche content (e.g., books in prime deal season).
    if (!isTopicInDemand(topic)) {
      logger.info('Topic demand gate blocked — low-demand category outside season', {
        topic: topic.title,
        category: topic.category,
        season: seasonal.season,
      });
      return null; // Pipeline will retry with a different category
    }

    logger.info('Topic generated', { title: topic.title, search: topic.searchQuery, category: topic.category });
    return topic;
  } catch (e) {
    logger.error('Failed to parse topic JSON', { error: e.message, raw: aiResult.slice(0, 200) });
    return null;
  }
}

// ── Stage 2: Amazon Search Scraping ───────────────────


async function scrapeAmazonSearch(searchQuery, priceMax, listSize) {
  const browser = await createStealthBrowser();

  try {
    const context = await createStealthContext(browser);
    const page = await context.newPage();

    // Build Amazon search URL with price filter
    const searchUrl = `https://www.amazon.in/s?k=${encodeURIComponent(searchQuery)}&rh=p_36%3A-${priceMax}00&s=review-rank`;
    logger.info('Scraping Amazon search', { url: searchUrl });

    await safeGoto(page, searchUrl);
    await randomDelay(2000, 4000);
    await humanLikeScroll(page);

    // Extract products from search results
    const products = await page.evaluate(() => {
      const items = [];
      const cards = document.querySelectorAll('[data-component-type="s-search-result"]');

      const parsePrice = (text) => {
        if (!text) return null;
        const cleaned = text.replace(/[₹$,\s]/g, '');
        const match = cleaned.match(/[\d,]+\.?\d{0,2}/);
        if (!match) return null;
        return parseInt(match[0].replace(/,/g, ''), 10);
      };

      cards.forEach(card => {
        try {
          const asin = card.getAttribute('data-asin');
          if (!asin || asin.length !== 10) return;

          // Title
          const titleEl = card.querySelector('h2 a span, h2 span');
          const title = titleEl?.innerText?.trim();
          if (!title) return;

          // Price
          const priceWhole = card.querySelector('.a-price .a-price-whole');
          const price = parsePrice(priceWhole?.innerText);
          if (!price) return;

          // MRP (strikethrough price)
          const mrpEl = card.querySelector('.a-price.a-text-price .a-offscreen');
          const mrp = parsePrice(mrpEl?.innerText);

          // Rating
          const ratingEl = card.querySelector('.a-icon-star-small .a-icon-alt, .a-icon-star .a-icon-alt');
          const rating = ratingEl ? parseFloat(ratingEl.innerText) : null;

          // Review count
          const reviewEl = card.querySelector('.a-size-base.s-underline-text, [aria-label*="stars"] + span');
          let reviewCount = null;
          if (reviewEl) {
            const txt = reviewEl.innerText.replace(/[^0-9]/g, '');
            reviewCount = parseInt(txt) || null;
          }

          // Image
          const imgEl = card.querySelector('.s-image');
          const imageUrl = imgEl?.src || null;

          // Product URL
          const linkEl = card.querySelector('h2 a');
          const productUrl = linkEl?.href?.split('?')[0] || null;

          items.push({ asin, title, price, mrp, rating, reviewCount, imageUrl, productUrl });
        } catch { /* skip bad cards */ }
      });

      return items;
    });

    await context.close();

    // Filter valid products and sort by value score
    const filtered = products
      .filter(p => p.price && p.title && p.price <= (priceMax * 1.05)) // 5% tolerance
      .filter(p => p.rating && p.rating >= 3.5) // No garbage ratings
      .filter(p => p.reviewCount && p.reviewCount >= 50) // MUST have trusted reviews
      .sort((a, b) => {
        // Score: rating weight + review popularity + discount
        const scoreA = (a.rating || 3.5) * 3 + Math.log10(a.reviewCount) * 2 + ((a.mrp && a.mrp > a.price) ? ((a.mrp - a.price) / a.mrp) * 10 : 0);
        const scoreB = (b.rating || 3.5) * 3 + Math.log10(b.reviewCount) * 2 + ((b.mrp && b.mrp > b.price) ? ((b.mrp - b.price) / b.mrp) * 10 : 0);
        return scoreB - scoreA;
      })
      .slice(0, Math.min(listSize + 3, 15)); // Get a few extra for AI to pick from

    logger.info(`Scraped ${products.length} products, filtered to ${filtered.length}`);
    return filtered;
  } catch (e) {
    logger.error('Amazon scrape failed', { error: e.message });
    listsErrorsTotal.inc({ stage: 'scrape' });
    return [];
  } finally {
    await closeBrowser(browser);
  }
}

// ── Stage 3: AI Listicle Composition ──────────────────

async function composeListicle(topic, products) {
  if (products.length < 3) {
    logger.warn('Not enough products for listicle', { count: products.length });
    return null;
  }

  // Build product data for AI
  const productData = products.map((p, i) => {
    const discount = p.mrp && p.mrp > p.price ? Math.round((1 - p.price / p.mrp) * 100) : 0;
    return `${i + 1}. ${p.title.substring(0, 80)}
   Price: ₹${p.price.toLocaleString('en-IN')}${p.mrp ? ` (MRP: ₹${p.mrp.toLocaleString('en-IN')}, ${discount}% off)` : ''}
   Rating: ${p.rating || 'N/A'}/5 | Reviews: ${p.reviewCount?.toLocaleString('en-IN') || 'N/A'}
   ASIN: ${p.asin}`;
  }).join('\n\n');

  const listSize = Math.min(topic.listSize || 7, products.length);

  const prompt = `You are a content creator for DealDecode India Telegram channel. Write a curated listicle post.

TOPIC: ${topic.title}
SUBTITLE: ${topic.subtitle || ''}
LIST SIZE: Pick the best ${listSize} products from below

AVAILABLE PRODUCTS:
${productData}

RULES:
1. Write in Hinglish (Hindi + English mix) — casual, like a friend recommending
2. Start with the topic title as <b>bold</b> header with emoji
3. Write a 1-2 line intro explaining why this list matters
4. For each product, write:
   - Number emoji (1️⃣ 2️⃣ etc) + Product name (shortened, readable)
   - One line: key highlight (battery, display, performance etc)
   - Price line with strikethrough MRP: 💰 <b>₹X</b>  <s>₹Y</s> (Z% off)
   - Affiliate link line: 👉 <a href="AFFILIATE_LINK">Buy on Amazon</a>
5. End with a 💡 Pro tip — genuine advice related to the category
6. Add hashtags: #DealDecode #Top${listSize} + 2-3 relevant ones
7. Keep TOTAL post under 900 characters (Telegram photo caption limit)
8. Use HTML formatting: <b>bold</b>, <s>strike</s>, <a href="">links</a>, <i>italic</i>
9. DO NOT use markdown. Only HTML tags.
10. For affiliate links, use this exact format per product:
${products.slice(0, 3).map(p => `    ASIN ${p.asin} → https://www.amazon.in/dp/${p.asin}?tag=${AFFILIATE_TAG}&linkCode=ll1&ref=as_li_ss_tl`).join('\n')}

Write the complete post now. Output ONLY the post text, nothing else.`;

  const caption = await callAI(prompt);
  if (!caption) return null;

  // Inject real affiliate links for any ASINs the AI mentioned
  let finalCaption = caption;
  for (const p of products) {
    const affiliateUrl = buildAffiliateUrl(p.asin);
    // Replace any placeholder or wrong URLs for this ASIN
    const asinPattern = new RegExp(`https?://[^"\\s]*${p.asin}[^"\\s]*`, 'g');
    finalCaption = finalCaption.replace(asinPattern, affiliateUrl);
  }

  // Safety: Telegram photo caption limit is 1024 chars.
  // Must NOT cut inside an HTML tag — close all open tags cleanly.
  const TELEGRAM_LIMIT = 1020;
  if (finalCaption.length > TELEGRAM_LIMIT) {
    // Find last safe cut point before the limit (outside any tag)
    let cutAt = TELEGRAM_LIMIT;
    // Walk back until we're not inside a tag
    while (cutAt > 0 && finalCaption[cutAt] !== '\n' && finalCaption.slice(cutAt - 10, cutAt + 1).match(/<[^>]*$/)) {
      cutAt--;
    }
    // Cut at last double newline before limit to drop the entire incomplete product
    let lastSafeCut = finalCaption.lastIndexOf('\n\n', cutAt);
    if (lastSafeCut < 400) {
      // Fallback to single newline if double isn't found
      lastSafeCut = finalCaption.lastIndexOf('\n', cutAt);
    }
    if (lastSafeCut > 0) cutAt = lastSafeCut;
    finalCaption = finalCaption.substring(0, cutAt).trim();
    // Close any unclosed HTML tags
    const openTags = [];
    const tagPattern = /<(\/?)(b|i|s|a)[^>]*>/g;
    let m;
    while ((m = tagPattern.exec(finalCaption)) !== null) {
      if (m[1] === '/') {
        const last = openTags.pop();
        if (last !== m[2]) openTags.push(last); // mismatch safety
      } else {
        openTags.push(m[2]);
      }
    }
    // Close unclosed tags in reverse order
    for (const tag of openTags.reverse()) {
      finalCaption += `</${tag}>`;
    }
    finalCaption += '\n\n#DealDecode';
  }

  return {
    caption: finalCaption,
    products: products.slice(0, listSize).map(p => ({
      asin: p.asin,
      title: p.title.substring(0, 80),
      price: p.price,
      affiliateUrl: buildAffiliateUrl(p.asin),
    })),
  };
}

// ── AI API Call — shared provider chain (Gemini → Replicate → OpenRouter → Ollama) ──
async function callAI(prompt) {
  const result = await sharedCallAI(prompt, { maxTokens: 1024, temperature: 0.8 });
  if (!result.text) listsErrorsTotal.inc({ stage: 'ai' });
  return result.text || null;
}

// ── Post to Telegram ──────────────────────────────────

async function postToTelegram(listicle, topic) {
  try {
    // Send as text message (listicles are text-heavy, no image needed)
    const message = await bot.sendMessage(CHANNEL_ID, listicle.caption, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    // Record in database
    await query(
      `INSERT INTO curated_lists (time, topic, category, price_range, audience, angle, product_count, products, message_id, ai_source)
       VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        topic.title,
        topic.category || null,
        topic.priceRange || null,
        topic.audience || null,
        null, // angle
        listicle.products.length,
        JSON.stringify(listicle.products),
        message.message_id,
        'gemini',
      ]
    );

    listsPostedTotal.inc({ category: topic.category || 'general' });
    stats.posted++;
    logger.info('Listicle posted!', { topic: topic.title, messageId: message.message_id, products: listicle.products.length });
    return message;
  } catch (e) {
    listsErrorsTotal.inc({ stage: 'post' });
    logger.error('Telegram post failed', { error: e.message });
    return null;
  }
}

// ── Full Pipeline ─────────────────────────────────────

async function runOneCycle() {
  if (isRunning) {
    logger.info('Already running, skipping');
    return;
  }

  // ⚠️ TESTING MODE: 24hr active — revert to normal hours after testing
  // const now = new Date();
  // const istHour = new Date(now.getTime() + 5.5 * 60 * 60 * 1000).getUTCHours();
  // if (istHour >= 1 && istHour < 7) { logger.info('Outside active hours', { istHour }); return; }

  isRunning = true;
  activeGauge.set(1);
  logger.info('Starting curated list cycle');

  try {
    // Stage 1: Generate topic (retry up to 3 times for a good one)
    let topic = null;
    for (let attempt = 0; attempt < 3 && !topic; attempt++) {
      topic = await generateTopicIdea();
      if (!topic) await randomDelay(2000, 4000);
    }

    if (!topic) {
      logger.error('Failed to generate topic after 3 attempts');
      listsErrorsTotal.inc({ stage: 'ideation' });
      return;
    }

    // Stage 2: Scrape Amazon search results
    const products = await scrapeAmazonSearch(topic.searchQuery, topic.priceMax || 9999, topic.listSize || 7);
    if (products.length < 3) {
      logger.warn('Not enough products found, skipping', { count: products.length, query: topic.searchQuery });
      listsErrorsTotal.inc({ stage: 'scrape_empty' });
      return;
    }

    // Stage 3: Compose listicle with AI
    const listicle = await composeListicle(topic, products);
    if (!listicle) {
      logger.error('Failed to compose listicle');
      listsErrorsTotal.inc({ stage: 'compose' });
      return;
    }

    // Stage 4: Post to Telegram
    await postToTelegram(listicle, topic);

    logger.info('Cycle complete', { topic: topic.title });
  } catch (e) {
    stats.errors++;
    listsErrorsTotal.inc({ stage: 'pipeline' });
    logger.error('Pipeline error', { error: e.message, stack: e.stack });
  } finally {
    isRunning = false;
    activeGauge.set(0);
    lastRun = new Date().toISOString();
  }
}

// ── Scheduling ────────────────────────────────────────
// Post 2-4 listicles/day at optimal times: 9AM, 1PM, 7PM, 9:30PM IST
// Using setTimeout-based scheduling (IST-aware)

function scheduleNextPost() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const istHour = istNow.getUTCHours();
  const istMin = istNow.getUTCMinutes();
  const currentMins = istHour * 60 + istMin;

  // Posting slots in IST (minutes from midnight)
  const slots = [
    9 * 60,       // 9:00 AM
    13 * 60,      // 1:00 PM
    19 * 60,      // 7:00 PM
    21 * 60 + 30, // 9:30 PM
  ];

  // Find next slot
  let nextSlotMins = null;
  for (const slot of slots) {
    if (slot > currentMins + 5) { // 5 min buffer
      nextSlotMins = slot;
      break;
    }
  }

  // If no slot today, schedule first slot tomorrow
  if (nextSlotMins === null) {
    nextSlotMins = slots[0] + 24 * 60; // Tomorrow's first slot
  }

  const delayMins = nextSlotMins - currentMins;
  const delayMs = delayMins * 60 * 1000 + Math.floor(Math.random() * 10 * 60 * 1000); // +0-10 min jitter

  const nextTime = new Date(now.getTime() + delayMs);
  logger.info(`Next listicle scheduled`, {
    inMinutes: Math.round(delayMs / 60000),
    at: nextTime.toISOString(),
  });

  setTimeout(async () => {
    await runOneCycle();
    scheduleNextPost(); // Schedule the next one
  }, delayMs);
}

// ── Init ──────────────────────────────────────────────

async function init() {
  logger.info('Curated Lists Agent starting');

  // Verify Telegram bot
  try {
    const me = await bot.getMe();
    logger.info('Bot connected', { username: me.username });
  } catch (e) {
    logger.error('Telegram bot connection failed', { error: e.message });
    throw e;
  }

  // Ensure DB table exists
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS curated_lists (
        id SERIAL PRIMARY KEY,
        time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        topic TEXT NOT NULL,
        category TEXT,
        price_range TEXT,
        audience TEXT,
        angle TEXT,
        product_count INTEGER,
        products JSONB,
        message_id BIGINT,
        ai_source TEXT,
        clicks INTEGER DEFAULT 0,
        estimated_revenue REAL DEFAULT 0
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_curated_lists_topic ON curated_lists(topic)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_curated_lists_time ON curated_lists(time DESC)`);
    logger.info('DB table verified');
  } catch (e) {
    logger.warn('DB table creation warning (may already exist)', { error: e.message });
  }

  // Run first cycle after a short delay, then schedule recurring
  const initialDelay = 30000 + Math.floor(Math.random() * 60000); // 30-90s
  logger.info(`First cycle in ${Math.round(initialDelay / 1000)}s`);
  setTimeout(async () => {
    await runOneCycle();
    scheduleNextPost();
  }, initialDelay);
}

// ── Start ─────────────────────────────────────────────
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
init().catch(e => {
  logger.error('Failed to start', { error: e.message });
  process.exit(1);
});
