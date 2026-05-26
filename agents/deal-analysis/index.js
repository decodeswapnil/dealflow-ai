import 'dotenv/config';
import { createLogger } from '../../shared/utils/logger.js';
import { query } from '../../shared/utils/db.js';
import { createQueue, createWorker } from '../../shared/utils/redis.js';
import { getProductHistory, analyzePriceTrend, cachePriceHistory } from '../../shared/utils/keepa-client.js';
import { DealSchema } from '../../shared/types/deal.schema.js';
import { Registry, Counter, Gauge, Histogram } from 'prom-client';
import express from 'express';
import { callAI as sharedCallAI } from '../../shared/utils/ai-client.js';
import {
  calculateDemandScore,
  passesCategoryGate,
  getSeasonalContext,
  DEMAND_TIERS,
} from '../../shared/utils/demand-intelligence.js';

const logger = createLogger('deal-analysis');
const dealQueue = createQueue('deals');
const postQueue = createQueue('posts');

// Prometheus metrics
const register = new Registry();
register.setDefaultLabels({ app: 'deal-analysis' });

const dealsAnalyzedTotal = new Counter({
  name: 'deals_analyzed_total',
  help: 'Total deals analyzed',
  labelNames: ['verdict'],
  registers: [register],
});

const analysisErrorsTotal = new Counter({
  name: 'analysis_errors_total',
  help: 'Total analysis errors',
  labelNames: ['type'],
  registers: [register],
});

const analysisDuration = new Histogram({
  name: 'analysis_duration_seconds',
  help: 'Time spent analyzing deals',
  buckets: [1, 5, 10, 30, 60, 120],
  registers: [register],
});

// Worker status tracking
let currentJobs = 0;
const MAX_CONCURRENT_JOBS = 5;

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
    busy: currentJobs >= MAX_CONCURRENT_JOBS,
    currentJobs,
    maxJobs: MAX_CONCURRENT_JOBS,
  });
});

// Direct analyze endpoint - bypass queue when called directly
metricsApp.post('/direct-analyze', async (req, res) => {
  try {
    const deal = req.body;
    logger.info('Direct analyze request received', { asin: deal.asin });
    const result = await agent.analyzeDeal(deal);
    res.json({ success: true, result });
  } catch (err) {
    logger.error('Direct analyze failed', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

metricsApp.listen(3002, () => {
  logger.info('Metrics server running on port 3002');
});

class DealAnalysisAgent {
  constructor() {
    this.geminiKey = process.env.GEMINI_API_KEY;
    this.ollamaUrl = process.env.OLLAMA_HOST;
    this.stats = {
      totalAnalyzed: 0,
      fakeDiscountsDetected: 0,
      hotDeals: 0,
      errors: 0,
    };
  }

  async init() {
    logger.info('Initializing Deal Analysis Agent with price validation');

    const worker = createWorker('deals', async (job) => {
      currentJobs++;
      try {
        logger.info(`Analyzing deal ${job.data.asin}`);
        return await this.analyzeDeal(job.data);
      } finally {
        currentJobs--;
      }
    }, {
      concurrency: 3,
    });

    worker.on('completed', (job, result) => {
      logger.info(`Analysis complete for ${job.data.asin}`, { score: result?.score, verdict: result?.verdict });
    });

    worker.on('failed', (job, err) => {
      logger.error(`Analysis failed for ${job.data.asin}`, { error: err.message });
    });
  }

  async analyzeDeal(deal) {
    const start = Date.now();
    try {
      this.stats.totalAnalyzed++;

      // ── Pre-flight: price floor check ──────────────────────────────────────
      const price = deal.price || 0;
      const category = (deal.category || 'general').toLowerCase().replace(/\s+/g, '');
      const priceFloor = category === 'grocery' ? 29 : 99;
      if (price > 0 && price < priceFloor) {
        logger.info(`Skipping ${deal.asin} — below price floor (₹${price} < ₹${priceFloor})`);
        dealsAnalyzedTotal.inc({ verdict: 'skip' });
        return { asin: deal.asin, score: 0, verdict: 'skip', reason: 'below_price_floor', analyzedAt: new Date().toISOString() };
      }

      // ── Get category saturation (posts in last 6 hours) ──────────────────
      let categorySaturation = 0;
      try {
        const satResult = await query(
          `SELECT COUNT(*) as cnt FROM posted_deals
           WHERE category = $1 AND time > NOW() - INTERVAL '6 hours'`,
          [deal.category || 'general']
        );
        categorySaturation = parseInt(satResult.rows[0]?.cnt || '0', 10);
      } catch (_e) { /* ignore — DB may not have category column yet */ }

      // ── Get historical price data from Keepa ──────────────────────────────
      const keepaData = await getProductHistory(deal.asin);
      if (keepaData) {
        await cachePriceHistory(deal.asin, keepaData);
      }

      // Get cached price stats
      const priceStats = await this.getPriceStats(deal.asin);

      // Detect fake discounts
      const fakeDiscountAnalysis = detectFakeDiscount(
        deal.price,
        deal.mrp,
        keepaData?.priceHistory || priceStats.priceHistory
      );

      if (fakeDiscountAnalysis.isFake) {
        logger.warn(`Fake discount detected for ${deal.asin}`, {
          reasons: fakeDiscountAnalysis.reasons,
          confidence: fakeDiscountAnalysis.confidence,
        });
        this.stats.fakeDiscountsDetected++;
      }

      // Analyze price trend
      const priceTrend = analyzePriceTrend(keepaData);

      // Calculate base score with price validation (demand score wired in)
      const baseScore = this.calculateBaseScore(deal, priceStats, priceTrend, categorySaturation);

      // AI enrichment (optional, for nuanced understanding)
      let aiResult = { boost: 0, factors: { discount: 0, historical: 0, rating: 0, social: 0 } };
      if (this.geminiKey || process.env.OPENROUTER_API_KEY || this.ollamaUrl || process.env.REPLICATE_API_KEY) {
        try {
          aiResult = await this.aiAnalyze(deal, priceStats, baseScore, fakeDiscountAnalysis, priceTrend, categorySaturation);
        } catch (err) {
          logger.warn('AI analysis failed, using base score', { error: err.message });
        }
      }

      const finalScore = Math.min(10, Math.max(0, baseScore + aiResult.boost));

      // ── Category gate: tier-specific minimum thresholds ──────────────────
      // This is the core anti-spam guard — B/C tier deals need much higher
      // scores to proceed; books need score ≥ 5.5, grocery ≥ 5.0, etc.
      if (!passesCategoryGate(deal, finalScore)) {
        logger.info(`Category gate blocked ${deal.asin}`, {
          category: deal.category,
          finalScore,
          reason: 'below_tier_threshold',
        });
        dealsAnalyzedTotal.inc({ verdict: 'skip' });
        return {
          asin: deal.asin,
          score: finalScore,
          verdict: 'skip',
          reason: 'category_gate',
          analyzedAt: new Date().toISOString(),
        };
      }

      // ── Determine verdict based on FINAL score (after AI boost) ──────────
      // GROWTH-PHASE THRESHOLDS: Content velocity matters for channel growth
      // TESTING MODE: Lower thresholds to let more deals through
      const testingMode = process.env.TESTING_MODE === 'true';
      let verdict;
      if (finalScore >= (testingMode ? 2.5 : 4.5)) {
        verdict = 'hot';       // Genuinely great deals - post immediately
      } else if (finalScore >= (testingMode ? 1.5 : 2.5)) {
        verdict = 'good';      // Solid value deals - post with slight delay
      } else if (finalScore >= (testingMode ? 1.0 : 1.5)) {
        verdict = 'average';   // Decent - include in digest compilations only
      } else {
        verdict = 'skip';      // Truly bad or fake deals - ignore
      }

      // Auto-skip fake discounts unless score is very high (genuine exception)
      if (fakeDiscountAnalysis.isFake && finalScore < 8.5) {
        verdict = 'skip';
        logger.info(`Auto-skipping fake discount for ${deal.asin} despite score ${finalScore}`);
      }

      // Category saturation hard cap: if 8+ of same category in 6h, cap at 'average'
      if (categorySaturation >= 8 && verdict === 'hot') {
        verdict = 'good';
        logger.info(`Category saturated (${categorySaturation} posts) — downgraded hot→good`, { asin: deal.asin, category: deal.category });
      } else if (categorySaturation >= 12 && (verdict === 'hot' || verdict === 'good')) {
        verdict = 'average';
        logger.info(`Category oversaturated (${categorySaturation} posts) — downgraded to average`, { asin: deal.asin, category: deal.category });
      }

      // Store analysis result
      const result = {
        asin: deal.asin,
        score: finalScore,
        verdict,
        baseScore,
        aiBoost: aiResult.boost,
        fakeDiscount: fakeDiscountAnalysis,
        priceTrend,
        categorySaturation,
        demandMeta: deal._demandMeta || null,
        tags: aiResult.tags,
        analyzedAt: new Date().toISOString(),
      };

      await this.storeAnalysis(deal, result);

      // Queue for posting if worthy
      if (verdict === 'hot' || verdict === 'good') {
        // Ensure deal has all required fields before queuing
        const enrichedDeal = {
          ...deal,
          category: deal.category || 'general',
          discountPct: deal.discountPct || (deal.mrp && deal.price ? Math.round((1 - deal.price / deal.mrp) * 100) : 0),
          finalPrice: deal.finalPrice || deal.price,
        };
        
        /*
        await postQueue.add('post-deal', {
          deal: enrichedDeal,
          score: {
            score: finalScore,
            verdict,
          },
        }, {
          priority: verdict === 'hot' ? 1 : 2,
          delay: verdict === 'good' ? 3 * 60 * 1000 : 0, // Delay good deals 3 min to prioritize hot
          attempts: 1, // No retries — duplicates are worse than lost posts
        });
        */
        this.stats.hotDeals++;
        logger.info(`Saved ${verdict} deal for burst posting`, { 
          asin: deal.asin, 
          score: finalScore, 
          category: deal.category, 
          saturation: categorySaturation,
          title: deal.title?.substring(0, 50),
          price: deal.price,
          mrp: deal.mrp
        });
      } else if (verdict === 'average') {
        // Average deals are stored for digest but not individually posted
        logger.info(`Stored average deal for digest only`, { asin: deal.asin, score: finalScore });
      }

      dealsAnalyzedTotal.inc({ verdict });
      analysisDuration.observe((Date.now() - start) / 1000);

      return result;
    } catch (err) {
      analysisErrorsTotal.inc({ type: 'general' });
      this.stats.errors++;
      logger.error(`Analysis failed for ${deal.asin}`, { error: err.message });
      throw err;
    }
  }

  async storeAnalysis(deal, result) {
    try {
      await query(
        `INSERT INTO products (asin, title, category, price, mrp, discount_pct, rating, review_count, image_url, product_url, affiliate_url, deal_score, verdict, semantic_tags, bank_offers, last_updated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
         ON CONFLICT (asin) DO UPDATE SET
           title = EXCLUDED.title,
           category = EXCLUDED.category,
           price = EXCLUDED.price,
           mrp = EXCLUDED.mrp,
           discount_pct = EXCLUDED.discount_pct,
           rating = EXCLUDED.rating,
           review_count = EXCLUDED.review_count,
           image_url = EXCLUDED.image_url,
           product_url = EXCLUDED.product_url,
           affiliate_url = EXCLUDED.affiliate_url,
           deal_score = EXCLUDED.deal_score,
           verdict = EXCLUDED.verdict,
           semantic_tags = COALESCE(EXCLUDED.semantic_tags, products.semantic_tags),
           bank_offers = COALESCE(EXCLUDED.bank_offers, products.bank_offers),
           last_updated = NOW()`,
        [
          deal.asin,
          deal.title,
          deal.category || null,
          deal.price,
          deal.mrp || null,
          deal.mrp ? Math.round((1 - deal.price / deal.mrp) * 100) : null,
          deal.rating || null,
          deal.reviewCount || null,
          deal.imageUrl || null,
          deal.productUrl || null,
          deal.affiliateUrl || null,
          result.score,
          result.verdict,
          result.tags || null,
          deal.bankOffers || null,
        ]
      );

      // Store price history
      await query(
        `INSERT INTO price_history (asin, price, mrp, discount_pct, time)
         VALUES ($1, $2, $3, $4, NOW())`,
        [
          deal.asin,
          deal.price,
          deal.mrp || null,
          deal.mrp ? Math.round((1 - deal.price / deal.mrp) * 100) : null,
        ]
      );
    } catch (err) {
      logger.error('Failed to store analysis', { asin: deal.asin, error: err.message });
    }
  }

  async getPriceStats(asin) {
    try {
      const result = await query(
        `SELECT price, mrp, discount_pct, time 
         FROM price_history 
         WHERE asin = $1 
         ORDER BY time DESC 
         LIMIT 30`,
        [asin]
      );

      if (result.rows.length === 0) {
        return { priceHistory: [], avgPrice: null, minPrice: null, maxPrice: null };
      }

      const prices = result.rows.map(r => r.price).filter(Boolean);
      const discountPcts = result.rows.map(r => r.discount_pct).filter(Boolean);

      return {
        priceHistory: result.rows,
        avgPrice: prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
        minPrice: prices.length > 0 ? Math.min(...prices) : null,
        maxPrice: prices.length > 0 ? Math.max(...prices) : null,
        avgDiscount: discountPcts.length > 0 ? discountPcts.reduce((a, b) => a + b, 0) / discountPcts.length : null,
      };
    } catch (err) {
      logger.error('Failed to get price stats', { asin, error: err.message });
      return { priceHistory: [], avgPrice: null, minPrice: null, maxPrice: null };
    }
  }

  calculateBaseScore(deal, priceStats, priceTrend, categorySaturation = 0) {
    let score = 0;

    // ── Discount percentage (26% weight) ─────────────────────────────────────
    const discountPct = deal.mrp ? ((deal.mrp - deal.price) / deal.mrp) * 100 : 0;
    if (discountPct >= 70) score += 2.6;        // Exceptional discount
    else if (discountPct >= 50) score += 1.9;   // Great discount
    else if (discountPct >= 35) score += 1.1;   // Good discount
    else if (discountPct >= 20) score += 0.6;   // Decent discount
    else if (discountPct >= 10) score += 0.22;  // Minor discount

    // ── Historical price comparison (19% weight) ─────────────────────────────
    if (priceStats.minPrice && deal.price <= priceStats.minPrice * 1.05) {
      score += 1.52; // Near all-time low (within 5%)
    } else if (priceStats.minPrice && deal.price <= priceStats.minPrice * 1.15) {
      score += 0.95; // Within 15% of all-time low
    } else if (priceStats.avgPrice && deal.price <= priceStats.avgPrice * 0.85) {
      score += 0.6;  // Significantly below average
    } else if (priceStats.avgPrice && deal.price <= priceStats.avgPrice) {
      score += 0.2;  // Below average
    }

    // Price trend bonus/penalty
    if (priceTrend?.trend === 'decreasing') {
      score += 0.6; // Price trending down — good time to buy
    } else if (priceTrend?.trend === 'increasing') {
      score -= 0.4; // Price trending up — not ideal
    }

    // ── Trust score: rating × review count (30% combined weight) ──────────────
    // Core principle: 3.9★ with 10k reviews > 4.8★ with 5 reviews.
    // Rating alone means nothing without social proof to back it up.
    const reviewCount = deal.reviewCount || 0;
    const rating = deal.rating || 0;

    // Review volume multiplier — determines how much the rating actually matters
    let reviewMultiplier;
    if (reviewCount >= 10000) reviewMultiplier = 1.0;       // Full trust
    else if (reviewCount >= 5000) reviewMultiplier = 0.9;   // Very high trust
    else if (reviewCount >= 1000) reviewMultiplier = 0.75;  // Good trust
    else if (reviewCount >= 200) reviewMultiplier = 0.55;  // Moderate trust
    else if (reviewCount >= 50) reviewMultiplier = 0.35;  // Some trust
    else if (reviewCount >= 10) reviewMultiplier = 0.15;  // Low trust
    else reviewMultiplier = 0.0;   // No trust — rating is meaningless

    // Raw rating score (before modulation)
    let rawRatingScore = 0;
    if (rating >= 4.5) rawRatingScore = 1.5;
    else if (rating >= 4.0) rawRatingScore = 1.2;
    else if (rating >= 3.5) rawRatingScore = 0.8;
    else if (rating >= 3.0) rawRatingScore = 0.3;
    else if (rating > 0 && rating < 3.0) rawRatingScore = -0.5; // Poor — penalty

    // Modulated rating: high rating with no reviews contributes almost nothing
    score += rawRatingScore * reviewMultiplier;

    // Direct review volume bonus (on top of the modulated rating)
    if (reviewCount >= 10000) score += 0.8;       // Viral — massive social proof
    else if (reviewCount >= 5000) score += 0.6;   // Very popular
    else if (reviewCount >= 1000) score += 0.4;   // Well-validated
    else if (reviewCount >= 200) score += 0.2;   // Decent proof

    // Penalty for products with no/very few reviews — untrustworthy
    if (reviewCount < 10) score -= 0.3;

    // MRP validation — if MRP seems inflated
    if (priceStats.avgPrice && deal.mrp && deal.mrp > priceStats.avgPrice * 2.0 && discountPct > 60) {
      score -= 0.4;
    }

    // ── Revenue Dimension (10% weight) ──────────────────────────────────────
    const revenueScore = this.calculateRevenueScore(deal, priceStats);
    score += revenueScore;

    // ── Demand Dimension (15% weight) — NEW ─────────────────────────────────
    // Encodes what Indian consumers actually want to buy right now
    const demandScore = calculateDemandScore(deal, categorySaturation);
    // Demand score 0-1.5 maps to 0-1.5 points (15% of max 10-pt score)
    score += demandScore;

    // ── Bestseller Source Bonus ──────────────────────────────────────────────
    // Products from bestseller/trending sources are already Amazon-validated
    // for demand, so add a bonus (+1.5) to compensate for missing Keepa data
    const bestsellerSources = [
      'bestsellers', 'newreleases', 'moversshakers', 'electronics',
      'mobiles', 'kitchen', 'fashion', 'beauty', 'headphones', 'laptops',
      'appliances', 'deals', 'greatsale', 'lightning', 'todaysdeals',
    ];
    const categoryLower = (deal.category || '').toLowerCase().replace(/\s+/g, '');
    if (bestsellerSources.includes(categoryLower)) {
      score += 1.5; // These products are proven sellers on Amazon
    }

    // ── Gadgets & High Rating Priority (NEW) ──────────────────────────────────
    // "even if price is higher, if it has higher ratings means demand is higher, post those, prioritise gadgets and electronic stuffs"
    const isGadgetOrElectronic = ['mobiles', 'electronics', 'laptops', 'headphones', 'smarthome'].includes(categoryLower);
    
    if (isGadgetOrElectronic && rating >= 4.2 && reviewCount >= 500) {
      // Strong bonus to offset any discount or high-price penalties
      score += 2.0; 
    } else if (rating >= 4.4 && reviewCount >= 1000) {
      // General high-rating priority across other categories
      score += 1.2;
    }

    // ── No-Keepa Compensation Bonus ──────────────────────────────────────────
    // Without Keepa data, the discount + historical price dimensions
    // (4.72 out of 10 max points) are permanently unavailable.
    // This bonus partially compensates for that missing dimension.
    if (!priceStats.avgPrice && !priceStats.priceHistory?.length) {
      score += 0.8; // Partial compensation for missing Keepa dimension
    }

    // Ensure score doesn't go below 0
    return Math.max(0, score);
  }

  /**
   * Revenue-Optimized Scoring
   * 5th dimension that weights deals by affiliate revenue potential
   * - Product category commission rate tier (15% of revenue score)
   * - Price point conversion probability (10% of revenue score)
   * - Historical CTR by category (10% of revenue score)
   * - Seasonal/promotional event multiplier (5% of revenue score)
   */
  calculateRevenueScore(deal, priceStats) {
    let revenueScore = 0;
    const category = (deal.category || 'general').toLowerCase();
    const price = deal.price || deal.finalPrice || 0;

    // 1. Commission Rate Tier (up to 0.6 points)
    const commissionTiers = {
      electronics: 0.4,      // 4% — high volume compensates
      mobiles: 0.5,          // 5% — very high volume
      laptops: 0.5,          // 5% — high ticket
      headphones: 0.5,       // 5% — good volume
      kitchen: 0.6,          // 6% — solid category
      homeimprovement: 0.6,  // 6% — growing category
      sports: 0.6,           // 6% — fitness trend
      fashion: 0.7,          // 7% — strong commission
      beauty: 0.7,           // 7% — strong commission
      toys: 0.6,             // 6% — gift season spikes
      books: 0.5,            // 5% — consistent
      grocery: 0.2,          // 2% — low margin but volume
      deals: 0.4,            // 4% — mixed
      greatsale: 0.5,        // 5% — mixed
      lightning: 0.5,        // 5% — mixed
      todaysdeals: 0.5,      // 5% — mixed
      bestsellers: 0.5,      // 5% — proven sellers
    };
    const commissionRate = commissionTiers[category] || 0.4;
    revenueScore += commissionRate; // up to 0.7

    // 2. Price Point Conversion Probability (up to 0.4 points)
    // Sweet spot: ₹299-₹1999 — impulse buy range for Indian consumers
    if (price >= 99 && price <= 299) {
      revenueScore += 0.4;  // Strong impulse conversion
    } else if (price > 299 && price <= 999) {
      revenueScore += 0.35; // Good conversion
    } else if (price > 999 && price <= 1999) {
      revenueScore += 0.25; // Moderate conversion
    } else if (price > 1999 && price <= 4999) {
      revenueScore += 0.15; // Considered purchase
    } else if (price > 4999) {
      revenueScore += 0.05; // Low conversion but high commission per sale
    }

    // 3. Historical CTR by Category (up to 0.4 points)
    // Based on typical Telegram affiliate CTR patterns for Indian audiences
    const ctrTiers = {
      electronics: 0.35,
      mobiles: 0.4,
      laptops: 0.35,
      headphones: 0.3,
      kitchen: 0.3,
      homeimprovement: 0.25,
      sports: 0.25,
      fashion: 0.35,
      beauty: 0.3,
      toys: 0.25,
      books: 0.2,
      grocery: 0.15,
      deals: 0.3,
      greatsale: 0.35,
      lightning: 0.4,
      todaysdeals: 0.35,
      bestsellers: 0.35,
    };
    revenueScore += ctrTiers[category] || 0.25;

    // 4. Seasonal/Promotional Event Multiplier (up to 0.2 points)
    const now = new Date();
    const month = now.getMonth(); // 0-11
    const day = now.getDate();
    const saleCalendar = {
      republic: month === 0 && day >= 15,      // Republic Day sale
      summer: month >= 2 && month <= 5,        // Summer months
      prime: month === 6 && day >= 10,         // Prime Day
      independence: month === 7 && day >= 10,  // Independence Day
      festive: month >= 9 && month <= 10,      // Festive season
      yearend: month === 11,                  // Year-end sale
    };
    const isSalePeriod = Object.values(saleCalendar).some(v => v);
    if (isSalePeriod) {
      revenueScore += 0.2; // Boost during sales — higher intent
    }

    // 5. Repeat-post dampener — avoid over-posting same ASIN
    if (priceStats.postCount && priceStats.postCount >= 3) {
      revenueScore -= 0.3; // Penalize if posted 3+ times recently
    }

    return Math.max(0, Math.min(2.5, revenueScore)); // Cap at 2.5 (12% of max 10-point score)
  }

  // ── AI call — shared provider chain (Gemini → Replicate → OpenRouter → Ollama) ──
  async callAIWithFallback(prompt) {
    return sharedCallAI(prompt, { maxTokens: 256, temperature: 0.3 });
  }

  async aiAnalyze(deal, stats, baseScore, fakeDiscountAnalysis, priceTrend, categorySaturation = 0) {
    if (!this.geminiKey && !process.env.OPENROUTER_API_KEY && !this.ollamaUrl && !process.env.REPLICATE_API_KEY) {
      return { boost: 0, factors: { discount: 0, historical: 0, rating: 0, social: 0 } };
    }

    try {
      // Quick heuristic check: if base score is already very low, skip AI to save cost
      // Quick heuristic check: if base score is already very low, skip AI to save cost
      if (baseScore < 1.5) {
        return { boost: 0, factors: { discount: 0, historical: 0, rating: 0, social: 0 }, tags: null };
      }

      // Build demand context for AI
      const seasonal = getSeasonalContext();
      const tierConfig = DEMAND_TIERS[(deal.category || 'general').toLowerCase().replace(/\s+/g, '')] || DEMAND_TIERS.general;
      const demandContext = [
        `Category Tier: ${tierConfig.tier} (${tierConfig.label})`,
        `Season: ${seasonal.season}`,
        seasonal.boostedCategories.includes((deal.category || '').toLowerCase()) ? '📈 This category is in seasonal demand' : '',
        categorySaturation > 0 ? `Category saturation: ${categorySaturation} similar posts in last 6h` : '',
        deal._demandMeta?.isNewLaunch ? '🆕 New launch product' : '',
        deal._demandMeta?.isBestSeller ? '🏆 Best seller indicator in title' : '',
        deal._demandMeta?.isRisingStar ? '⭐ Rising product (high rating, low reviews)' : '',
      ].filter(Boolean).join('\n');

      const scorePrompt = `You are a deal quality assessor for DealDecode India.
Evaluate this product deal and respond ONLY with a number between -1.0 and +1.0 representing your confidence that this is a genuinely good deal.

Product: ${deal.title}
Price: ₹${deal.price}
${deal.mrp ? `MRP: ₹${deal.mrp} (${Math.round((deal.mrp - deal.price) / deal.mrp * 100)}% off)` : ''}
${deal.rating ? `Rating: ${deal.rating}/5` : ''}
${deal.reviewCount ? `Reviews: ${deal.reviewCount}` : ''}
${stats.minPrice ? `Historical Low: ₹${Math.round(stats.minPrice)}` : ''}
${stats.avgPrice ? `Average Price: ₹${Math.round(stats.avgPrice)}` : ''}
${priceTrend?.trend ? `Price Trend: ${priceTrend.trend}` : ''}
${fakeDiscountAnalysis?.isFake ? '⚠️ Potential fake discount detected' : ''}

Demand Context:
${demandContext}

Scoring guidelines:
- +1.0: Exceptional deal (rare, must-buy, lowest ever or near-lowest price on a popular product)
- +0.5: Good deal (solid discount on a well-reviewed product with high demand)
- 0.0: Average (nothing special)
- -0.5: Mediocre (small discount, unpopular product, low-demand category, or questionable value)
- -1.0: Bad deal (fake discount, poor reviews, overpriced, or very low demand category like books/stationery with no real value)

Consider: Is this actually useful to most Indian subscribers? Is the brand reputable? Is the discount real? Is this a product people are currently looking for?

Respond with ONLY the number, no explanation.`;

      const tagsPrompt = `Generate a single line of space-separated semantic keywords for this product so users can easily find it via search.
Product: ${deal.title}
Category: ${deal.category || 'General'}

INCLUDE:
- Broad category (e.g., smartphone, appliance)
- Synonyms (e.g., earbuds, tws, airdopes)
- Key features/specs (e.g., 5g, 128gb, 8gb ram, amoled, wireless, fast charging)

Respond with ONLY the space-separated string of words, no explanation, no bullet points, no JSON, no punctuation.`;

      const [scoreResult, tagsResult] = await Promise.all([
        this.callAIWithFallback(scorePrompt),
        this.callAIWithFallback(tagsPrompt)
      ]);

      let boost = 0;
      if (scoreResult.text) {
        const match = scoreResult.text.match(/-?\d+\.?\d*/);
        if (match) boost = parseFloat(match[0]);
      }

      let tags = null;
      if (tagsResult.text) {
        // Clean up any weird formatting the AI might still output
        tags = tagsResult.text.replace(/[\[\]{}":,]/g, '').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        if (tags.length < 3) tags = null; // Ignore if empty or too short
      }

      const clampedBoost = Math.max(-1.0, Math.min(1.0, boost));

      logger.info(`AI analysis complete`, {
        asin: deal.asin,
        baseScore,
        aiBoost: clampedBoost,
        source: aiResult.source,
        cost: aiResult.cost,
      });

      return {
        boost: clampedBoost,
        factors: { discount: 0, historical: 0, rating: 0, social: 0 },
        tags: tags
      };
    } catch (err) {
      logger.warn('AI analysis error', { asin: deal.asin, error: err.message });
      return { boost: 0, factors: { discount: 0, historical: 0, rating: 0, social: 0 }, tags: null };
    }
  }
}

// Fake discount detection
function detectFakeDiscount(currentPrice, mrp, priceHistory) {
  if (!mrp || !currentPrice) {
    return { isFake: false, reasons: [], confidence: 0 };
  }

  const reasons = [];
  let confidence = 0;

  // Check 1: MRP never actually charged (current price is "discounted" but same as historical)
  if (priceHistory && priceHistory.length > 0) {
    const recentPrices = priceHistory.slice(0, 10).map(p => p.price);
    const avgRecent = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;

    // If current "discounted" price is same as historical average, MRP is likely fake
    if (Math.abs(currentPrice - avgRecent) < currentPrice * 0.05) {
      reasons.push('Price same as historical average despite MRP claim');
      confidence += 0.3;
    }

    // Check if MRP was ever actually the selling price
    const everSoldAtMrp = priceHistory.some(p => p.price >= mrp * 0.98);
    if (!everSoldAtMrp && priceHistory.length > 5) {
      reasons.push('Product never sold at claimed MRP');
      confidence += 0.4;
    }
  }

  // Check 2: Discount percentage suspicious (always exactly X% off)
  const discountPct = ((mrp - currentPrice) / mrp) * 100;
  if (discountPct > 80) {
    reasons.push('Unrealistic discount percentage (>80%)');
    confidence += 0.2;
  }

  // Check 3: Round number pricing (₹999 vs ₹1499 = exactly 33.3% off)
  const isRoundDiscount = Math.abs(discountPct - Math.round(discountPct)) < 0.5;
  if (isRoundDiscount && discountPct > 50) {
    reasons.push('Suspiciously round discount percentage');
    confidence += 0.1;
  }

  return {
    isFake: confidence >= 0.5,
    reasons,
    confidence: Math.min(1, confidence),
  };
}

// Start agent
const agent = new DealAnalysisAgent();
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
agent.init().catch(err => {
  logger.error('Failed to start', err);
  process.exit(1);
});
