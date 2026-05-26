import 'dotenv/config';
import { createLogger } from '../../shared/utils/logger.js';
import { query } from '../../shared/utils/db.js';
import { createWorker } from '../../shared/utils/redis.js';
import { Registry, Counter, Gauge } from 'prom-client';
import { getHighQualityImage, cleanupOldImages } from '../../shared/utils/image-extractor.js';
import { shouldSendVoiceNote, buildVoiceScript, textToSpeech, getKeyHealthStatus, resetAllKeyStatuses } from '../../shared/utils/sarvam-tts.js';

import express from 'express';
import TelegramBot from 'node-telegram-bot-api';

// ── Content Strategy Modules ──
import {
  generateAICaption,
  selectArchetype,
  getTemporalContext,
} from './ai-caption-engine.js';
import {
  getRevenuePacing,
  getTodayContentQuota,
  getCurrentSlotConfig,
  shouldPostNow,
  rankDealsForPosting,
  getTodayPostCounts,
  incrementPostCount,
  recordPostMetadata,
  getActiveSale,
  getSaleMultiplier,
} from './content-calendar.js';

import {
  assignVariant,
  recordAssignment,
  generateCaptionVariant,
  ACTIVE_EXPERIMENTS,
} from './ab-testing.js';

const logger = createLogger('telegram-posting');

// Prometheus metrics
const register = new Registry();
register.setDefaultLabels({ app: 'telegram-posting' });

const postsPublishedTotal = new Counter({
  name: 'posts_published_total',
  help: 'Total Telegram posts published',
  labelNames: ['category', 'status'],
  registers: [register],
});

const postingErrorsTotal = new Counter({
  name: 'posting_errors_total',
  help: 'Total posting errors',
  labelNames: ['type'],
  registers: [register],
});

const activePostingGauge = new Gauge({
  name: 'posting_active',
  help: 'Whether posting is currently running',
  registers: [register],
});

// Worker status tracking
let isPostingBusy = false;

// Start metrics server
const metricsApp = express();
metricsApp.use(express.json());

metricsApp.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Status endpoint - returns whether worker is idle + daily caps info
metricsApp.get('/status', (req, res) => {
  res.json({
    busy: isPostingBusy,
    lastPostTime: agent.lastPostTime,
    postedCount: agent.postedCount,
    dailyCaps: agent.dailyCaps,
    todayPosted: agent.todayPosted,
  });
});

// Sarvam key health endpoint - returns status of all API keys
metricsApp.get('/sarvam-health', (req, res) => {
  try {
    const healthStatus = getKeyHealthStatus();
    const allHealthy = healthStatus.every(k => k.isAvailable);

    res.json({
      healthy: allHealthy,
      keys: healthStatus,
      totalKeys: healthStatus.length,
      availableKeys: healthStatus.filter(k => k.isAvailable).length,
      rateLimitedKeys: healthStatus.filter(k => k.status === 'rate_limited').length,
      failedKeys: healthStatus.filter(k => k.status === 'failed').length,
    });
  } catch (err) {
    logger.error('Failed to get Sarvam key health', { error: err.message });
    res.status(500).json({ error: 'Failed to get key health status' });
  }
});

// Reset Sarvam key statuses - manual recovery endpoint
metricsApp.post('/sarvam-reset', (req, res) => {
  try {
    resetAllKeyStatuses();
    res.json({ success: true, message: 'All Sarvam key statuses reset' });
  } catch (err) {
    logger.error('Failed to reset Sarvam key statuses', { error: err.message });
    res.status(500).json({ error: 'Failed to reset key statuses' });
  }
});


// Direct post endpoint - bypass queue when called directly
metricsApp.post('/direct-post', async (req, res) => {
  try {
    // Handle both nested { deal, score } and flat deal objects
    const deal = req.body.deal || req.body;
    const score = req.body.score || { score: deal.score || 0, verdict: deal.verdict || 'good' };
    logger.info('Direct post request received', { asin: deal.asin });
    await agent.publishDeal(deal, deal.category || 'general', score);
    res.json({ success: true });
  } catch (err) {
    logger.error('Direct post failed', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

metricsApp.listen(3004, () => {
  logger.info('Metrics server running on port 3004');
});

// Telegram Bot setup — polling ON so we can receive private messages
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
let BOT_USERNAME = ''; // populated at init via getMe()

// ── Natural Language Engine for Indian Audience ──
// Designed to feel like a real person sharing deals with friends

const NATURAL_PATTERNS = {
  // Casual openers that feel like a friend DM'd you
  casualOpeners: [
    "Bhai ye dekh! 🔥",
    "Yaar kya deal mila hai! 😍",
    "Aaj ka best find! 💪",
    "Sach bol raha hoon, mast price hai! 💯",
    "Doston ke saath share kar raha hoon! 🤝",
    "Budget mein perfect! ✅",
    "Amazon pe aaj surprise hai! 🎁",
    "Kal se wait kar raha tha is price ka! ⏰",
    "Kisi ne pucha tha iske baare mein! 💡",
    "Stock dekh ke jaldi post kar raha hoon! ⚡",
  ],

  // More personal/humble tones
  humbleOpeners: [
    "Mujhe ye acha laga, soch aapko bhi pasand aaye! 😊",
    "Personal recommendation hai! 👍",
    "Khud use kar raha hoon, bahut accha hai! 💪",
    "Family mein sab ko pasand aaya! ❤️",
    "Amazon pe browse karte hue mila! 🔍",
  ],

  // Excited/urgent but natural
  excitedOpeners: [
    "Jaldi dekh lo! 👀",
    "Abhi abhi drop hua price! 💸",
    "Fatafat check karo! 🏃‍♂️",
    "Miss mat karna! 🎯",
    "Aisa price fir nahi milega! 💰",
  ],

  // Natural closers that feel like advice, not commands
  friendlyClosers: [
    "Agar pasand aaye toh le lo! 👍",
    "Link de raha hoon, khud check kar lo! 🔗",
    "Price compare kar ke dekho, sach mein kam hai! 💯",
    "Meri taraf se recommended hai! ✅",
    "Budget fit ho toh mat socho! 💪",
    "Amazon trusted hai, tension nahi! 🛡️",
    "Aapke kaam aa jaye toh accha lagega! 😊",
  ],

  // Subtle urgency (not aggressive)
  softUrgency: [
    "Price badal bhi sakta hai! 💡",
    "Stock kab khatam ho jaye pata nahi! 📦",
    "Jaldi decide karna pad sakta hai! ⏰",
    "Deal of the day lag raha hai! 🎯",
  ],

  // Personal touches that build trust
  trustSignals: [
    "Amazon Fulfilled hai! 📦",
    "Return policy acchi hai! ✅",
    "4+ star rating mila hai! ⭐",
    "Reviews dekh lo, log khush hai! 😊",
  ],

  // Emoji palettes for variety (not overused)
  emojiSets: [
    ['🔥', '💰', '✅'],
    ['😍', '💸', '👍'],
    ['⚡', '🎯', '💯'],
    ['🎁', '🏆', '❤️'],
    ['💪', '📦', '⭐'],
  ],
};

// ── URL Validation ──────────────────────────────

function isValidUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url === 'undefined' || url === 'null') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateDealUrls(deal) {
  const errors = [];
  const tag = process.env.AMAZON_AFFILIATE_TAG || process.env.AMAZON_ASSOCIATE_TAG;

  // Validate product URL
  if (!deal.productUrl || !isValidUrl(deal.productUrl)) {
    errors.push('Invalid or missing product URL');
  }

  // Build/validate affiliate URL — ensure every post earns commission
  let safeAffiliateUrl = null;
  if (deal.affiliateUrl && isValidUrl(deal.affiliateUrl) && deal.affiliateUrl.includes('amazon.in')) {
    // Ensure the affiliate URL actually has our tag
    if (tag && !deal.affiliateUrl.includes(`tag=${tag}`)) {
      try {
        const url = new URL(deal.affiliateUrl);
        url.searchParams.set('tag', tag);
        safeAffiliateUrl = url.toString();
      } catch {
        safeAffiliateUrl = deal.affiliateUrl;
      }
    } else {
      safeAffiliateUrl = deal.affiliateUrl;
    }
  } else if (tag && deal.asin) {
    // No affiliate URL provided — generate one from ASIN
    safeAffiliateUrl = `https://www.amazon.in/dp/${deal.asin}?tag=${tag}&linkCode=ll1&ref=as_li_ss_tl`;
    logger.info('Generated affiliate URL from ASIN', { asin: deal.asin });
  }

  // Warn if we still have no affiliate URL (no tag configured)
  if (!safeAffiliateUrl) {
    if (!tag) {
      logger.warn('No AMAZON_ASSOCIATE_TAG configured — posting without affiliate link!');
    }
    errors.push('No affiliate URL could be generated');
  }

  const safeProductUrl = isValidUrl(deal.productUrl) ? deal.productUrl : null;

  return {
    valid: !!(safeAffiliateUrl || safeProductUrl),  // Need at least one valid URL
    errors,
    safeProductUrl,
    safeAffiliateUrl,
  };
}

// Per-category one-liner hooks (Hinglish, varies per product)
const CATEGORY_HOOKS = {
  mobiles: ['Smartphone upgrade time! 📱', 'Naya phone, naya vibe ✨', 'Best mobile deal aaj ka 🔥'],
  electronics: ['Best tech deal aaj ka ⚡', 'Gadget lovers ke liye 🎯', 'Seedha deal, seedha savings 💰'],
  headphones: ['Bass drop + price drop 🎧', 'Music lovers ke liye 🎵', 'Ear candy, wallet friendly 🎶'],
  laptops: ['WFH setup upgrade karo 💻', 'Best laptop value right now 🔥', 'Productivity boost guaranteed ⚡'],
  fashion: ['Style upgrade ho jao 👟', 'Trendy look, budget friendly 😍', 'Dressing up just got cheaper ✨'],
  kitchen: ['Ghar upgrade ho jaata hai 🍳', 'Kitchen mein naya addition 🥘', 'Cooking just got better ⚡'],
  beauty: ['Glow up time! 💄', 'Skincare routine upgrade 🌟', 'Self-care deal of the day ✨'],
  sports: ['Fitness goals? Ab affordable hai 💪', 'Workout gear on budget 🏋️', 'Stay fit, spend less ⚡'],
  toys: ['Kids ki khushi guaranteed 🧸', 'Playtime just got better 🎮', 'Gift idea sorted! 🎁'],
  homeimprovement: ['Ghar ko aur accha banao 🏠', 'Home upgrade deal 🔨', 'Smart home, smart savings 💡'],
  smarthome: ['Smart home vibes 🏠', 'Automate your life 🤖', 'Tech for your home ⚡'],
  grocery: ['Daily essentials, less price 🛒', 'Pantry restock deal 🥫', 'Save on everyday items 💰'],
  general: ['Aaj ka best deal 🔥', 'Seedha savings 💸', 'Limited time offer ⚡', 'Ye miss mat karna 👀', 'Bahut log dekh rahe hain 🔥'],
};

// Sale-specific hooks — override during active sales
const SALE_HOOKS = {
  'Great Republic Day Sale': [
    '🇮🇳 Republic Day Sale is LIVE! 🔥',
    '🇮🇳 Desh ke liye deal, aapke liye bhi! 🇮🇳',
    '🇮🇳 Independence Day Sale special! 🎉',
  ],
  'Prime Day Sale': [
    '👑 Prime Day deal! Amazon ka sabse bada sale! 🔥',
    '👑 Prime members ke liye special! 👑',
    '👑 Prime Day exclusive — mat miss karna! ⚡',
  ],
  'Great Indian Festival': [
    '🪔 Great Indian Festival deal! 🎉',
    '🪔 Diwali pe ghar ko upgrade karo! 🪔',
    '🪔 Festival special — bachat + khushi! 🎁',
  ],
  'Black Friday Sale': [
    '🖤 Black Friday deal! International level ka discount! 🔥',
    '🖤 Black Friday special — India mein first time! 🎉',
    '🖤 Black Friday steal! Mat socho, le lo! ⚡',
  ],
  'default': [
    '🔥 Sale deal! Extra discount chal raha hai! 🔥',
    '🎉 Sale special offer! Bachat ka best mauka! 💰',
    '⏰ Sale ke last days! Jaldi karo! ⚡',
  ],
};

// Get sale-specific or regular hook
function getSaleAwareHook(deal, category) {
  const activeSale = getActiveSale();
  if (!activeSale) {
    return getCategoryHook(deal, category);
  }

  const saleHooks = SALE_HOOKS[activeSale.name] || SALE_HOOKS['default'];
  const idx = deal.asin ? deal.asin.charCodeAt(deal.asin.length - 1) % saleHooks.length : Math.floor(Math.random() * saleHooks.length);
  return saleHooks[idx];
}

// Sale-specific motivation lines
const SALE_MOTIVATION = [
  'Sale price — regular price se bhi kam! 🔥',
  'Limited time sale offer ⏰',
  'Stock khatam hone se pehle le lo! ⚡',
  'Sale + discount = double savings! 💰',
  'Amazon verified sale deal ✅',
];

// Get sale-aware motivation (adds sale lines to regular motivation)
function getSaleAwareMotivation(deal, category) {
  const baseMotivation = getCategoryMotivation(deal, category);
  const activeSale = getActiveSale();

  if (!activeSale) {
    return baseMotivation;
  }

  // Add one sale-specific line
  const saleLine = SALE_MOTIVATION[deal.asin ? deal.asin.charCodeAt(0) % SALE_MOTIVATION.length : 0];
  return [...baseMotivation, saleLine];
}


// ── Price-Aware Smart Motivation Engine ──
// Replaces dumb category-based motivation. What matters depends on PRICE, not just category.
// A ₹189 neck pillow doesn't need "EMI" and "1 year warranty" — it needs "fast delivery ✅"

const SMART_MOTIVATION_POOLS = {
  // Under ₹300 — impulse buys. NEVER EMI, NEVER warranty. Just delivery/returns/stock.
  impulse: [
    'Fast delivery + easy returns ✅',
    'Amazon Fulfilled — quick delivery 📦',
    'Add to cart, tension free 🛒',
    'Low stock — jaldi check karo ⚡',
    'Budget mein perfect! 💯',
    'Prime delivery — kal tak ghar pe 📦',
  ],
  // ₹300-₹1,499 — budget items. No EMI. Warranty only for electronics.
  budget: [
    'Fast delivery + easy returns ✅',
    'Amazon Fulfilled — trusted delivery 📦',
    'Reviews dekh lo, log khush hai 😊',
    'Low stock — miss mat karna ⚡',
    '30-day return policy hai ✅',
    'Prime members ke liye free delivery 🚚',
  ],
  // Budget + electronics — can mention warranty
  budget_electronics: [
    '1 year warranty included ✅',
    'Fast delivery + easy returns 📦',
    'Amazon Fulfilled — trusted ✅',
    'Reviews check kar lo ⭐',
    'Low stock — jaldi ⚡',
  ],
  // ₹1,500-₹4,999 — mid-range. EMI okay but not required.
  mid: [
    'No-cost EMI on select cards 💳',
    'Fast delivery + easy returns ✅',
    'Amazon Fulfilled — trusted 📦',
    '1 year warranty included ✅',
    'Exchange offer bhi available 🔄',
    'Reviews dekh lo, 4+ star ⭐',
  ],
  // ₹5,000+ — big ticket. Full arsenal: EMI, warranty, exchange, delivery.
  premium: [
    'No-cost EMI + exchange offer 💳🔄',
    '1 year warranty + easy returns ✅',
    'Amazon Fulfilled — fast delivery 📦',
    'Compare kar lo, best value hai 💯',
    'Trusted by thousands of buyers 🌟',
    'EMI: ₹' + '{emi}' + '/month onwards 💳',
  ],
};

function isElectronicsCategory(category) {
  const cat = (category || 'general').toLowerCase();
  return /electronics|mobile|laptop|headphone|speaker|camera|appliance|tv|gadget/.test(cat);
}

function getSmartMotivation(deal, category) {
  const price = deal.finalPrice || deal.price || 0;
  const cat = (category || deal.category || 'general').toLowerCase().replace(/\s+/g, '');

  // Pick the right pool based on price tier
  let pool;
  if (price < 300) {
    pool = SMART_MOTIVATION_POOLS.impulse;
  } else if (price < 1500) {
    pool = isElectronicsCategory(cat) ? SMART_MOTIVATION_POOLS.budget_electronics : SMART_MOTIVATION_POOLS.budget;
  } else if (price < 5000) {
    pool = SMART_MOTIVATION_POOLS.mid;
  } else {
    pool = SMART_MOTIVATION_POOLS.premium;
  }

  // Deterministic but varied selection based on ASIN
  const idx1 = deal.asin ? deal.asin.charCodeAt(0) % pool.length : 0;
  const idx2 = deal.asin ? deal.asin.charCodeAt(deal.asin.length - 1) % pool.length : 1;

  const result = [pool[idx1]];
  if (idx2 !== idx1 && pool.length > 1) {
    let line2 = pool[idx2];
    // Replace {emi} placeholder for premium items
    if (line2.includes('{emi}')) {
      const emi = price > 0 ? Math.ceil(price / 12) : 0;
      line2 = line2.replace('{emi}', emi.toLocaleString('en-IN'));
    }
    result.push(line2);
  }
  return result;
}

// Legacy wrappers — now delegate to smart motivation
function getCategoryHook(deal, category) {
  const cat = (category || deal.category || 'general').toLowerCase().replace(/\s+/g, '');
  const hooks = CATEGORY_HOOKS[cat] || CATEGORY_HOOKS.general;
  const idx = deal.asin ? deal.asin.charCodeAt(deal.asin.length - 1) % hooks.length : Math.floor(Math.random() * hooks.length);
  return hooks[idx];
}

function getCategoryMotivation(deal, category) {
  return getSmartMotivation(deal, category);
}

function getCategoryEmoji(deal, category) {
  const cat = (category || deal.category || 'general').toLowerCase().replace(/\s+/g, '');
  const map = {
    mobiles: '📱', electronics: '💻', headphones: '🎧', laptops: '💻',
    fashion: '👕', kitchen: '🍳', beauty: '💄', sports: '⚽',
    toys: '🧸', homeimprovement: '🏠', smarthome: '🏠', grocery: '🛒',
    deals: '🔥', lightning: '⚡', bestsellers: '🏆', newreleases: '🆕',
    moversshakers: '📈', general: '🛍️',
  };
  return map[cat] || '🛍️';
}

// Random utility
function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Hashtag system ───────────────────────────────────────
// Maps categories and price ranges to searchable hashtags
const CATEGORY_HASHTAGS = {
  electronics: ['#TechLoot', '#Electronics', '#Gadgets'],
  mobiles: ['#TechLoot', '#MobileDeal', '#Smartphone'],
  laptops: ['#TechLoot', '#LaptopDeal', '#WFH'],
  headphones: ['#TechLoot', '#AudioDeal', '#Headphones'],
  kitchen: ['#KitchenDeal', '#HomeSmart', '#KitchenEssentials'],
  homeimprovement: ['#HomeSmart', '#HomeDecor', '#DIY'],
  sports: ['#FitnessDeal', '#GymGear', '#SportsDeal'],
  fashion: ['#FashionDeal', '#StyleSaver', '#OOTD'],
  beauty: ['#BeautySteal', '#Skincare', '#BeautyDeal'],
  toys: ['#ToyDeal', '#KidsFun', '#GiftIdea'],
  books: ['#BookDeal', '#Readers', '#BookLovers'],
  grocery: ['#GroceryDeal', '#DailyNeeds', '#Pantry'],
  deals: ['#DealOfTheDay', '#FlashDeal'],
  greatsale: ['#GreatSummerSale', '#SaleLoot'],
  lightning: ['#LightningDeal', '#FlashSale', '#LimitedTime'],
  todaysdeals: ['#DealOfTheDay', '#TodaysDeal'],
  bestsellers: ['#BestSeller', '#TopRated'],
};

// Title keyword → hashtag mapping for auto-detection
const KEYWORD_HASHTAGS = {
  'wireless': '#Wireless', 'bluetooth': '#Bluetooth', 'charger': '#TechLoot',
  'watch': '#SmartWatch', 'earbuds': '#AudioDeal', 'speaker': '#AudioDeal',
  'camera': '#CameraDeal', 'printer': '#OfficeDeal', 'monitor': '#WFH',
  'keyboard': '#WFH', 'mouse': '#WFH', 'backpack': '#TravelDeal',
  'shoe': '#FashionDeal', 'shirt': '#FashionDeal', 'kurta': '#FashionDeal',
  'saree': '#FashionDeal', 'jeans': '#FashionDeal',
  'moistur': '#Skincare', 'sunscreen': '#Skincare', 'serum': '#Skincare',
  'shampoo': '#HairCare', 'perfume': '#Fragrance',
  'protein': '#FitnessDeal', 'dumbbell': '#GymGear', 'yoga': '#FitnessDeal',
  'pan': '#KitchenDeal', 'mixer': '#KitchenDeal', 'blender': '#KitchenDeal',
  'light': '#HomeSmart', 'bulb': '#HomeSmart', 'led': '#HomeSmart',
  'storage': '#Organizer', 'bottle': '#DailyNeeds',
  'toy': '#KidsFun', 'game': '#GamingDeal', 'puzzle': '#KidsFun',
};

function getDealHashtags(deal, category) {
  const tags = new Set();

  // 1. Category-based hashtags
  const catKey = (category || '').toLowerCase();
  if (CATEGORY_HASHTAGS[catKey]) {
    CATEGORY_HASHTAGS[catKey].forEach(t => tags.add(t));
  }

  // 2. Source-based hashtags (from discovery URL key)
  if (deal.source && CATEGORY_HASHTAGS[deal.source]) {
    CATEGORY_HASHTAGS[deal.source].forEach(t => tags.add(t));
  }

  // 3. Price-range hashtags
  const price = deal.finalPrice || deal.price;
  if (price) {
    if (price <= 99) tags.add('#Under99');
    else if (price <= 199) tags.add('#Under199');
    else if (price <= 299) tags.add('#Under299');
    else if (price <= 399) tags.add('#Under399');
    else if (price <= 499) tags.add('#Under499');
    else if (price <= 599) tags.add('#Under599');
    else if (price <= 799) tags.add('#Under799');
    else if (price <= 999) tags.add('#Under999');
    else if (price <= 1499) tags.add('#Under1499');
    else if (price <= 1999) tags.add('#Under2K');
    else if (price <= 2999) tags.add('#Under3K');
    else if (price <= 4999) tags.add('#Under5K');
    else if (price <= 9999) tags.add('#Under10K');
    else tags.add('#PremiumDeal');
  }

  // 4. Discount-level hashtags
  const mrp = deal.mrp || deal.originalPrice;
  const discount = deal.discountPct || (mrp && price ? Math.round((1 - price / mrp) * 100) : 0);
  if (discount >= 70) tags.add('#MegaDeal');
  else if (discount >= 50) tags.add('#HalfPrice');
  else if (discount >= 30) tags.add('#GreatDeal');

  // 5. Title-keyword hashtags (auto-detect category from product name)
  if (deal.title) {
    const titleLower = deal.title.toLowerCase();
    for (const [keyword, hashtag] of Object.entries(KEYWORD_HASHTAGS)) {
      if (titleLower.includes(keyword)) {
        tags.add(hashtag);
      }
    }
  }

  // 6. Always add the channel tag
  tags.add('#DealDecode');

  // 7. Price drop tag
  if (deal._isReprice) tags.add('#PriceDrop');

  // Return max 3 hashtags (keep it clean)
  return [...tags].slice(0, 3).join(' ');
}

function shuffleArray(arr) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Clean title - natural, not overly formatted
function cleanTitle(title) {
  if (!title) return '';

  // Remove excessive whitespace and normalize
  let cleaned = title
    .replace(/\s+/g, ' ')
    .replace(/\s*\|\s*/g, ' | ')
    .trim();

  // Truncate if too long but keep natural
  if (cleaned.length > 90) {
    cleaned = cleaned.substring(0, 87) + '...';
  }

  return cleaned;
}

// Escape text for Telegram HTML parse_mode
function escapeHtml(text) {
  if (!text) return '';
  // Build entities by concatenation to prevent formatter decoding
  const AMP = '&' + 'amp;';
  const LT = '&' + 'lt;';
  const GT = '&' + 'gt;';
  const QUOT = '&' + 'quot;';
  return String(text)
    .replace(/&/g, AMP)
    .replace(/</g, LT)
    .replace(/>/g, GT)
    .replace(/"/g, QUOT)
    .replace(/'/g, '&#39;');
}

// Shared builder — exact post format the user specified:
// [Hook 1-liner]
//
// [Title]
//
// 💰 ₹X,XXX  ~~₹X,XXX~~  · XX% OFF
// ⭐ 4.3 · 2,400+ reviews
//
// 👉 Buy Now on Amazon
//
// [Motivation line 1]
// [Motivation line 2]
//
// #Hash1 #Hash2 #Hash3
function buildStructuredCaption(deal, category, hook, motivationLines) {
  // Safety check: ensure title is actually from this specific deal
  if (!deal || !deal.title) {
    logger.warn('buildStructuredCaption called with missing deal or title', {
      hasDeal: !!deal,
      hasTitle: !!deal?.title,
      dealAsin: deal?.asin
    });
    return '<b>Deal Unavailable</b>\n\nSorry, deal information is not available.';
  }

  let title = escapeHtml((deal.title || '').replace(/\s+/g, ' ').trim());
  if (title.length > 60) title = title.substring(0, 57).replace(/\s+\S*$/, '') + '...';

  const price = deal.finalPrice || deal.price;
  // Use normalized fields — normalizeDeal should have reconstructed these
  let mrp = deal.mrp || deal.originalPrice || 0;
  let discount = deal.discountPct || deal.discount_pct || 0;

  // Final fallback reconstruction inside caption builder (belt + suspenders)
  if ((!mrp || mrp <= 0) && discount > 0 && discount < 100 && price > 0) {
    mrp = Math.round(price / (1 - discount / 100));
  }
  if ((!discount || discount <= 0) && mrp && mrp > price && price > 0) {
    discount = Math.round((1 - price / mrp) * 100);
  }

  const rating = deal.rating;
  const reviews = deal.reviewCount;

  let c = '';

  // 1. Hook
  c += `${escapeHtml(hook)}\n\n`;

  // 2. Title
  c += `<b>${title}</b>\n\n`;

  // 3. Price line — ALWAYS show MRP with strikethrough when available
  // Competitor format: "Deal Price: ₹99 ~~₹399~~" — the strike is the trust signal
  if (mrp && mrp > price && discount > 0) {
    c += `💰 <b>₹${price.toLocaleString('en-IN')}</b>  <s>₹${mrp.toLocaleString('en-IN')}</s>  · ${discount}% OFF\n`;
  } else if (mrp && mrp > price) {
    // Have MRP but no discount % — still show the strike
    c += `💰 <b>₹${price.toLocaleString('en-IN')}</b>  <s>₹${mrp.toLocaleString('en-IN')}</s>\n`;
  } else {
    // Truly no MRP data even after reconstruction — show clean price only
    c += `💰 <b>₹${price ? price.toLocaleString('en-IN') : 'Check price'}</b>\n`;
  }

  // 4. Reviews line — always show if available (reviews build trust)
  if (rating) {
    c += `⭐ ${rating}`;
    if (reviews && reviews > 0) c += ` · ${reviews.toLocaleString('en-IN')}+ ratings`;
    c += `\n`;
  }

  // 5. Bank Offers / Card Discount line
  const bankOffers = deal.bankOffers || deal.bank_offers;
  if (bankOffers) {
    // Extract key info for a punchy one-liner instead of raw scraped text
    const offerText = String(bankOffers).trim();
    // Try to extract savings amount (₹X,XXX or X%)
    const savingsMatch = offerText.match(/₹\s?[\d,]+(?:\.\d+)?|(\d+)%/);
    // Try to extract bank name
    const bankMatch = offerText.match(/HDFC|ICICI|SBI|Axis|Kotak|Amazon Pay|RuPay/i);
    
    if (savingsMatch && bankMatch) {
      // Punchy format: "💳 HDFC Card: Upto ₹3,000 extra off"
      const savings = savingsMatch[0];
      const bank = bankMatch[0];
      const type = /cashback/i.test(offerText) ? 'cashback' : 'extra off';
      c += `💳 <b>${escapeHtml(bank)} Card:</b> Upto ${escapeHtml(savings)} ${type}\n`;
    } else {
      // Fallback: show cleaned text, truncated for readability
      const cleanOffer = offerText.length > 80 ? offerText.substring(0, 77) + '...' : offerText;
      c += `💳 <b>Bank Offer:</b> ${escapeHtml(cleanOffer)}\n`;
    }
  } else if (price && price >= 5000) {
    // High-ticket item — Amazon almost always has card offers, nudge users to check
    c += `💳 Extra bank/card discounts available — check on Amazon\n`;
  }

  c += '\n';

  // 5. Buy link lives in the inline keyboard button — not in caption text

  // 6. Motivation lines (price-aware, already filtered by getSmartMotivation)
  if (motivationLines && motivationLines.length > 0) {
    motivationLines.forEach(line => { c += `${escapeHtml(line)}\n`; });
  }

  // 7. Hashtags
  const hashtags = getDealHashtags(deal, category);
  if (hashtags) c += `\n${hashtags}`;

  return c;
}

function generateNaturalCaption(deal, category) {
  const hook = getCategoryHook(deal, category);
  const motivation = getCategoryMotivation(deal, category);
  return buildStructuredCaption(deal, category, hook, motivation);
}

// Quick uses same format with 1 motivation line
function generateQuickCaption(deal, category) {
  const hook = getCategoryHook(deal, category);
  const motivation = getCategoryMotivation(deal, category).slice(0, 1);
  return buildStructuredCaption(deal, category, hook, motivation);
}

class TelegramPostingAgent {
  constructor() {
    this.isRunning = false;
    this.postedCount = 0;
    this.lastPostTime = null;
    this.recentlyPosted = new Set(); // Track recently posted ASINs

    // Daily posting caps — increased for continuous pacing till 1am
    this.dailyCaps = {
      hot: 100,      // Hot deals per day
      good: 200,     // Good deals per day
      digest: 2,     // Digests per day
      total: 300,    // Total posts per day
    };
    this.todayPosted = { hot: 0, good: 0, digest: 0, total: 0, date: new Date().toDateString() };

    // Minimum gap between individual posts (prevents back-to-back spam)
    this.minPostGapMs = 2 * 60 * 1000; // 2 minutes

    // Category mixing: track last N categories to avoid repetition boredom
    this.recentCategoryHistory = []; // FIFO of last posted categories
    this.maxCategoryHistory = 3;     // Don't repeat a category within last 3 posts

    // Category priority tiers — high-margin / high-engagement first
    this.categoryTiers = {
      // 🔥 HIGH — phones, electronics, fashion, lifestyle, computers = money + engagement
      mobiles: 'high',
      electronics: 'high',
      laptops: 'high',
      fashion: 'high',
      beauty: 'high',
      kitchen: 'high',
      homeimprovement: 'high',
      sports: 'high',
      headphones: 'high',
      smarthome: 'high',
      // 🟡 MEDIUM — decent but less viral
      toys: 'medium',
      grocery: 'medium',
      general: 'medium',
      // 🟢 LOW — low margin, keep for filler only
      books: 'low',
    };
  }

  async init() {
    logger.info('Initializing Telegram Posting Agent');

    // Verify bot token + store username for deep-links
    try {
      const me = await bot.getMe();
      BOT_USERNAME = me.username;
      logger.info('Bot connected', { username: BOT_USERNAME });
    } catch (err) {
      logger.error('Failed to connect to Telegram', { error: err.message });
      throw err;
    }

    // Register private-chat bot handlers
    this.registerBotHandlers();

    // Worker disabled in favor of burst scheduler (1-2 posts, 10-12 min gap)
    // this.startPostsWorker();

    // Start worker to process published deals
    this.startPublishedDealsWorker();

    // Start scheduled posting from database
    this.schedulePosting();

    // Update channel description (fire-and-forget)
    this.updateChannelDescription().catch(err =>
      logger.warn('Channel description update failed', { error: err.message })
    );

    // Periodically check and fire price alerts
    setInterval(() => this.checkPriceAlerts().catch(() => { }), 30 * 60 * 1000); // every 30 min
  }

  // ── Bot Interaction — private chat only ─────────────────
  registerBotHandlers() {
    const ASSOCIATE_TAG = process.env.AMAZON_ASSOCIATE_TAG || '';

    const affiliateLink = (asin) =>
      `https://www.amazon.in/dp/${asin}?tag=${ASSOCIATE_TAG}&linkCode=ll1`;

    const isPrivateChat = (msg) => msg.chat.type === 'private';

    // /start — welcome or alert registration
    bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
      if (!isPrivateChat(msg)) return;
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const param = match?.[1]?.trim();

      if (param && param.startsWith('alert_')) {
        const asin = param.replace('alert_', '').trim();
        await this.registerPriceAlert(chatId, userId, asin);
      } else {
        await bot.sendMessage(chatId,
          `👋 <b>Hi! I'm DealDecode Bot</b>\n\n` +
          `I help you find the best Amazon deals and track prices 🔥\n\n` +
          `<b>What I can do:</b>\n` +
          `• Search deals: <i>"top 10 earphones under 2000"</i>\n` +
          `• Find products: <i>"best AC under 30000"</i>\n` +
          `• Price alerts: tap <b>🔔 Set Price Alert</b> on any channel post\n\n` +
          `Just type your query below!`,
          { parse_mode: 'HTML' }
        );
      }
    });

    // Handle text messages in private chat
    bot.on('message', async (msg) => {
      if (!isPrivateChat(msg)) return;
      if (!msg.text || msg.text.startsWith('/')) return;

      const chatId = msg.chat.id;
      const text = msg.text.trim();

      // Block personal/off-topic questions
      const offTopicPatterns = [
        /who are you/i, /your name/i, /how are you/i,
        /apna naam/i, /kya haal/i, /girlfriend/i, /politics/i,
        /cricket/i, /movie/i, /weather/i,
      ];
      if (offTopicPatterns.some(p => p.test(text))) {
        await bot.sendMessage(chatId,
          `😄 Main sirf deals aur shopping ke liye hoon!\n\nKuch dhundhna hai Amazon pe? Bata do! 🛍️`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Process as deal search query
      await bot.sendChatAction(chatId, 'typing');
      await this.handleDealQuery(chatId, text, affiliateLink);
    });

    logger.info('Bot private-chat handlers registered');
  }

  async registerPriceAlert(chatId, userId, asin) {
    try {
      // Get product info from DB
      const result = await query(
        `SELECT title, price, image_url FROM products WHERE asin = $1 ORDER BY last_updated DESC LIMIT 1`,
        [asin]
      );
      const product = result.rows[0];
      const title = product?.title || asin;

      await query(
        `INSERT INTO price_alerts (user_id, chat_id, asin, title, image_url, last_price)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, asin) WHERE active = TRUE
         DO UPDATE SET last_price = EXCLUDED.last_price, triggered_at = NULL`,
        [userId, chatId, asin, title, product?.image_url || null, product?.price || null]
      );

      await bot.sendMessage(chatId,
        `🔔 <b>Price Alert Set!</b>\n\n` +
        `<b>${title}</b>\n\n` +
        `Main price track kar raha hoon. Jaise hi price drop hoga, main tumhe instantly bataunga! ⚡\n\n` +
        `<i>Alert cancel karne ke liye /alerts type karo</i>`,
        { parse_mode: 'HTML' }
      );
      logger.info('Price alert registered', { userId, asin });
    } catch (err) {
      logger.error('Failed to register price alert', { error: err.message, asin });
      await bot.sendMessage(chatId, `⚠️ Alert set nahi ho paya, thoda baad try karo!`);
    }
  }

  async handleDealQuery(chatId, queryText, affiliateLink) {
    try {
      // Parse limit from query — "top 5", "top 10", default 5
      const limitMatch = queryText.match(/\b(top|best)\s+(\d+)\b/i);
      const limit = limitMatch ? Math.min(parseInt(limitMatch[2]), 10) : 5;

      // Parse price ceiling — "under 2000", "under ₹5000"
      const priceMatch = queryText.match(/under\s*₹?\s*(\d[\d,]*)/i);
      const maxPrice = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : null;

      // Extract keywords (remove top/best/under/price amounts, but PRESERVE product numbers like 5g, 11r)
      const keywords = queryText
        .replace(/top\s+\d+/gi, '')
        .replace(/best\s+/gi, '')
        .replace(/under\s*₹?\s*[\d,]+/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!keywords || keywords.length < 2) {
        await bot.sendMessage(chatId,
          `🤔 Thoda aur specific bato!\n\nExample: <i>"top 5 earphones under 2000"</i> ya <i>"best laptop under 50000"</i>`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Search products DB
      let dbQuery = `
        SELECT DISTINCT ON (p.asin) p.asin, p.title, p.price, p.mrp, p.discount_pct,
               p.rating, p.review_count, p.image_url, p.category
        FROM products p
        WHERE to_tsvector('english', p.title || ' ' || COALESCE(p.semantic_tags, '')) @@ plainto_tsquery('english', $1)
          AND p.price IS NOT NULL AND p.price > 0
      `;
      const params = [keywords];

      if (maxPrice) {
        dbQuery += ` AND p.price <= $${params.length + 1}`;
        params.push(maxPrice);
      }

      dbQuery += ` ORDER BY p.asin, p.rating DESC NULLS LAST, p.review_count DESC NULLS LAST LIMIT $${params.length + 1}`;
      params.push(limit);

      const results = await query(dbQuery, params);

      if (!results.rows.length) {
        await bot.sendMessage(chatId,
          `😕 Abhi database mein "<b>${keywords}</b>" ke deals nahi hain.\n\n` +
          `Channel pe daily fresh deals aate hain — <b>${CHANNEL_ID}</b> follow karo! 🔥`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Send header
      await bot.sendMessage(chatId,
        `🔍 <b>${results.rows.length} deals mila "${keywords}" ke liye${maxPrice ? ` under ₹${maxPrice.toLocaleString('en-IN')}` : ''}</b>`,
        { parse_mode: 'HTML' }
      );

      // Send each product as a separate message with buttons
      for (const p of results.rows) {
        const price = p.price;
        let mrp = p.mrp;
        let disc = p.discount_pct || (mrp && price ? Math.round((1 - price / mrp) * 100) : 0);

        // Reconstruct MRP if missing but we have discount (from legacy DB entries)
        if ((!mrp || mrp <= 0) && disc > 0 && disc < 100 && price > 0) {
          mrp = Math.round(price / (1 - disc / 100));
        }

        const url = affiliateLink(p.asin);
        const title = (p.title || '').substring(0, 60);

        let text = `<b>${title}</b>\n`;
        if (mrp && mrp > price) {
          text += `💰 <b>₹${price.toLocaleString('en-IN')}</b>  <s>₹${mrp.toLocaleString('en-IN')}</s>  · ${disc}% OFF\n`;
        } else {
          text += `💰 <b>₹${price.toLocaleString('en-IN')}</b>\n`;
        }
        if (p.rating) text += `⭐ ${p.rating}${p.review_count ? ` · ${p.review_count.toLocaleString('en-IN')}+ ratings` : ''}\n`;

        const alertLink = BOT_USERNAME
          ? `https://t.me/${BOT_USERNAME}?start=alert_${p.asin}`
          : null;

        const buttons = [[{ text: '🛒 Buy on Amazon', url }]];
        if (alertLink) buttons[0].push({ text: '🔔 Set Alert', url: alertLink });

        const msgOptions = {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: buttons },
        };

        if (p.image_url) {
          await bot.sendPhoto(chatId, p.image_url, { caption: text, ...msgOptions });
        } else {
          await bot.sendMessage(chatId, text, msgOptions);
        }

        await new Promise(r => setTimeout(r, 400)); // small delay between messages
      }
    } catch (err) {
      logger.error('Deal query failed', { error: err.message });
      await bot.sendMessage(chatId, `⚠️ Kuch error aa gaya, thoda baad try karo!`);
    }
  }

  async checkPriceAlerts() {
    try {
      const ASSOCIATE_TAG = process.env.AMAZON_ASSOCIATE_TAG || '';
      // Find active alerts where current price has dropped
      const alerts = await query(`
        SELECT pa.*, p.price as current_price, p.title as current_title
        FROM price_alerts pa
        LEFT JOIN LATERAL (
          SELECT price, title FROM products WHERE asin = pa.asin
          ORDER BY last_updated DESC LIMIT 1
        ) p ON TRUE
        WHERE pa.active = TRUE
          AND p.price IS NOT NULL
          AND (pa.last_price IS NULL OR p.price < pa.last_price * 0.98)
          AND (pa.triggered_at IS NULL OR pa.triggered_at < NOW() - INTERVAL '24 hours')
      `);

      for (const alert of alerts.rows) {
        const url = `https://www.amazon.in/dp/${alert.asin}?tag=${ASSOCIATE_TAG}&linkCode=ll1`;
        const title = alert.current_title || alert.title || alert.asin;
        const drop = alert.last_price
          ? `₹${Math.round(alert.last_price - alert.current_price).toLocaleString('en-IN')} cheaper!`
          : 'Price drop detected!';

        try {
          await bot.sendMessage(alert.chat_id,
            `🔔 <b>Price Alert!</b>\n\n` +
            `<b>${title}</b>\n\n` +
            `💰 <b>₹${alert.current_price.toLocaleString('en-IN')}</b> — ${drop}`,
            {
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: [[{ text: '🛒 Buy Now on Amazon', url }]] },
            }
          );
          await query(
            `UPDATE price_alerts SET triggered_at = NOW(), last_price = $1 WHERE id = $2`,
            [alert.current_price, alert.id]
          );
          logger.info('Price alert fired', { asin: alert.asin, userId: alert.user_id });
        } catch (e) {
          logger.warn('Failed to send price alert', { error: e.message, alertId: alert.id });
        }
      }
    } catch (err) {
      logger.warn('Price alert check failed', { error: err.message });
    }
  }


  async updateChannelDescription() {
    const description = `🔥 India's Smartest Deal Finder — Amazon & more
📊 Every deal is price-verified with history
💰 Save up to 80% on top brands daily
⏰ Fresh deals 8AM - 11PM IST

🏷️ Browse by category:
#TechLoot #MobileDeal #LaptopDeal #AudioDeal
#FashionDeal #BeautySteal #KitchenDeal
#FitnessDeal #GymGear #HomeSmart
#BookDeal #GroceryDeal #GamingDeal

💸 Browse by price:
#Under99 #Under199 #Under299 #Under499
#Under999 #Under2K #Under5K #Under10K

🔥 Deal types:
#MegaDeal #HalfPrice #PriceDrop #LightningDeal
#DealOfTheDay #GreatSummerSale

🤖 Powered by DealDecode AI`;

    try {
      await bot.setChatDescription(CHANNEL_ID, description);
      logger.info('Channel description updated successfully');
    } catch (err) {
      logger.warn('Could not update channel description', { error: err.message });
    }
  }

  // Process deals queued by deal-analysis agent
  startPostsWorker() {
    logger.info('Starting posts worker for queue: posts');
    const worker = createWorker('posts', async (job) => {
      // Handle both nested { deal, score } and flat data shapes (resilient)
      const deal = job.data.deal || job.data;
      const score = job.data.score || { score: deal.score || 0, verdict: deal.verdict || 'good' };

      logger.info('Processing post job from deal-analysis', { asin: deal.asin, verdict: score.verdict });

      // Enforce minimum gap between posts
      if (this.lastPostTime && this.minPostGapMs) {
        const elapsed = Date.now() - new Date(this.lastPostTime).getTime();
        if (elapsed < this.minPostGapMs) {
          const waitMs = this.minPostGapMs - elapsed;
          logger.info(`Waiting ${Math.round(waitMs / 1000)}s for min post gap`);
          await new Promise(r => setTimeout(r, waitMs));
        }
      }

      await this.publishDeal(deal, deal.category || 'general', score);
    });

    worker.on('completed', (job) => {
      const asin = job.data?.deal?.asin || job.data?.asin || 'unknown';
      logger.info('Deal from analysis posted to Telegram', { asin });
    });

    worker.on('failed', (job, err) => {
      postingErrorsTotal.inc({ type: 'posts_worker' });
      const asin = job?.data?.deal?.asin || job?.data?.asin || 'unknown';
      logger.error('Failed to post deal from analysis', { asin, error: err.message });
    });

    worker.on('error', (err) => {
      logger.error('Worker error', { error: err.message, stack: err.stack });
    });

    logger.info('Posts worker started successfully');
  }

  // Process manually published deals
  startPublishedDealsWorker() {
    const worker = createWorker('published-deals', async (job) => {
      const { deal, category } = job.data;
      await this.publishDeal(deal, category || 'general');
    });

    worker.on('completed', (job) => {
      logger.info('Published deal posted to Telegram', { asin: job.data.deal.asin });
    });

    worker.on('failed', (job, err) => {
      postingErrorsTotal.inc({ type: 'published_worker' });
      logger.error('Failed to post published deal', { asin: job?.data?.deal?.asin, error: err.message });
    });
  }

  schedulePosting() {
    // Schedule periodic cleanup of old cached images (every 6 hours)
    setInterval(() => {
      cleanupOldImages(7).catch(err => {
        logger.error('Image cleanup failed', { error: err.message });
      });
    }, 6 * 60 * 60 * 1000);

    // Run cleanup immediately on start
    cleanupOldImages(7).catch(err => {
      logger.error('Initial image cleanup failed', { error: err.message });
    });

    // Schedule digest posts at optimal times (8 AM, 12 PM, 6 PM IST)
    this.scheduleDigestPosts();

    /**
     * Burst scheduler — smart category mixing:
     * 1. Prioritizes high-tier categories (phones, electronics, fashion, lifestyle, computers)
     * 2. Never repeats the same category within last 3 posts
     * 3. Low-margin categories (books, etc.) only used as filler
     */
    const scheduleBurstPost = async () => {
      try {
        if (!this.isActiveHours()) {
          logger.info('Outside active hours, skipping burst post');
          setTimeout(scheduleBurstPost, 10 * 60 * 1000);
          return;
        }

        // Reset daily caps if new day
        const today = new Date().toDateString();
        if (this.todayPosted.date !== today) {
          this.todayPosted = { hot: 0, good: 0, digest: 0, total: 0, date: today };
        }
        if (this.todayPosted.total >= this.dailyCaps.total) {
          logger.info('Daily cap reached, skipping burst');
          setTimeout(scheduleBurstPost, 30 * 60 * 1000);
          return;
        }

        // How many to post this burst (1-2, capped by remaining daily budget)
        const remaining = this.dailyCaps.total - this.todayPosted.total;
        const burstSize = Math.min(randomInt(1, 2), remaining);

        // Fetch deals — get extra for variety and tier filtering
        const deals = await this.getApprovedDeals(burstSize * 4); // fetch more for smart selection
        if (deals.length === 0) {
          logger.info('No approved deals for burst post');
          setTimeout(scheduleBurstPost, randomInt(3, 6) * 60 * 1000);
          return;
        }

        // ── Smart category mixing ──────────────────────────────────────────
        const selected = [];
        const selectedAsins = new Set();
        const selectedCats = new Set();

        // Build tiered pools
        const highTier = [];
        const mediumTier = [];
        const lowTier = [];

        for (const deal of deals) {
          const cat = deal.category || 'general';
          const tier = this.categoryTiers[cat] || 'medium';
          if (tier === 'high') highTier.push(deal);
          else if (tier === 'medium') mediumTier.push(deal);
          else lowTier.push(deal);
        }

        // Shuffle each tier so even within tier it's unpredictable
        const shuffle = arr => {
          for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
          }
          return arr;
        };
        shuffle(highTier);
        shuffle(mediumTier);
        shuffle(lowTier);

        // Helper: can we use this category? (not recently used + not already selected)
        const isCategoryEligible = (cat) => {
          const recentCats = this.recentCategoryHistory.slice(-this.maxCategoryHistory);
          return !recentCats.includes(cat) && !selectedCats.has(cat);
        };

        // Pick from a tier, respecting category rotation
        const pickFromTier = (tier) => {
          for (const deal of tier) {
            const cat = deal.category || 'general';
            if (!selectedAsins.has(deal.asin) && isCategoryEligible(cat)) {
              return deal;
            }
          }
          return null;
        };

        // Phase 1: Fill burst with high-tier deals (phones, electronics, fashion, etc.)
        while (selected.length < burstSize) {
          const deal = pickFromTier(highTier) || pickFromTier(mediumTier) || pickFromTier(lowTier);
          if (!deal) break; // no more eligible deals at all
          selected.push(deal);
          selectedAsins.add(deal.asin);
          selectedCats.add(deal.category || 'general');
        }

        // Phase 2: If still not full, relax category restriction but keep tier priority
        if (selected.length < burstSize) {
          const leftover = [...highTier, ...mediumTier, ...lowTier].filter(
            d => !selectedAsins.has(d.asin)
          );
          for (const deal of leftover) {
            if (selected.length >= burstSize) break;
            selected.push(deal);
            selectedAsins.add(deal.asin);
          }
        }

        logger.info('Burst selected', {
          burstSize: selected.length,
          categories: [...selectedCats],
          highTierCount: selected.filter(d => (this.categoryTiers[d.category] || 'medium') === 'high').length,
        });

        // Post each deal with a short stagger (15-30s apart)
        for (const deal of selected) {
          if (this.todayPosted.total >= this.dailyCaps.total) break;
          await this.publishDeal(deal, deal.category || 'general');
          if (selected.indexOf(deal) < selected.length - 1) {
            await new Promise(r => setTimeout(r, randomInt(15, 30) * 1000));
          }
        }

        logger.info(`Burst complete: posted ${selected.length} deals`);
      } catch (err) {
        postingErrorsTotal.inc({ type: 'burst' });
        logger.error('Burst posting failed', { error: err.message });
      }

      // Schedule next burst in 10-12 minutes
      const nextInterval = randomInt(10, 12) * 60 * 1000;
      logger.info(`Next burst in ${Math.round(nextInterval / 60000)} min`);
      setTimeout(scheduleBurstPost, nextInterval);
    };

    // Start first burst after 1 min
    const initialDelay = 60 * 1000;
    logger.info(`First burst in 1 min`);
    setTimeout(scheduleBurstPost, initialDelay);
  }

  // Schedule digest posts at specific times for organized presentation
  scheduleDigestPosts() {
    // Calculate time until next scheduled digest
    const getTimeUntil = (targetHour) => {
      const now = new Date();
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istNow = new Date(now.getTime() + istOffset);
      const target = new Date(istNow);
      target.setUTCHours(targetHour, 0, 0, 0);

      if (istNow.getUTCHours() >= targetHour) {
        target.setUTCDate(target.getUTCDate() + 1);
      }

      return target.getTime() - istNow.getTime();
    };

    // Schedule morning digest (8 AM IST)
    const scheduleMorningDigest = () => {
      const delay = getTimeUntil(8);
      logger.info(`Morning digest scheduled in ${Math.round(delay / 3600000)} hours`);
      setTimeout(async () => {
        await this.postCategoryDigest('morning');
        // Reschedule for next day
        setInterval(() => this.postCategoryDigest('morning'), 24 * 60 * 60 * 1000);
      }, delay);
    };

    // Schedule afternoon digest (12 PM IST)
    const scheduleAfternoonDigest = () => {
      const delay = getTimeUntil(12);
      logger.info(`Afternoon digest scheduled in ${Math.round(delay / 3600000)} hours`);
      setTimeout(async () => {
        await this.postCategoryDigest('afternoon');
        // Reschedule for next day
        setInterval(() => this.postCategoryDigest('afternoon'), 24 * 60 * 60 * 1000);
      }, delay);
    };

    // Schedule evening digest (6 PM IST)
    const scheduleEveningDigest = () => {
      const delay = getTimeUntil(18);
      logger.info(`Evening digest scheduled in ${Math.round(delay / 3600000)} hours`);
      setTimeout(async () => {
        await this.postCategoryDigest('evening');
        // Reschedule for next day
        setInterval(() => this.postCategoryDigest('evening'), 24 * 60 * 60 * 1000);
      }, delay);
    };

    // Start all digest schedules
    scheduleMorningDigest();
    scheduleAfternoonDigest();
    scheduleEveningDigest();
  }

  // Post a digest of top deals by category
  async postCategoryDigest(timeOfDay) {
    try {
      if (!this.isActiveHours()) {
        logger.info('Outside active hours, skipping digest');
        return;
      }

      const deals = await this.getApprovedDeals(20);
      if (deals.length === 0) {
        logger.info('No deals available for digest');
        return;
      }

      // Group deals by category
      const byCategory = {};
      for (const deal of deals) {
        const cat = deal.category || 'general';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(deal);
      }

      // Generate digest header based on time of day
      const headers = {
        morning: '🌅 Good Morning! Today\'s Best Deals',
        afternoon: '☀️ Afternoon Deal Roundup',
        evening: '🌆 Evening Deal Digest - Last Chance!',
      };

      let digestText = `<b>${headers[timeOfDay] || '📋 Deal Digest'}</b>\n\n`;

      // Add top deals from each category (max 3 per category, max 5 categories)
      const categories = Object.keys(byCategory).slice(0, 5);
      let totalDeals = 0;

      for (const cat of categories) {
        const catDeals = byCategory[cat].slice(0, 3);
        if (catDeals.length === 0) continue;

        const catEmoji = this.getCategoryEmoji(cat);
        digestText += `<b>${catEmoji} ${cat.charAt(0).toUpperCase() + cat.slice(1)}</b>\n`;

        for (const deal of catDeals) {
          const price = deal.finalPrice || deal.price;
          const mrp = deal.mrp || deal.originalPrice;
          const discount = deal.discountPct || (mrp ? Math.round((1 - price / mrp) * 100) : 0);
          const safeTitle = escapeHtml(deal.title?.substring(0, 50) || 'Unknown');
          const safeUrl = escapeHtml(deal.affiliateUrl || deal.productUrl || '');

          digestText += `• ${safeTitle}${deal.title?.length > 50 ? '...' : ''}\n`;
          digestText += `  💰 ₹${price.toLocaleString('en-IN')}`;
          if (mrp && mrp > price) {
            digestText += ` <s>₹${mrp.toLocaleString('en-IN')}</s> (-${discount}%)`;
          }
          digestText += `\n`;
          if (safeUrl) {
            digestText += `  <a href="${safeUrl}">👉 Buy Now</a>\n`;
          }
          totalDeals++;
        }
        digestText += `\n`;
      }

      digestText += `<i>Prices change karte rehte hain ✅</i>\n`;
      digestText += `#DealDecode #DailyDeals`;

      if (totalDeals > 0) {
        const message = await bot.sendMessage(CHANNEL_ID, digestText, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });

        // Track digest in database
        await query(
          `INSERT INTO posted_digests (time, type, deal_count, categories, message_id)
           VALUES (NOW(), $1, $2, $3, $4)`,
          [timeOfDay, totalDeals, categories, message.message_id]
        );

        postsPublishedTotal.inc({ category: 'digest', status: 'success' });
        this.postedCount++;
        this.lastPostTime = new Date().toISOString();

        logger.info('Digest posted successfully', {
          timeOfDay,
          totalDeals,
          categories: categories.length,
          messageId: message.message_id
        });
      }
    } catch (err) {
      postingErrorsTotal.inc({ type: 'digest' });
      logger.error('Failed to post digest', { timeOfDay, error: err.message });
    }
  }

  getCategoryEmoji(category) {
    const emojis = {
      electronics: '💻',
      mobiles: '📱',
      laptops: '💻',
      headphones: '🎧',
      kitchen: '🍳',
      homeimprovement: '🔨',
      sports: '⚽',
      fashion: '👕',
      beauty: '💄',
      toys: '🧸',
      books: '📚',
      grocery: '🛒',
      deals: '🔥',
      greatsale: '🎉',
      lightning: '⚡',
      todaysdeals: '📅',
      bestsellers: '🏆',
      under99: '💰',
      under199: '💰',
      under499: '💰',
      under999: '💰',
    };
    return emojis[category] || '📦';
  }

  // Check if current time is within active posting hours (7 AM - 1 AM IST)
  // TESTING_MODE bypasses this check — allows 24hr posting
  isActiveHours() {
    if (process.env.TESTING_MODE === 'true') return true;
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    const hour = istNow.getUTCHours();
    return hour >= 7 || hour < 1; // 7 AM - 1 AM IST
  }

  async getApprovedDeals(limit = 10) {
    try {
      const result = await query(
        `SELECT p.*, 
                COALESCE(ph.price, p.price) as latest_price,
                COALESCE(ph.mrp, p.mrp) as latest_mrp,
                COALESCE(ph.discount_pct, p.discount_pct) as latest_discount_pct
         FROM products p
         LEFT JOIN LATERAL (
           SELECT price, mrp, discount_pct 
           FROM price_history 
           WHERE asin = p.asin 
           ORDER BY time DESC LIMIT 1
         ) ph ON true
         WHERE p.affiliate_url IS NOT NULL
         AND p.verdict IN ('hot', 'good')
         AND p.last_updated > NOW() - INTERVAL '48 hours'
         AND NOT EXISTS (
           SELECT 1 FROM posted_deals pd 
           WHERE pd.asin = p.asin 
           AND pd.time > NOW() - INTERVAL '24 hours'
         )
         ORDER BY COALESCE(ph.discount_pct, p.discount_pct) DESC NULLS LAST, p.last_updated DESC 
         LIMIT $1`,
        [limit]
      );
      return result.rows.map(row => ({
        asin: row.asin,
        title: row.title,
        price: row.latest_price || row.price,
        mrp: row.latest_mrp || row.mrp,
        discountPct: row.latest_discount_pct || row.discount_pct,
        rating: row.rating,
        reviewCount: row.review_count,
        imageUrl: row.image_url,
        productUrl: row.product_url,
        affiliateUrl: row.affiliate_url,
        category: row.category,
        bankOffers: row.bank_offers,
        verdict: row.verdict,
      }));
    } catch (err) {
      logger.error('Failed to get approved deals', { error: err.message });
      return [];
    }
  }

  // Normalize deal object to ensure all required fields are present and correct
  // This is CRITICAL for MRP strikethrough display — if MRP or discount are missing,
  // we reconstruct them from whatever data we have.
  normalizeDeal(deal) {
    // Create a copy to avoid mutation
    const normalized = { ...deal };

    // Ensure required string fields are actually strings (not undefined/null)
    normalized.asin = String(normalized.asin || '').trim();
    normalized.title = String(normalized.title || '').trim();
    normalized.category = String(normalized.category || 'general').trim();

    // Ensure price fields are numbers
    normalized.price = Number(normalized.price || normalized.finalPrice || 0);
    normalized.mrp = Number(normalized.mrp || normalized.originalPrice || 0);
    normalized.rating = Number(normalized.rating || 0) || undefined;
    normalized.reviewCount = Number(normalized.reviewCount || 0) || undefined;

    // Normalize discount fields — discount_pct (DB) and discountPct (internal) must stay in sync
    const rawDiscount = normalized.discountPct ?? normalized.discount_pct ?? normalized.discount;
    normalized.discountPct = Number(rawDiscount || 0) || undefined;
    normalized.discount_pct = normalized.discountPct; // keep both synced

    // ── MRP / Discount reconstruction (critical for strikethrough display) ──

    // Case 1: MRP missing, but we have discountPct + price → reconstruct MRP
    // e.g. price=99, discount=75% → mrp = 99 / (1 - 0.75) = 396
    if ((!normalized.mrp || normalized.mrp <= 0) && normalized.discountPct && normalized.discountPct > 0 && normalized.discountPct < 100 && normalized.price > 0) {
      normalized.mrp = Math.round(normalized.price / (1 - normalized.discountPct / 100));
      logger.debug('Reconstructed MRP from discount', {
        asin: normalized.asin,
        price: normalized.price,
        discount: normalized.discountPct,
        reconstructedMrp: normalized.mrp,
      });
    }

    // Case 2: Discount missing, but we have MRP + price → compute discount
    if ((!normalized.discountPct || normalized.discountPct <= 0) && normalized.mrp && normalized.mrp > normalized.price && normalized.price > 0) {
      normalized.discountPct = Math.round((1 - normalized.price / normalized.mrp) * 100);
      normalized.discount_pct = normalized.discountPct;
    }

    // Validate required fields
    if (!normalized.asin || normalized.asin.length !== 10) {
      logger.warn('Deal missing valid ASIN after normalization', { deal: normalized });
      return null;
    }
    if (!normalized.title) {
      logger.warn('Deal missing title after normalization', { asin: normalized.asin });
      return null;
    }
    if (normalized.price <= 0) {
      logger.warn('Deal missing or invalid price after normalization', { asin: normalized.asin });
      return null;
    }

    normalized.bankOffers = deal.bankOffers || deal.bank_offers;

    return normalized;
  }

  async publishDeal(deal, category, score = null) {
    isPostingBusy = true;
    activePostingGauge.set(1);

    try {
      // Normalize deal object to ensure all fields are correct
      const normalizedDeal = this.normalizeDeal(deal);
      if (!normalizedDeal) {
        logger.error('Failed to normalize deal, skipping', { originalAsin: deal?.asin });
        return;
      }

      deal = normalizedDeal; // Use normalized deal for rest of function

      // Check if we're in active posting hours (7 AM - 1 AM IST)
      if (!this.isActiveHours()) {
        logger.info('Outside active hours, skipping post', {
          asin: deal.asin,
          currentTime: new Date().toISOString()
        });
        return;
      }

      // Reset daily counters if new day
      const today = new Date().toDateString();
      if (this.todayPosted.date !== today) {
        this.todayPosted = { hot: 0, good: 0, digest: 0, total: 0, date: today };
        logger.info('Daily posting counters reset for new day');
      }

      // Enforce daily posting caps
      const verdict = score?.verdict || 'good';
      if (this.todayPosted.total >= this.dailyCaps.total) {
        logger.info('Daily total posting cap reached, skipping deal', {
          asin: deal.asin,
          cap: this.dailyCaps.total,
          posted: this.todayPosted.total
        });
        return;
      }
      if (verdict === 'hot' && this.todayPosted.hot >= this.dailyCaps.hot) {
        logger.info('Daily hot deal cap reached, skipping deal', {
          asin: deal.asin,
          cap: this.dailyCaps.hot,
          posted: this.todayPosted.hot
        });
        return;
      }
      if (verdict === 'good' && this.todayPosted.good >= this.dailyCaps.good) {
        logger.info('Daily good deal cap reached, skipping deal', {
          asin: deal.asin,
          cap: this.dailyCaps.good,
          posted: this.todayPosted.good
        });
        return;
      }

      // Check if posted within last 6 hours (unless price dropped 5%+)
      const recentPost = await query(
        `SELECT pd.*, ph.price as old_price
         FROM posted_deals pd
         LEFT JOIN price_history ph ON pd.asin = ph.asin AND ph.time < pd.time
         WHERE pd.asin = $1 
         AND pd.time > NOW() - INTERVAL '6 hours'
         ORDER BY pd.time DESC
         LIMIT 1`,
        [deal.asin]
      );

      if (recentPost.rowCount > 0) {
        const oldPrice = recentPost.rows[0].old_price;
        const currentPrice = deal.price || deal.finalPrice;

        // Only repost if price dropped by at least 5%
        if (!oldPrice || currentPrice >= oldPrice * 0.95) {
          logger.info('Skipping recently posted deal (no significant price drop)', {
            asin: deal.asin,
            oldPrice,
            currentPrice
          });
          return;
        } else {
          logger.info('Reposting due to price drop', {
            asin: deal.asin,
            oldPrice,
            currentPrice,
            dropPct: Math.round((1 - currentPrice / oldPrice) * 100)
          });
        }
      }

      // Skip if recently posted in memory
      if (this.recentlyPosted.has(deal.asin)) {
        logger.info('Skipping recently posted deal (in memory)', { asin: deal.asin });
        return;
      }

      // Validate URLs before posting
      const urlValidation = validateDealUrls(deal);
      if (!urlValidation.valid) {
        logger.error('Invalid URLs for deal, skipping', {
          asin: deal.asin,
          errors: urlValidation.errors
        });
        return;
      }

      // Use validated safe URLs
      const safeProductUrl = urlValidation.safeProductUrl;
      const safeAffiliateUrl = urlValidation.safeAffiliateUrl;

      // Ensure we have at least one valid URL
      if (!safeAffiliateUrl && !safeProductUrl) {
        logger.warn('No valid URL available for deal', { asin: deal.asin });
        return;
      }

      // Update deal with safe URLs for caption generation
      const safeDeal = {
        ...deal,
        productUrl: safeProductUrl,
        affiliateUrl: safeAffiliateUrl,
      };

      // ── Content Strategy: AI hook + structured template ──
      // AI generates hook + motivation lines only.
      // buildStructuredCaption() always controls the full layout — consistent every post.
      const aiEnabled = process.env.AI_CAPTION_ENABLED === 'true';
      let caption, captionSource, archetype;

      // 1. Get template hook + motivation as baseline (always available)
      // Use sale-aware versions that automatically detect active sales
      const templateHook = getSaleAwareHook(safeDeal, category);
      const templateMotivation = getSaleAwareMotivation(safeDeal, category);


      let finalHook = templateHook;
      let finalMotivation = templateMotivation;

      if (aiEnabled) {
        // Try to get an AI-generated hook + motivation lines
        const temporalContext = getTemporalContext();
        archetype = selectArchetype(safeDeal, null, temporalContext);
        const aiResult = await generateAICaption(safeDeal, null, { forceArchetype: archetype });

        if (aiResult && aiResult.hook) {
          finalHook = aiResult.hook;
          if (aiResult.motivationLines && aiResult.motivationLines.length > 0) {
            finalMotivation = aiResult.motivationLines;
          }
          captionSource = 'ai_structured';
          logger.info('Using AI hook+motivation in structured template', {
            asin: deal.asin,
            archetype: aiResult.archetype,
            source: aiResult.source,
          });
        } else {
          captionSource = 'template_fallback';
          logger.info('AI hook unavailable, using template', { asin: deal.asin });
        }
      } else {
        captionSource = 'template';
      }

      // 2. Always build via the structured template — same layout every post
      caption = buildStructuredCaption(safeDeal, category, finalHook, finalMotivation);

      // Build inline keyboard — Buy button + Set Alert deep-link to private chat
      const affiliateBtn = safeAffiliateUrl || safeProductUrl;
      const alertDeepLink = BOT_USERNAME
        ? `https://t.me/${BOT_USERNAME}?start=alert_${deal.asin}`
        : null;

      const inlineRow = [];
      if (affiliateBtn) inlineRow.push({ text: '🛒 Buy on Amazon', url: affiliateBtn });
      if (alertDeepLink) inlineRow.push({ text: '🔔 Set Price Alert', url: alertDeepLink });

      const sendOptions = {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        protect_content: false,
        ...(inlineRow.length > 0 && { reply_markup: { inline_keyboard: [inlineRow] } }),
      };

      let message;

      // Try to get high-quality image from product page
      let imageToSend = deal.imageUrl;
      let imageSource = 'database';

      if (safeDeal.productUrl || safeDeal.affiliateUrl) {
        try {
          const url = safeDeal.productUrl || safeDeal.affiliateUrl;
          const hqImage = await getHighQualityImage(url, deal.asin, deal.imageUrl);
          if (hqImage) {
            imageToSend = hqImage.localPath || hqImage.url;
            imageSource = hqImage.source;
            logger.info('Using high-quality image', {
              asin: deal.asin,
              source: hqImage.source,
              hasLocalPath: !!hqImage.localPath
            });
          }
        } catch (imgErr) {
          logger.warn('Failed to get high-quality image, using fallback', {
            asin: deal.asin,
            error: imgErr.message
          });
        }
      }

      if (imageToSend) {
        // If we have a local file path, read it and send as buffer
        if (imageToSend.startsWith('/')) {
          const fs = await import('fs/promises');
          const imageBuffer = await fs.readFile(imageToSend);
          message = await bot.sendPhoto(CHANNEL_ID, imageBuffer, {
            caption,
            ...sendOptions,
          });
        } else {
          // Send using URL
          message = await bot.sendPhoto(CHANNEL_ID, imageToSend, {
            caption,
            ...sendOptions,
          });
        }
      } else {
        message = await bot.sendMessage(CHANNEL_ID, caption, sendOptions);
      }

      // ── Voice Note for Exceptional Deals (Sarvam TTS) ──
      // Fires for score ≥ 4 or discount ≥ 10% — covers premium items like MacBook with real savings
      if (shouldSendVoiceNote(safeDeal, score)) {
        try {
          const script = await buildVoiceScript(safeDeal);
          logger.info('Generating voice note for hot deal', { asin: deal.asin, score: score?.score });
          const audioBuffer = await textToSpeech(script);
          if (audioBuffer) {
            await bot.sendVoice(CHANNEL_ID, audioBuffer, {
              caption: '🔊 Urgent deal alert! ⬆️ Details in the post above.',
              reply_to_message_id: message.message_id,
            });
            logger.info('Voice note sent', { asin: deal.asin });
          }
        } catch (voiceErr) {
          // Voice note failure should never block the main post flow
          logger.warn('Voice note failed (non-fatal)', { asin: deal.asin, error: voiceErr.message });
        }
      }

      // ── Record successful post BEFORE any DB updates that could fail ──
      // Insert into posted_deals immediately so retries, burst scheduler,
      // and other workers see this ASIN as already posted.
      try {
        await query(
          `INSERT INTO posted_deals (time, asin, deal_score, post_template, channel)
           VALUES (NOW(), $1, $2, $3, 'telegram')`,
          [deal.asin, score?.score || 0, captionSource || 'template']
        );
        logger.debug('Early dedup record inserted', { asin: deal.asin });
      } catch (dbErr) {
        // If we can't insert, log but don't throw — the later full insert will handle it
        logger.warn('Early dedup insert failed (non-fatal)', { asin: deal.asin, error: dbErr.message });
      }

      // Record successful post with message_id + content strategy metadata
      const contentType = verdict === 'hot' ? 'hot_deal' : verdict === 'good' ? 'good_deal' : 'standard';
      await query(
        `INSERT INTO posted_deals (
          time, asin, deal_score, post_template, channel, message_id,
          content_strategy, ai_generated, archetype, caption_source
        ) VALUES (NOW(), $1, $2, $3, 'telegram', $4, $5, $6, $7, $8)`,
        [
          deal.asin,
          score?.score || 0,
          captionSource || 'template',
          message.message_id,
          contentType,
          captionSource === 'ai_structured',
          archetype?.id || null,
          captionSource || 'template',
        ]
      );

      // Record A/B test assignment (no-op now — structured template always used)

      // Record post metadata for revenue pacing
      const revenueMultiplier = archetype ? 1.0 : 1.0; // Will be filled by content-calendar
      await recordPostMetadata(message.message_id, {
        strategy: contentType,
        archetype: archetype?.id || null,
        aiGenerated: captionSource === 'ai_structured',
        slot: getCurrentSlotConfig()?.label || null,
        revenueMultiplier,
      });

      // Increment daily posting counters
      this.todayPosted.total++;
      if (verdict === 'hot') this.todayPosted.hot++;
      if (verdict === 'good') this.todayPosted.good++;

      // Track category for smart rotation (FIFO — keep last N categories)
      this.recentCategoryHistory.push(category || 'general');
      if (this.recentCategoryHistory.length > this.maxCategoryHistory) {
        this.recentCategoryHistory.shift();
      }

      // Mark as recently posted (keep in memory for 24h)
      this.recentlyPosted.add(deal.asin);
      setTimeout(() => this.recentlyPosted.delete(deal.asin), 24 * 60 * 60 * 1000);

      postsPublishedTotal.inc({ category, status: 'success' });
      this.postedCount++;
      this.lastPostTime = new Date().toISOString();

      logger.info('Deal posted successfully', {
        asin: deal.asin,
        messageId: message.message_id,
        captionSource,
        urlUsed: safeDeal.affiliateUrl ? 'affiliate' : 'product'
      });

    } catch (err) {
      postingErrorsTotal.inc({ type: 'publish' });
      logger.error('Failed to publish deal', { asin: deal.asin, error: err.message });
    } finally {
      isPostingBusy = false;
      activePostingGauge.set(0);
    }
  }

  async editPost(messageId, newCaption) {
    try {
      await bot.editMessageCaption(newCaption, {
        chat_id: CHANNEL_ID,
        message_id: messageId,
        parse_mode: 'HTML',
      });
      logger.info('Post edited successfully', { messageId });
    } catch (err) {
      logger.error('Failed to edit post', { messageId, error: err.message });
    }
  }

  async deletePost(messageId) {
    try {
      await bot.deleteMessage(CHANNEL_ID, messageId);
      logger.info('Post deleted successfully', { messageId });
    } catch (err) {
      logger.error('Failed to delete post', { messageId, error: err.message });
    }
  }
}

// Start agent
const agent = new TelegramPostingAgent();
process.on('SIGINT', () => {
  logger.info('Shutting down Telegram Posting Agent');
  process.exit(0);
});
process.on('SIGTERM', () => {
  logger.info('Shutting down Telegram Posting Agent');
  process.exit(0);
});
agent.init().catch(err => {
  logger.error('Failed to start', err);
  process.exit(1);
});
