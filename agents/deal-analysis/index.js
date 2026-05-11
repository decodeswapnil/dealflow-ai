import 'dotenv/config';
import { createLogger } from '../../shared/utils/logger.js';
import { query } from '../../shared/utils/db.js';
import { redis, createQueue } from '../../shared/utils/redis.js';
import { DealScoreSchema } from '../../shared/types/deal.schema.js';
import { Worker } from 'bullmq';
import axios from 'axios';

const logger = createLogger('deal-analysis');
const postQueue = createQueue('posts');

class DealAnalysisAgent {
  constructor() {
    this.geminiKey = process.env.GEMINI_API_KEY;
    this.ollamaUrl = process.env.OLLAMA_HOST;
  }

  async init() {
    logger.info('Initializing Deal Analysis Agent');
    
    const worker = new Worker('deals', async (job) => {
      logger.info(`Analyzing deal ${job.data.asin}`);
      return this.analyzeDeal(job.data);
    }, {
      connection: redis.options,
      concurrency: 3,
    });

    worker.on('completed', (job, result) => {
      logger.info(`Analysis complete for ${job.data.asin}`, { score: result?.score });
    });

    worker.on('failed', (job, err) => {
      logger.error(`Analysis failed for ${job.data.asin}`, { error: err.message });
    });
  }

  async analyzeDeal(deal) {
    try {
      // Get historical price data
      const priceStats = await this.getPriceStats(deal.asin);
      
      // Calculate base score
      const baseScore = this.calculateBaseScore(deal, priceStats);
      
      // AI-enhanced analysis
      const aiAnalysis = await this.aiAnalyze(deal, priceStats, baseScore);
      
      const score = DealScoreSchema.parse({
        asin: deal.asin,
        score: Math.round((baseScore + aiAnalysis.boost) * 10) / 10,
        factors: {
          discountWeight: aiAnalysis.factors.discount,
          historicalWeight: aiAnalysis.factors.historical,
          ratingWeight: aiAnalysis.factors.rating,
          socialWeight: aiAnalysis.factors.social,
        },
        verdict: this.getVerdict(baseScore + aiAnalysis.boost),
      });

      // Store in DB
      await this.storeAnalysis(deal, score, priceStats);

      // If good enough, queue for posting
      if (score.verdict === 'hot' || score.verdict === 'good') {
        await postQueue.add('create-post', { deal, score }, {
          priority: score.verdict === 'hot' ? 1 : 2,
        });
      }

      return score;
    } catch (err) {
      logger.error('Analysis error', { asin: deal.asin, error: err.message });
      throw err;
    }
  }

  async getPriceStats(asin) {
    const result = await query(`
      SELECT 
        MIN(price) as all_time_low,
        MAX(price) as all_time_high,
        AVG(price) as avg_price,
        COUNT(*) as observations,
        (SELECT price FROM price_history WHERE asin = $1 ORDER BY time DESC LIMIT 1) as current_price
      FROM price_history 
      WHERE asin = $1
    `, [asin]);

    const row = result.rows[0];
    return {
      allTimeLow: parseFloat(row.all_time_low) || null,
      allTimeHigh: parseFloat(row.all_time_high) || null,
      avgPrice: parseFloat(row.avg_price) || null,
      observations: parseInt(row.observations) || 0,
      currentPrice: parseFloat(row.current_price) || null,
    };
  }

  calculateBaseScore(deal, stats) {
    let score = 0;
    const discountPct = deal.mrp && deal.mrp > deal.price 
      ? ((deal.mrp - deal.price) / deal.mrp) * 100 
      : 0;

    // Discount (40%)
    if (discountPct >= 70) score += 4;
    else if (discountPct >= 50) score += 3.5;
    else if (discountPct >= 40) score += 3;
    else if (discountPct >= 30) score += 2;
    else if (discountPct >= 20) score += 1;

    // Historical comparison (30%)
    if (stats.allTimeLow && stats.observations > 1) {
      const pctAboveLow = ((deal.price - stats.allTimeLow) / stats.allTimeLow) * 100;
      if (pctAboveLow <= 0) score += 3;
      else if (pctAboveLow <= 5) score += 2.5;
      else if (pctAboveLow <= 10) score += 2;
      else if (pctAboveLow <= 20) score += 1;
    } else if (discountPct >= 40) {
      score += 2;
    }

    // Rating (15%)
    if (deal.rating >= 4.5) score += 1.5;
    else if (deal.rating >= 4.0) score += 1;
    else if (deal.rating >= 3.5) score += 0.5;

    // Social proof (15%)
    if (deal.reviewCount >= 5000) score += 1.5;
    else if (deal.reviewCount >= 1000) score += 1;
    else if (deal.reviewCount >= 200) score += 0.5;

    return score;
  }

  async callAIWithFallback(prompt) {
    // Cost-optimized routing: Gemini primary → Gemini backup → OpenRouter fallback
    const geminiKeys = [
      process.env.GEMINI_API_KEY,
      process.env.GEMINI_FALLBACK_KEY
    ].filter(Boolean);

    // Try Gemini first (cheapest)
    const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    for (const key of geminiKeys) {
      try {
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${key}`,
          {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 256 },
          },
          { timeout: 12000 }
        );
        const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return { text, source: 'gemini', cost: 'low' };
      } catch (e) {
        logger.warn(`Gemini call failed with key ${key.slice(0, 10)}...: ${e.message}`);
      }
    }

    // OpenRouter fallback (more expensive but reliable)
    if (process.env.OPENROUTER_API_KEY) {
      try {
        const openrouterModel = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
        const res = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: openrouterModel,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 256,
            temperature: 0.3,
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
              'HTTP-Referer': 'https://affiliate-platform.local',
              'X-Title': 'Deal Analysis',
            },
            timeout: 15000,
          }
        );
        const text = res.data?.choices?.[0]?.message?.content;
        if (text) return { text, source: 'openrouter', cost: 'medium' };
      } catch (e) {
        logger.warn(`OpenRouter fallback failed: ${e.message}`);
      }
    }

    return { text: null, source: 'none', cost: 'zero' };
  }

  async aiAnalyze(deal, stats, baseScore) {
    if (!this.geminiKey && !process.env.OPENROUTER_API_KEY) {
      return { boost: 0, factors: { discount: 0, historical: 0, rating: 0, social: 0 } };
    }

    try {
      const prompt = this.buildAnalysisPrompt(deal, stats, baseScore);
      const aiResult = await this.callAIWithFallback(prompt);

      if (!aiResult.text) {
        logger.info('All AI services exhausted, using base score only');
        return { boost: 0, factors: { discount: 0, historical: 0, rating: 0, social: 0 } };
      }

      logger.info(`AI analysis from ${aiResult.source} (${aiResult.cost} cost)`);
      return this.parseAIResponse(aiResult.text);
    } catch (err) {
      logger.warn('AI analysis failed, using base score', { error: err.message });
      return { boost: 0, factors: { discount: 0, historical: 0, rating: 0, social: 0 } };
    }
  }

  buildAnalysisPrompt(deal, stats, baseScore) {
    return `Analyze this Amazon India deal and return JSON with fields: boost (number -0.5 to 1.0), factors (object with discount, historical, rating, social scores 0-1).

Product: ${deal.title}
Price: ₹${deal.price}
MRP: ₹${deal.mrp || 'N/A'}
Rating: ${deal.rating || 'N/A'}/5 (${deal.reviewCount || 0} reviews)
Historical Low: ₹${stats.allTimeLow || 'N/A'}
Historical Avg: ₹${stats.avgPrice || 'N/A'}
Observations: ${stats.observations}
Base Score: ${baseScore}/10

Consider: Is this a genuine deal? Would it go viral? Is the discount real or inflated MRP?`;
  }

  parseAIResponse(text) {
    try {
      const json = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
      return {
        boost: Math.max(-0.5, Math.min(1.0, json.boost || 0)),
        factors: json.factors || {},
      };
    } catch {
      return { boost: 0, factors: {} };
    }
  }

  getVerdict(score) {
    if (score >= 7) return 'hot';
    if (score >= 5) return 'good';
    if (score >= 3) return 'average';
    return 'skip';
  }

  async storeAnalysis(deal, score, stats) {
    await query(`
      INSERT INTO price_history (time, asin, price, mrp, discount_pct, source)
      VALUES (NOW(), $1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING
    `, [deal.asin, deal.price, deal.mrp, 
        deal.mrp ? ((deal.mrp - deal.price) / deal.mrp * 100) : 0, 
        deal.source]);

    await query(`
      INSERT INTO products (asin, title, category, image_url, product_url, rating, review_count, last_updated)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (asin) DO UPDATE SET
        title = EXCLUDED.title,
        category = COALESCE(EXCLUDED.category, products.category),
        image_url = COALESCE(EXCLUDED.image_url, products.image_url),
        rating = COALESCE(EXCLUDED.rating, products.rating),
        review_count = COALESCE(EXCLUDED.review_count, products.review_count),
        last_updated = NOW()
    `, [deal.asin, deal.title, deal.category, deal.imageUrl, deal.productUrl, 
        deal.rating, deal.reviewCount]);
  }
}

const agent = new DealAnalysisAgent();
agent.init().catch(err => {
  logger.error('Failed to start', err);
  process.exit(1);
});