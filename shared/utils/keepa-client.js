import { createLogger } from './logger.js';
import { query } from './db.js';

const logger = createLogger('keepa-client');

const KEEPA_API_BASE = 'https://api.keepa.com';
const KEEPA_API_KEY = process.env.KEEPA_API_KEY;

// Rate limiting: Keepa allows 1 request per 2 seconds for free tier
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 2500; // 2.5 seconds to be safe

async function rateLimitedRequest() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
    logger.info(`Rate limiting: waiting ${waitTime}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  lastRequestTime = Date.now();
}

export async function getProductHistory(asin) {
  if (!KEEPA_API_KEY) {
    logger.warn('Keepa API key not configured');
    return null;
  }
  
  try {
    await rateLimitedRequest();
    
    const url = new URL(`${KEEPA_API_BASE}/product`);
    url.searchParams.set('key', KEEPA_API_KEY);
    url.searchParams.set('domain', 'IN'); // Amazon India
    url.searchParams.set('asin', asin);
    url.searchParams.set('stats', '90'); // 90 days of stats
    url.searchParams.set('buybox', '1');
    url.searchParams.set('history', '1');
    
    logger.info(`Fetching Keepa data for ASIN: ${asin}`);
    
    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; DealBot/1.0)',
      },
    });
    
    if (!response.ok) {
      throw new Error(`Keepa API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (data.error) {
      throw new Error(`Keepa API error: ${data.error.message}`);
    }
    
    if (!data.products || data.products.length === 0) {
      logger.warn(`No Keepa data found for ASIN: ${asin}`);
      return null;
    }
    
    const product = data.products[0];
    return parseKeepaProduct(product);
    
  } catch (error) {
    logger.error(`Failed to fetch Keepa data for ${asin}`, { error: error.message });
    return null;
  }
}

function parseKeepaProduct(product) {
  // Keepa returns prices in a special format (hundredths of currency units)
  // We need to convert them back to actual prices
  
  const currentPrice = product.stats?.current?.[0] ? product.stats.current[0] / 100 : null;
  const avg90Day = product.stats?.avg90?.[0] ? product.stats.avg90[0] / 100 : null;
  const avg30Day = product.stats?.avg30?.[0] ? product.stats.avg30[0] / 100 : null;
  const lowestPrice = product.stats?.min?.[0] ? product.stats.min[0] / 100 : null;
  const highestPrice = product.stats?.max?.[0] ? product.stats.max[0] / 100 : null;
  
  // Parse price history if available
  const priceHistory = [];
  if (product.csv && product.csv[0]) {
    // csv[0] is the Amazon price history
    const csvData = product.csv[0];
    for (let i = 0; i < csvData.length; i += 2) {
      if (csvData[i] && csvData[i + 1]) {
        priceHistory.push({
          timestamp: keepaTimeToDate(csvData[i]),
          price: csvData[i + 1] / 100,
        });
      }
    }
  }
  
  return {
    asin: product.asin,
    title: product.title,
    currentPrice,
    avg90Day,
    avg30Day,
    lowestPrice,
    highestPrice,
    priceHistory: priceHistory.slice(-30), // Last 30 data points
    lastUpdate: new Date(),
  };
}

function keepaTimeToDate(keepaTime) {
  // Keepa time is minutes since Jan 1, 2011
  const keepaEpoch = new Date('2011-01-01T00:00:00Z').getTime();
  return new Date(keepaEpoch + keepaTime * 60000);
}

export async function cachePriceHistory(asin, priceData) {
  try {
    await query(`
      INSERT INTO price_history (time, asin, price, mrp, source)
      VALUES (NOW(), $1, $2, $3, 'keepa')
    `, [asin, priceData.currentPrice, priceData.highestPrice]);
    
    logger.info(`Cached price history for ${asin}`);
  } catch (error) {
    logger.error(`Failed to cache price history for ${asin}`, { error: error.message });
  }
}

export async function getCachedPriceHistory(asin, days = 30) {
  try {
    const result = await query(`
      SELECT * FROM price_history 
      WHERE asin = $1 
        AND time >= NOW() - $2 * INTERVAL '1 day'
      ORDER BY time DESC
    `, [asin, days]);
    
    return result.rows;
  } catch (error) {
    logger.error(`Failed to get cached price history for ${asin}`, { error: error.message });
    return [];
  }
}

export function analyzePriceTrend(priceData) {
  if (!priceData || !priceData.priceHistory || priceData.priceHistory.length < 2) {
    return {
      trend: 'unknown',
      confidence: 0,
      recommendation: 'insufficient_data',
    };
  }
  
  const history = priceData.priceHistory;
  const currentPrice = history[history.length - 1].price;
  const avgPrice = history.reduce((sum, h) => sum + h.price, 0) / history.length;
  const lowestPrice = Math.min(...history.map(h => h.price));
  const highestPrice = Math.max(...history.map(h => h.price));
  
  // Calculate trend
  const firstHalf = history.slice(0, Math.floor(history.length / 2));
  const secondHalf = history.slice(Math.floor(history.length / 2));
  const firstHalfAvg = firstHalf.reduce((sum, h) => sum + h.price, 0) / firstHalf.length;
  const secondHalfAvg = secondHalf.reduce((sum, h) => sum + h.price, 0) / secondHalf.length;
  
  const priceChange = ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100;
  
  let trend = 'stable';
  if (priceChange < -5) trend = 'decreasing';
  if (priceChange > 5) trend = 'increasing';
  
  // Calculate discount quality
  const discountFromAvg = ((avgPrice - currentPrice) / avgPrice) * 100;
  const discountFromHighest = ((highestPrice - currentPrice) / highestPrice) * 100;
  const isNearLowest = currentPrice <= lowestPrice * 1.05; // Within 5% of lowest
  
  let recommendation = 'average';
  if (isNearLowest && discountFromAvg > 20) {
    recommendation = 'excellent';
  } else if (discountFromAvg > 15 || isNearLowest) {
    recommendation = 'good';
  } else if (discountFromAvg < 5 && trend === 'increasing') {
    recommendation = 'poor';
  }
  
  return {
    trend,
    priceChange: Math.round(priceChange * 100) / 100,
    confidence: Math.min(history.length / 10, 1), // More data = higher confidence
    currentPrice,
    avgPrice: Math.round(avgPrice * 100) / 100,
    lowestPrice,
    highestPrice,
    discountFromAvg: Math.round(discountFromAvg * 100) / 100,
    discountFromHighest: Math.round(discountFromHighest * 100) / 100,
    isNearLowest,
    recommendation,
  };
}

export function detectFakeDiscount(currentPrice, mrp, priceHistory) {
  const analysis = {
    isFake: false,
    confidence: 0,
    reasons: [],
    realDiscount: 0,
    inflatedMRP: false,
  };
  
  if (!mrp || !currentPrice) {
    analysis.reasons.push('Insufficient data for analysis');
    return analysis;
  }
  
  const statedDiscount = ((mrp - currentPrice) / mrp) * 100;
  
  // Check if we have historical data
  if (priceHistory && priceHistory.length > 0) {
    const avgHistoricalPrice = priceHistory.reduce((sum, h) => sum + (h.price || h), 0) / priceHistory.length;
    const realDiscount = ((avgHistoricalPrice - currentPrice) / avgHistoricalPrice) * 100;
    
    analysis.realDiscount = Math.round(realDiscount * 100) / 100;
    
    // Detect inflated MRP
    if (mrp > avgHistoricalPrice * 1.3) {
      analysis.isFake = true;
      analysis.inflatedMRP = true;
      analysis.confidence = Math.min(0.9, priceHistory.length / 20);
      analysis.reasons.push(`MRP (${mrp}) is ${Math.round((mrp / avgHistoricalPrice - 1) * 100)}% higher than average historical price (${Math.round(avgHistoricalPrice)})`);
    }
    
    // Check if stated discount is misleading
    if (statedDiscount > 50 && realDiscount < 20) {
      analysis.isFake = true;
      analysis.confidence = Math.max(analysis.confidence, 0.7);
      analysis.reasons.push(`Stated discount is ${Math.round(statedDiscount)}% but real discount is only ${Math.round(realDiscount)}%`);
    }
    
    // Check if price was recently increased before "discount"
    if (priceHistory.length >= 3) {
      const recentPrices = priceHistory.slice(-3);
      const previousPrice = recentPrices[0].price || recentPrices[0];
      if (previousPrice > currentPrice * 1.2) {
        analysis.reasons.push('Price was recently increased before this "deal"');
        analysis.confidence = Math.max(analysis.confidence, 0.6);
      }
    }
  } else {
    // No historical data, use heuristics
    if (statedDiscount > 70) {
      analysis.reasons.push('Very high stated discount (>70%) without historical verification');
      analysis.confidence = 0.3;
    }
    
    if (mrp > currentPrice * 3) {
      analysis.isFake = true;
      analysis.inflatedMRP = true;
      analysis.reasons.push('MRP is more than 3x the current price - likely inflated');
      analysis.confidence = 0.5;
    }
  }
  
  return analysis;
}
