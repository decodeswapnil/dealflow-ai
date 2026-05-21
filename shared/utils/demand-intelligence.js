/**
 * Demand Intelligence Module
 * ─────────────────────────────────────────────────────────────────────────────
 * Encodes what Indian consumers actually want to buy, used across:
 *   - deal-discovery  → category quota enforcement, demand tagging
 *   - deal-analysis   → demand scoring dimension (15% weight)
 *   - curated-lists   → demand-weighted topic selection
 *
 * Design philosophy:
 *   Scrollers of deal channels are looking for impulse buys.
 *   A ₹199 off book almost never gets clicks. A ₹500 off phone case always does.
 *   We must mirror that reality in how we filter and score deals.
 */

// ── Category Demand Tiers ─────────────────────────────────────────────────────
// Based on Indian affiliate market data (CTR, conversion, commission rates).
// Tier determines max share of posts AND minimum bar to pass analysis.

export const DEMAND_TIERS = {
  // ── S-Tier: High impulse, high CTR, strong commissions ──────────────────
  // Target: ~60% of daily posts
  mobiles: { tier: 'S', label: '📱 Mobiles', maxSharePct: 0.20, minDiscount: 10, minRating: 3.5, minScore: 2.0 },
  electronics: { tier: 'S', label: '💻 Electronics', maxSharePct: 0.18, minDiscount: 10, minRating: 3.5, minScore: 2.0 },
  headphones: { tier: 'S', label: '🎧 Headphones', maxSharePct: 0.12, minDiscount: 15, minRating: 3.8, minScore: 2.0 },
  laptops: { tier: 'S', label: '💻 Laptops', maxSharePct: 0.10, minDiscount: 10, minRating: 3.5, minScore: 2.0 },
  fashion: { tier: 'S', label: '👕 Fashion', maxSharePct: 0.12, minDiscount: 30, minRating: 3.5, minScore: 2.0 },

  // ── A-Tier: Strong demand, good conversion ────────────────────────────────
  // Target: ~30% of daily posts
  kitchen: { tier: 'A', label: '🍳 Kitchen', maxSharePct: 0.08, minDiscount: 20, minRating: 3.8, minScore: 2.5 },
  beauty: { tier: 'A', label: '💄 Beauty', maxSharePct: 0.08, minDiscount: 20, minRating: 3.8, minScore: 2.5 },
  sports: { tier: 'A', label: '⚽ Sports', maxSharePct: 0.06, minDiscount: 20, minRating: 3.8, minScore: 2.5 },
  toys: { tier: 'A', label: '🧸 Toys', maxSharePct: 0.05, minDiscount: 25, minRating: 4.0, minScore: 2.5 },
  homeimprovement: { tier: 'A', label: '🔨 Home', maxSharePct: 0.05, minDiscount: 20, minRating: 3.8, minScore: 2.5 },
  smarthome: { tier: 'A', label: '🏠 Smart Home', maxSharePct: 0.05, minDiscount: 15, minRating: 3.8, minScore: 2.5 },

  // ── B-Tier: Niche, low CTR for deal channels ─────────────────────────────
  // Target: ≤8% of daily posts; strict quality gate
  books: { tier: 'B', label: '📚 Books', maxSharePct: 0.03, minDiscount: 40, minRating: 4.0, minScore: 3.5 },
  grocery: { tier: 'B', label: '🛒 Grocery', maxSharePct: 0.03, minDiscount: 25, minRating: 4.0, minScore: 3.5 },
  stationery: { tier: 'B', label: '✏️ Stationery', maxSharePct: 0.01, minDiscount: 40, minRating: 4.2, minScore: 3.5 },
  officesupplies: { tier: 'B', label: '🗂️ Office', maxSharePct: 0.01, minDiscount: 40, minRating: 4.0, minScore: 3.5 },
  babyproducts: { tier: 'B', label: '👶 Baby', maxSharePct: 0.02, minDiscount: 30, minRating: 4.2, minScore: 3.5 },

  // ── C-Tier: Skip unless deal is truly exceptional ────────────────────────
  // Target: ≤2% of daily posts; minimum score 5.0
  caraccessories: { tier: 'C', label: '🚗 Car', maxSharePct: 0.01, minDiscount: 40, minRating: 4.2, minScore: 5.0 },
  industrial: { tier: 'C', label: '🏭 Industrial', maxSharePct: 0.005, minDiscount: 50, minRating: 4.0, minScore: 5.0 },
  petsupplies: { tier: 'C', label: '🐾 Pets', maxSharePct: 0.01, minDiscount: 35, minRating: 4.2, minScore: 5.0 },

  // ── Special / deal pages (inherit tier from product) ─────────────────────
  deals: { tier: 'S', label: '🔥 Deals', maxSharePct: 0.20, minDiscount: 20, minRating: 3.5, minScore: 2.0 },
  greatsale: { tier: 'S', label: '🎉 Great Sale', maxSharePct: 0.20, minDiscount: 20, minRating: 3.5, minScore: 2.0 },
  lightning: { tier: 'S', label: '⚡ Lightning', maxSharePct: 0.15, minDiscount: 30, minRating: 3.5, minScore: 2.0 },
  todaysdeals: { tier: 'S', label: '📅 Today', maxSharePct: 0.20, minDiscount: 20, minRating: 3.5, minScore: 2.0 },
  bestsellers: { tier: 'S', label: '🏆 Bestsellers', maxSharePct: 0.15, minDiscount: 10, minRating: 4.0, minScore: 2.0 },
  newreleases: { tier: 'A', label: '🆕 New Releases', maxSharePct: 0.08, minDiscount: 0, minRating: 4.0, minScore: 2.5 },
  moversshakers: { tier: 'A', label: '📈 Trending', maxSharePct: 0.08, minDiscount: 0, minRating: 4.0, minScore: 2.5 },
  general: { tier: 'A', label: '📦 General', maxSharePct: 0.10, minDiscount: 15, minRating: 3.5, minScore: 2.5 },
};

// ── Maximum items per category per scrape cycle ───────────────────────────────
// Prevents a single category from dominating the analysis queue
export const CATEGORY_SCRAPE_QUOTAS = {
  S: 15,  // Up to 15 items per S-tier category per cycle
  A: 10,  // Up to 10 for A-tier
  B: 3,   // Strict cap for B-tier; quality over quantity
  C: 1,   // Almost never — only truly exceptional deals
};

// ── Minimum price floor (non-grocery) ────────────────────────────────────────
// Items cheaper than this earn negligible commission and clutter the channel
export const MIN_PRICE_INR = 99;
export const MIN_PRICE_GROCERY_INR = 29;

// ── Trending / New Launch Keywords ───────────────────────────────────────────
// Found in product titles or descriptions — strong demand signals
export const TRENDING_KEYWORDS = {
  // New launch indicators (+0.8 score boost)
  newLaunch: [
    '2026', '2025', 'new launch', 'newly launched', 'just launched',
    'latest', 'new model', 'new release', 'new arrival',
    'gen 3', 'gen 4', 'gen 5', '3rd gen', '4th gen', '5th gen',
    'v2', 'v3', 'pro 2', 'plus 2', 'ultra 2',
  ],
  // Bestseller indicators (+0.5 boost)
  bestSeller: [
    "amazon's choice", "amazon choice", "#1 best seller", '#1 bestseller',
    'best seller', 'bestseller', 'top rated', 'editors choice',
  ],
  // Seasonal demand keywords (boost when month matches)
  seasonal: {
    // Summer (Mar-Jun): AC accessories, coolers, water bottles, sunscreen
    summer: ['cooler', 'fan', 'ac', 'air conditioner', 'water bottle', 'sunscreen', 'sunglass'],
    // Monsoon (Jul-Aug): rain gear, umbrellas, skincare
    monsoon: ['umbrella', 'raincoat', 'waterproof', 'moisture'],
    // Festive (Oct-Nov): gifts, lights, home decor, electronics
    festive: ['gift', 'diwali', 'festive', 'decoration', 'lights', 'led'],
    // Winter (Dec-Jan): heaters, thermals, skincare
    winter: ['heater', 'thermal', 'blanket', 'moisturizer', 'lip balm'],
    // Exam season (Jan-Mar, Oct-Nov): stationery, books, electronics
    exams: ['notebook', 'pen', 'calculator', 'study', 'board exam'],
  },
};

// ── Time-of-Day Demand Weights ────────────────────────────────────────────────
// IST hour → category boost / dampener coefficients
// Applied as multipliers on top of base demand score

export function getTimeOfDayWeights() {
  const now = new Date();
  const istHour = new Date(now.getTime() + 5.5 * 60 * 60 * 1000).getUTCHours();

  // Morning commute / breakfast: 7-10 AM
  if (istHour >= 7 && istHour < 10) {
    return {
      boosted: ['grocery', 'kitchen', 'sports', 'books', 'babyproducts'],
      dampened: ['fashion', 'beauty', 'gaming', 'homeimprovement'],
      boostMultiplier: 1.4,
      dampenMultiplier: 0.7,
    };
  }

  // Office hours / work from home: 10 AM - 1 PM
  if (istHour >= 10 && istHour < 13) {
    return {
      boosted: ['electronics', 'laptops', 'headphones', 'officesupplies', 'smarthome'],
      dampened: ['toys', 'babyproducts', 'grocery'],
      boostMultiplier: 1.5,
      dampenMultiplier: 0.7,
    };
  }

  // Lunch break shopping: 1 PM - 3 PM
  if (istHour >= 13 && istHour < 15) {
    return {
      boosted: ['fashion', 'beauty', 'mobiles', 'electronics'],
      dampened: ['officesupplies', 'industrial'],
      boostMultiplier: 1.4,
      dampenMultiplier: 0.6,
    };
  }

  // Evening peak (highest engagement): 5 PM - 9 PM
  if (istHour >= 17 && istHour < 21) {
    return {
      boosted: ['mobiles', 'headphones', 'electronics', 'fashion', 'beauty', 'gaming'],
      dampened: ['grocery', 'babyproducts', 'industrial'],
      boostMultiplier: 1.6,
      dampenMultiplier: 0.5,
    };
  }

  // Night (last chance): 9 PM - 11 PM
  if (istHour >= 21 && istHour < 23) {
    return {
      boosted: ['electronics', 'mobiles', 'books', 'smarthome'],
      dampened: ['grocery', 'kitchen', 'fashion', 'toys'],
      boostMultiplier: 1.2,
      dampenMultiplier: 0.5,
    };
  }

  // Default: no time boost
  return { boosted: [], dampened: [], boostMultiplier: 1.0, dampenMultiplier: 1.0 };
}

// ── Seasonal Context ──────────────────────────────────────────────────────────

export function getSeasonalContext() {
  const now = new Date();
  const month = now.getMonth(); // 0-11
  const day = now.getDate();

  // Active sales windows (major boosts)
  if (month === 0 && day >= 15) return { season: 'republic', boostedCategories: ['electronics', 'mobiles', 'fashion'] };

  // Summer (Mar-Jun) — AC, coolers, fridges, summer fashion
  if (month >= 2 && month <= 5) return {
    season: 'summer',
    boostedCategories: ['electronics', 'fashion', 'beauty', 'sports'],
    weatherBoosted: ['ac', 'cooler', 'fridge', 'refrigerator', 'air conditioner']
  };

  if (month === 6 && day >= 10) return { season: 'prime', boostedCategories: ['mobiles', 'electronics', 'headphones', 'laptops'] };
  if (month === 7) return { season: 'monsoon', boostedCategories: ['kitchen', 'homeimprovement', 'fashion'] };
  if (month >= 9 && month <= 10) return { season: 'festive', boostedCategories: ['electronics', 'mobiles', 'toys', 'fashion', 'beauty'] };

  // Winter (Nov-Feb) — heaters, laptops (WFH season), winter fashion
  if (month === 11 || month <= 1) return {
    season: 'winter',
    boostedCategories: ['electronics', 'fashion', 'mobiles', 'laptops'],
    weatherBoosted: ['heater', 'room heater', 'laptop', 'blanket', 'jacket', 'sweater']
  };

  return { season: 'regular', boostedCategories: [], weatherBoosted: [] };
}

// ── Demand Score Calculator ───────────────────────────────────────────────────
// Returns a score from 0 to 1.5 representing how much demand exists for this deal
// Called from deal-analysis agent as a new scoring dimension

export function calculateDemandScore(deal, categorySaturation = 0) {
  const category = (deal.category || 'general').toLowerCase().replace(/\s+/g, '');
  const tierConfig = DEMAND_TIERS[category] || DEMAND_TIERS.general;
  const tier = tierConfig.tier;
  const price = deal.price || deal.finalPrice || 0;
  const title = (deal.title || '').toLowerCase();

  let score = 0;

  // 1. Base tier score (0-0.6)
  const tierBaseScores = { S: 0.6, A: 0.4, B: 0.15, C: 0.05 };
  score += tierBaseScores[tier] || 0.2;

  // 2. Trending / new launch signals (0-0.8)
  const newLaunchMatch = TRENDING_KEYWORDS.newLaunch.some(kw => title.includes(kw.toLowerCase()));
  const bestSellerMatch = TRENDING_KEYWORDS.bestSeller.some(kw => title.includes(kw.toLowerCase()));

  if (newLaunchMatch) score += 0.5;   // New launch — early adopter demand
  if (bestSellerMatch) score += 0.3;  // Already proven popular

  // New product with high rating = rising star (catches new launches)
  const reviews = deal.reviewCount || 0;
  const rating = deal.rating || 0;
  if (reviews < 500 && reviews > 20 && rating >= 4.3) {
    score += 0.25; // Rising product before viral
  }

  // 3. Seasonal demand signal (0-0.25)
  const seasonal = getSeasonalContext();
  if (seasonal.boostedCategories.includes(category)) {
    score += 0.25;
  }

  if (seasonal.weatherBoosted && seasonal.weatherBoosted.length > 0) {
    const weatherMatch = seasonal.weatherBoosted.some(kw => title.includes(kw.toLowerCase()));
    if (weatherMatch) {
      score += 0.4; // Big boost for seasonal weather items
    }
  }

  // 4. Time-of-day relevance (0-0.2)
  const tod = getTimeOfDayWeights();
  if (tod.boosted.includes(category)) {
    score += 0.2 * (tod.boostMultiplier - 1.0); // Scaled boost
  } else if (tod.dampened.includes(category)) {
    score -= 0.1 * (1.0 - tod.dampenMultiplier); // Scaled dampener
  }

  // 5. Price point attractiveness for impulse buys (0-0.15)
  // ₹99-999 is the Indian impulse buy sweet spot
  if (price >= 99 && price <= 299) score += 0.15;
  else if (price > 299 && price <= 999) score += 0.10;
  else if (price > 999 && price <= 2999) score += 0.05;

  // 6. Category saturation dampener — exponential decay
  // (how many of this category posted in last 6 hours)
  if (categorySaturation >= 3) {
    // 3 posts of same category = 50% demand penalty
    score *= Math.pow(0.7, Math.max(0, categorySaturation - 2));
  }

  // 7. Price floor penalty — negligible commission items
  const priceFloor = category === 'grocery' ? MIN_PRICE_GROCERY_INR : MIN_PRICE_INR;
  if (price > 0 && price < priceFloor) {
    score *= 0.2; // Almost no commission, not worth posting
  }

  return Math.max(0, Math.min(1.5, score));
}

// ── Category Gate Check ───────────────────────────────────────────────────────
// Returns true if a deal meets the minimum bar for its category tier
// Used in deal-analysis to enforce tier-specific thresholds

export function passesCategoryGate(deal, finalScore) {
  // TESTING MODE: bypass category gate to let more deals through
  if (process.env.TESTING_MODE === 'true') return true;

  const category = (deal.category || 'general').toLowerCase().replace(/\s+/g, '');
  const tierConfig = DEMAND_TIERS[category] || DEMAND_TIERS.general;
  const price = deal.price || deal.finalPrice || 0;
  const discount = deal.mrp && deal.price
    ? Math.round((1 - deal.price / deal.mrp) * 100)
    : (deal.discountPct || 0);

  // Price floor check
  const priceFloor = category === 'grocery' ? MIN_PRICE_GROCERY_INR : MIN_PRICE_INR;
  if (price > 0 && price < priceFloor) return false;

  // High-demand electronics/gadgets exception (User requested priority despite higher price/lower discount)
  const isHighDemandTech = ['mobiles', 'electronics', 'laptops', 'headphones', 'smarthome'].includes(category);
  const isHighlyRated = deal.rating && deal.rating >= 4.2 && deal.reviewCount && deal.reviewCount >= 500;
  
  if (isHighDemandTech && isHighlyRated) {
    // Bypass minimum discount and score for highly-rated electronics
    return true; 
  }

  // Minimum score for this tier
  if (finalScore < tierConfig.minScore) return false;

  // Minimum discount for this tier (skip low-discount niche items)
  if (discount < tierConfig.minDiscount && deal.mrp) return false;

  // Minimum rating for this tier
  if (deal.rating && deal.rating < tierConfig.minRating) return false;

  return true;
}

// ── Discovery Quota Check ─────────────────────────────────────────────────────
// Returns the max number of items to forward from a category per scrape cycle

export function getScrapingQuota(category) {
  const cat = (category || 'general').toLowerCase().replace(/\s+/g, '');
  const tierConfig = DEMAND_TIERS[cat] || DEMAND_TIERS.general;
  return CATEGORY_SCRAPE_QUOTAS[tierConfig.tier] || 10;
}

// ── Demand Signal Tagger ──────────────────────────────────────────────────────
// Adds demand metadata to a deal object before analysis queuing

export function tagDemandSignals(deal) {
  const title = (deal.title || '').toLowerCase();
  const price = deal.price || 0;
  const category = (deal.category || 'general').toLowerCase().replace(/\s+/g, '');
  const tierConfig = DEMAND_TIERS[category] || DEMAND_TIERS.general;

  return {
    ...deal,
    _demandMeta: {
      tier: tierConfig.tier,
      isNewLaunch: TRENDING_KEYWORDS.newLaunch.some(kw => title.includes(kw.toLowerCase())),
      isBestSeller: TRENDING_KEYWORDS.bestSeller.some(kw => title.includes(kw.toLowerCase())),
      isRisingStar: (deal.reviewCount || 0) < 500 && (deal.reviewCount || 0) > 20 && (deal.rating || 0) >= 4.3,
      belowPriceFloor: price > 0 && price < (category === 'grocery' ? MIN_PRICE_GROCERY_INR : MIN_PRICE_INR),
      season: getSeasonalContext().season,
    },
  };
}

// ── Weighted Category Picker (for curated lists) ──────────────────────────────
// Returns a weighted random category from the allowed set
// S-tier categories appear 6x more often than B-tier

export function pickWeightedCategory(categories, excludeRecent = []) {
  const tierWeights = { S: 6, A: 3, B: 1, C: 0 }; // C-tier never picked for curated lists

  const weighted = [];
  for (const cat of categories) {
    const normalized = cat.toLowerCase().replace(/\s+/g, '').replace(/&/g, '');

    // Find best matching tier config
    let tierConfig = null;
    for (const [key, config] of Object.entries(DEMAND_TIERS)) {
      if (normalized.includes(key) || key.includes(normalized)) {
        tierConfig = config;
        break;
      }
    }

    const tier = tierConfig?.tier || 'A';
    const weight = tierWeights[tier] || 1;

    // Reduce weight if recently used
    const recentPenalty = excludeRecent.some(r =>
      r.toLowerCase().includes(normalized.slice(0, 6)) ||
      normalized.includes(r.toLowerCase().slice(0, 6))
    ) ? 0.2 : 1.0;

    // Skip C-tier entirely
    if (tier === 'C') continue;

    for (let i = 0; i < Math.round(weight * recentPenalty); i++) {
      weighted.push(cat);
    }
  }

  if (weighted.length === 0) return categories[Math.floor(Math.random() * categories.length)];
  return weighted[Math.floor(Math.random() * weighted.length)];
}

// ── Demand-Weighted Listicle Validation ───────────────────────────────────────
// Returns true if a topic's category is in sufficient demand to proceed
export function isTopicInDemand(topic) {
  const cat = (topic.category || '').toLowerCase().replace(/\s+/g, '').replace(/&/g, '');
  const title = (topic.title || '').toLowerCase();
  const tierConfig = Object.entries(DEMAND_TIERS).find(([key]) =>
    cat.includes(key) || key.includes(cat.slice(0, 5))
  )?.[1] || DEMAND_TIERS.general;

  const seasonal = getSeasonalContext();

  if (seasonal.weatherBoosted && seasonal.weatherBoosted.length > 0) {
    if (seasonal.weatherBoosted.some(kw => title.includes(kw.toLowerCase()))) {
      return true; // Always allow weather-boosted topics
    }
  }

  // B-tier and C-tier topics need seasonal boost to proceed
  if (tierConfig.tier === 'B' || tierConfig.tier === 'C') {
    return seasonal.boostedCategories.some(bc =>
      cat.includes(bc) || bc.includes(cat.slice(0, 5))
    );
  }

  return true;
}
