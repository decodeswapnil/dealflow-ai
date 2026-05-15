import { createLogger } from '../../shared/utils/logger.js';
import { query } from '../../shared/utils/db.js';
import { callAI as sharedCallAI } from '../../shared/utils/ai-client.js';

const logger = createLogger('ai-caption-engine');

/**
 * AI Caption Engine — Contextual, Psychology-Driven Caption Generation
 * Replaces template randomization with fresh AI-written content per product.
 */

// ── Archetype Definitions ──
export const CAPTION_ARCHETYPES = {
  URGENCY_DROP: {
    id: 'urgency_drop',
    emoji: '🔥',
    name: 'The Urgency Drop',
    useCase: 'Lightning deals, low stock, time-sensitive',
    tone: 'urgent_but_real',
    hookStyle: 'immediate_action',
  },
  DATA_NERD: {
    id: 'data_nerd',
    emoji: '📊',
    name: 'The Data Nerd',
    useCase: 'Price history available, chart-worthy drops',
    tone: 'factual_confident',
    hookStyle: 'proof_based',
  },
  SMART_ADVISOR: {
    id: 'smart_advisor',
    emoji: '💡',
    name: 'The Smart Advisor',
    useCase: 'High-ticket items (₹5K+), complex purchases',
    tone: 'helpful_expert',
    hookStyle: 'guidance',
  },
  GIFT_FINDER: {
    id: 'gift_finder',
    emoji: '🎁',
    name: 'The Gift Finder',
    useCase: 'Festival season, weekends, gifting occasions',
    tone: 'warm_thoughtful',
    hookStyle: 'relationship',
  },
  FRUSTRATED_SHOPPER: {
    id: 'frustrated_shopper',
    emoji: '😤',
    name: 'The Frustrated Shopper',
    useCase: 'Great deals that feel unreal, hard to believe prices',
    tone: 'shocked_validating',
    hookStyle: 'disbelief',
  },
  COMPARISON_KING: {
    id: 'comparison_king',
    emoji: '🏆',
    name: 'The Comparison King',
    useCase: 'Popular categories with brand competition',
    tone: 'analytical_winner',
    hookStyle: 'comparison',
  },
  INSIDER: {
    id: 'insider',
    emoji: '🤫',
    name: 'The Insider',
    useCase: 'Rarely discounted brands, hidden gems',
    tone: 'exclusive_secretive',
    hookStyle: 'scarcity_privilege',
  },
  REMINDER: {
    id: 'reminder',
    emoji: '⏰',
    name: 'The Reminder',
    useCase: 'Re-posted price drops, follow-ups',
    tone: 'helpful_update',
    hookStyle: 'follow_up',
  },
};

// ── Revenue-Optimized Category Weights ──
export const CATEGORY_COMMISSION_RATES = {
  'fashion': { pct: 9.5, multiplier: 1.5, conversionBoost: 1.2 },
  'luggage': { pct: 9.5, multiplier: 1.5, conversionBoost: 1.1 },
  'home': { pct: 7.5, multiplier: 1.3, conversionBoost: 1.0 },
  'kitchen': { pct: 7.5, multiplier: 1.3, conversionBoost: 1.0 },
  'beauty': { pct: 6.5, multiplier: 1.2, conversionBoost: 1.1 },
  'grooming': { pct: 6.5, multiplier: 1.2, conversionBoost: 1.1 },
  'toys': { pct: 6.0, multiplier: 1.1, conversionBoost: 1.0 },
  'baby': { pct: 6.0, multiplier: 1.1, conversionBoost: 1.0 },
  'electronics': { pct: 3.0, multiplier: 0.9, conversionBoost: 0.8 },
  'mobiles': { pct: 1.5, multiplier: 0.7, conversionBoost: 0.6 },
  'laptops': { pct: 3.0, multiplier: 0.9, conversionBoost: 0.7 },
  'headphones': { pct: 3.0, multiplier: 0.9, conversionBoost: 0.9 },
};

// ── Temporal Context Engine ──
function getTemporalContext() {
  const now = new Date();
  // Convert to IST (UTC+5:30) — consistent with rest of codebase
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const hour = istNow.getUTCHours();
  const day = istNow.getUTCDay(); // 0=Sunday, 6=Saturday
  const month = istNow.getUTCMonth();
  const date = istNow.getUTCDate();

  // Time-of-day psychology
  let timeContext = {};
  if (hour >= 5 && hour < 9) {
    timeContext = {
      period: 'morning',
      mood: 'fresh_start',
      browsingStyle: 'focused_intent',
      ctaStyle: 'start_your_day',
    };
  } else if (hour >= 9 && hour < 12) {
    timeContext = {
      period: 'mid_morning',
      mood: 'commute_scroll',
      browsingStyle: 'quick_browse',
      ctaStyle: 'check_it_out',
    };
  } else if (hour >= 12 && hour < 14) {
    timeContext = {
      period: 'lunch',
      mood: 'relaxed_browse',
      browsingStyle: 'impulse_friendly',
      ctaStyle: 'treat_yourself',
    };
  } else if (hour >= 14 && hour < 18) {
    timeContext = {
      period: 'afternoon',
      mood: 'slump_browsing',
      browsingStyle: 'distraction_seeker',
      ctaStyle: 'quick_win',
    };
  } else if (hour >= 18 && hour < 21) {
    timeContext = {
      period: 'evening',
      mood: 'wind_down',
      browsingStyle: 'family_decision',
      ctaStyle: 'discuss_with_family',
    };
  } else {
    timeContext = {
      period: 'night',
      mood: 'late_night_impulse',
      browsingStyle: 'bedtime_scroll',
      ctaStyle: 'before_you_sleep',
    };
  }

  // Day-of-week psychology
  const dayContext = {
    isWeekend: day === 0 || day === 6,
    isPayday: day === 5, // Friday payday culture in India
    isMonday: day === 1,
    dayName: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day],
  };

  // Seasonal context (Indian calendar)
  let seasonalContext = {};
  if (month === 0 && date >= 15) seasonalContext = { event: 'Republic Day Sale', urgency: 'high' };
  else if (month === 2) seasonalContext = { event: 'Summer Prep', urgency: 'medium' };
  else if (month >= 2 && month <= 4) seasonalContext = { event: 'Summer Season', urgency: 'medium' };
  else if (month === 7 && date >= 10 && date <= 20) seasonalContext = { event: 'Independence Day Sale', urgency: 'high' };
  else if (month >= 7 && month <= 8) seasonalContext = { event: 'Monsoon / Rakhi Season', urgency: 'medium' };
  else if (month >= 9 && month <= 10) seasonalContext = { event: 'Festive Season (Diwali)', urgency: 'very_high' };
  else if (month === 10 && date >= 20) seasonalContext = { event: 'Black Friday / Year End', urgency: 'high' };
  else if (month === 11) seasonalContext = { event: 'Year End Clearance', urgency: 'medium' };
  else seasonalContext = { event: null, urgency: 'normal' };

  return { time: timeContext, day: dayContext, seasonal: seasonalContext };
}

// ── Price Tier Classification ──
function getPriceTier(price) {
  if (price < 200) return { tier: 'micro', label: '₹200 se bhi kam', psychology: 'impulse_no_brainer' };
  if (price < 500) return { tier: 'budget', label: '₹500 se under', psychology: 'low_risk_trial' };
  if (price < 1500) return { tier: 'mid', label: '₹1500 range', psychology: 'considered_purchase' };
  if (price < 5000) return { tier: 'premium_budget', label: '₹5K tak', psychology: 'value_conscious' };
  if (price < 15000) return { tier: 'premium', label: '₹15K range', psychology: 'investment_purchase' };
  return { tier: 'luxury', label: '₹15K se upar', psychology: 'aspirational_research' };
}

// ── Archetype Selection Engine ──
export function selectArchetype(deal, priceStats, temporalContext) {
  const price = deal.finalPrice || deal.price;
  const mrp = deal.mrp || deal.originalPrice;
  const discount = deal.discountPct || (mrp ? Math.round((1 - price/mrp) * 100) : 0);
  const priceTier = getPriceTier(price);
  const category = (deal.category || 'general').toLowerCase();

  // Scoring each archetype
  const scores = {};

  // Urgency Drop: High discount + lightning deals
  scores.URGENCY_DROP = 0;
  if (discount >= 60) scores.URGENCY_DROP += 3;
  if (discount >= 40) scores.URGENCY_DROP += 2;
  if (priceTier.tier === 'micro' || priceTier.tier === 'budget') scores.URGENCY_DROP += 1;
  if (deal._isLightning || deal._isLimitedTime) scores.URGENCY_DROP += 2;

  // Data Nerd: Has price history, significant drop from average
  scores.DATA_NERD = 0;
  if (priceStats?.avgPrice && price < priceStats.avgPrice * 0.8) scores.DATA_NERD += 3;
  if (priceStats?.minPrice && price <= priceStats.minPrice * 1.1) scores.DATA_NERD += 2;
  if (deal.reviewCount > 1000) scores.DATA_NERD += 1; // Data-backed products

  // Smart Advisor: High-ticket, complex categories
  scores.SMART_ADVISOR = 0;
  if (price >= 5000) scores.SMART_ADVISOR += 3;
  if (category.includes('laptop') || category.includes('tv') || category.includes('camera')) scores.SMART_ADVISOR += 2;
  if (category.includes('headphone') || category.includes('speaker')) scores.SMART_ADVISOR += 1;
  if (deal.rating >= 4.0 && deal.reviewCount > 500) scores.SMART_ADVISOR += 1;

  // Gift Finder: Weekend, festive season, relevant categories
  scores.GIFT_FINDER = 0;
  if (temporalContext.day.isWeekend) scores.GIFT_FINDER += 1;
  if (temporalContext.seasonal.urgency === 'high' || temporalContext.seasonal.urgency === 'very_high') scores.GIFT_FINDER += 2;
  if (category.includes('toy') || category.includes('beauty') || category.includes('fashion') || category.includes('watch')) scores.GIFT_FINDER += 2;
  if (priceTier.tier === 'mid' || priceTier.tier === 'premium_budget') scores.GIFT_FINDER += 1;

  // Frustrated Shopper: Unbelievably good deals
  scores.FRUSTRATED_SHOPPER = 0;
  if (discount >= 70) scores.FRUSTRATED_SHOPPER += 3;
  if (priceStats?.avgPrice && price < priceStats.avgPrice * 0.6) scores.FRUSTRATED_SHOPPER += 2;
  if (deal.rating >= 4.2 && deal.reviewCount > 2000) scores.FRUSTRATED_SHOPPER += 1;
  if (brandIsPremium(deal.title)) scores.FRUSTRATED_SHOPPER += 1;

  // Comparison King: Categories with strong brand competition
  scores.COMPARISON_KING = 0;
  if (category.includes('headphone') || category.includes('earbud') || category.includes('speaker')) scores.COMPARISON_KING += 3;
  if (category.includes('mobile') || category.includes('laptop')) scores.COMPARISON_KING += 2;
  if (category.includes('tv') || category.includes('watch')) scores.COMPARISON_KING += 1;
  if (deal.rating >= 4.0) scores.COMPARISON_KING += 1;

  // Insider: Rarely discounted premium brands
  scores.INSIDER = 0;
  if (brandIsRarelyDiscounted(deal.title)) scores.INSIDER += 3;
  if (brandIsPremium(deal.title)) scores.INSIDER += 1;
  if (discount >= 20 && brandIsPremium(deal.title)) scores.INSIDER += 1;

  // Reminder: Only for re-posted deals
  scores.REMINDER = 0;
  if (deal._isReprice) scores.REMINDER += 10; // Strong signal, override others

  // Select highest scoring archetype
  const entries = Object.entries(scores);
  entries.sort((a, b) => b[1] - a[1]);
  const [winner, score] = entries[0];

  // If no strong signal, default based on price
  if (score === 0) {
    if (price >= 5000) return CAPTION_ARCHETYPES.SMART_ADVISOR;
    if (discount >= 50) return CAPTION_ARCHETYPES.URGENCY_DROP;
    return CAPTION_ARCHETYPES.FRUSTRATED_SHOPPER;
  }

  return CAPTION_ARCHETYPES[winner];
}

function brandIsPremium(title) {
  const premiumBrands = ['apple', 'sony', 'samsung', 'bose', 'dyson', 'nike', 'adidas', 'puma',
    'apple watch', 'airpods', 'macbook', 'iphone', 'ipad', 'galaxy', 'pixel'];
  const lower = title.toLowerCase();
  return premiumBrands.some(b => lower.includes(b));
}

function brandIsRarelyDiscounted(title) {
  const rareBrands = ['apple', 'dyson', 'sonos', 'nintendo', 'playstation', 'xbox', 'nike', 'adidas'];
  const lower = title.toLowerCase();
  return rareBrands.some(b => lower.includes(b));
}

// ── Prompt Engineering — Hook + Motivation Only ──
// AI only generates the 2 dynamic parts; structured template handles everything else.
function sanitizeForPrompt(text) {
  if (!text) return '';
  return String(text)
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f]/g, '') // Remove control chars
    .replace(/\{/g, '(').replace(/\}/g, ')')       // Prevent JSON confusion
    .substring(0, 120);                              // Limit length
}

function buildHookMotivationPrompt(deal, archetype, temporalContext, priceTier) {
  const price = deal.finalPrice || deal.price;
  const mrp = deal.mrp || deal.originalPrice;
  const discount = deal.discountPct || (mrp ? Math.round((1 - price/mrp) * 100) : 0);
  const category = sanitizeForPrompt(deal.category || 'general');
  const title = sanitizeForPrompt(deal.title);
  const recentPhrases = getRecentPhrases(archetype?.id || 'general');
  const bankOffers = deal.bankOffers || deal.bank_offers || null;

  // Price-tier rules for motivation — what to mention and what to NEVER mention
  const tierRules = getMotivationRulesForTier(price, category, bankOffers);

  // Build bank offer context line for the prompt
  const bankOfferContext = bankOffers
    ? `\n🏦 Bank/Card Offer: ${sanitizeForPrompt(bankOffers)}`
    : '';

  return `You write Hinglish text for an Indian Amazon deal Telegram channel. Be natural and friendly like a friend texting — not corporate, not pushy.

Product: ${title?.substring(0, 80)}
Category: ${category}
Price: ₹${price}${mrp && discount > 0 ? ` (${discount}% off MRP ₹${mrp})` : ''}${bankOfferContext}
${deal.rating ? `Rating: ${deal.rating}/5` : ''}${deal.reviewCount > 100 ? ` · ${deal.reviewCount.toLocaleString('en-IN')} reviews` : ''}
Context: ${temporalContext.time.period}, ${temporalContext.day.dayName}${temporalContext.seasonal.event ? `, ${temporalContext.seasonal.event}` : ''}
Archetype: ${archetype?.emoji || '✨'} ${archetype?.name || 'General'} — ${archetype?.tone || 'friendly'}
Price Tier: ${priceTier?.tier || 'unknown'} — ${priceTier?.psychology || 'general'}

MOTIVATION RULES (follow strictly based on price):
${tierRules}

AVOID these overused phrases: ${recentPhrases.slice(0, 8).join(', ') || 'none'}

Output ONLY valid JSON with exactly these two fields:
{
  "hook": "One conversational opening line in Hinglish. No emoji overload. Feels like a friend just shared something. Max 80 chars.${bankOffers ? ' You may reference the bank/card discount naturally if it adds value.' : ''}",
  "motivation": "1-2 short practical lines after the buy button. ONLY mention what's relevant per the MOTIVATION RULES above. No 'prices may change' filler. Max 100 chars total."
}

Only output the JSON. No explanation, no markdown.`;
}

// ── Price-Tiered Motivation Rules for AI Prompt ──
// Tells the AI exactly what to mention and what to NEVER mention based on price
function getMotivationRulesForTier(price, category, bankOffers = null) {
  const cat = (category || 'general').toLowerCase();
  const isElectronics = /electronics|mobile|laptop|headphone|speaker|camera|appliance|tv/.test(cat);
  const bankNote = bankOffers
    ? `\n- IMPORTANT: A bank/card offer is available. You can reference it naturally in motivation (e.g. "HDFC card se aur ₹X off"). Don't repeat the full offer text — just hint at extra savings.`
    : '';

  if (price < 300) {
    return `- This is an impulse buy (under ₹300). NEVER mention EMI, warranty, or exchange.
- ONLY mention: fast delivery, easy returns, low stock, or "add to cart" convenience.
- Keep it to 1 short line. Example: "Fast delivery + easy returns ✅"`;
  }
  if (price < 1500) {
    return `- Budget item (₹300-₹1500). NEVER mention EMI.
- Mention warranty ONLY if it's electronics/appliances.
- Prioritize: fast delivery, easy returns, good reviews, stock urgency.${bankNote}
- Max 1-2 short lines.`;
  }
  if (price < 5000) {
    return `- Mid-range item (₹1500-₹5000). EMI is okay but not required.
- Warranty and returns are relevant.
- Prioritize: value for money, fast delivery, easy returns.${bankNote}
- Max 1-2 short lines.`;
  }
  // ₹5000+ — big ticket
  return `- High-ticket item (₹5000+). EMI, warranty, exchange, delivery, returns ALL are relevant.
- Buyers research before purchasing, so mention what helps them decide.${bankNote}
- Keep it to 1-2 lines, not a paragraph.`;
}

function getArchetypeGuidance(archetype) {
  const guidance = {
    urgency_drop: 'Start with time pressure. "2 ghante mein khatam" / "stock dekh ke post kar raha hoon". Make it feel like you just saw this and had to share immediately.',
    data_nerd: 'Lead with the data. "6 mahine ka lowest" / "chart dekh lo". Show you did the homework. Numbers build trust.',
    smart_advisor: 'Be the helpful friend who knows this category. Ask a qualifying question. "₹12K budget hai? Ye padho pehle." Guide, don\'t push.',
    gift_finder: 'Make it about someone else. "Mummy ke liye" / "Bhai ki birthday mein". Warm, thoughtful, not transactional.',
    frustrated_shopper: 'Express disbelief. "Maine khud double-check kiya" / "itna sasta kaise?". Your shock validates the deal.',
    comparison_king: 'Name the competition. "JBL vs boAt vs Sony — is price mein winner kaun?" Position this as the smart choice.',
    insider: 'Make them feel special. "Apple pe discount? Haan, rarely hota hai." Scarcity of brand + scarcity of price.',
    reminder: 'Acknowledge the past. "Remember jo mixer post kiya tha? Price aur gira." Loyalty loop for engaged subscribers.',
  };
  return guidance[archetype?.id] || 'Write a natural, engaging caption that feels like a friend sharing a genuine find.';
}

function getCategoryCommission(category) {
  if (!category) return null;
  const cat = category.toLowerCase();
  for (const [key, value] of Object.entries(CATEGORY_COMMISSION_RATES)) {
    if (cat.includes(key)) return value;
  }
  return null;
}

// Track last N captions to avoid repetition — per-category buckets for thread safety
const recentCaptionPhrases = new Map();
const MAX_RECENT_PHRASES = 30;
const CATEGORY_BUCKETS = ['urgency', 'data', 'advisor', 'gift', 'frustrated', 'comparison', 'insider', 'reminder', 'digest', 'engagement'];

function getRecentPhrases(category = 'general') {
  const bucket = CATEGORY_BUCKETS.find(b => category.includes(b)) || 'general';
  return recentCaptionPhrases.get(bucket) || [];
}

export function recordCaptionPhrases(caption, category = 'general') {
  const bucket = CATEGORY_BUCKETS.find(b => category.includes(b)) || 'general';
  const phrases = caption
    .split(/[.!?\n]/)
    .map(s => s.trim())
    .filter(s => s.length > 10 && s.length < 100)
    .slice(0, 3);
  
  const existing = recentCaptionPhrases.get(bucket) || [];
  const updated = [...existing, ...phrases].slice(-MAX_RECENT_PHRASES);
  recentCaptionPhrases.set(bucket, updated);
}

// ── AI API Client — thin wrapper over shared provider chain ──
// Priority: Ollama → Replicate → OpenRouter → Gemini
// With retry logic and exponential backoff
async function callAIForCaption(prompt, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await sharedCallAI(prompt, { maxTokens: 512, temperature: 0.75 });
      if (result.text) {
        logger.info('AI caption generated', { source: result.source, length: result.text.length, attempt: attempt + 1 });
        return result;
      }
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        logger.warn(`AI attempt ${attempt + 1} returned empty, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (err) {
      lastError = err;
      logger.warn(`AI attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  
  logger.error('All AI caption attempts failed', { error: lastError?.message });
  return { text: null, source: 'none', cost: 'zero' };
}

function cleanAIOutput(text) {
  // Remove markdown code blocks if present
  text = text.replace(/```html?\n?/g, '').replace(/```\n?/g, '');
  // Remove any "Caption:" or similar prefixes
  text = text.replace(/^(caption|post|telegram caption):\s*/i, '');
  // Trim
  text = text.trim();
  return text;
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

// ── Robust JSON / key-value extraction for LLM outputs ──
// LLMs often return truncated JSON. This tries regex extraction first, then JSON repair, then strict JSON.
function extractHookMotivation(text) {
  if (!text) return null;

  // 1. Try regex extraction first (most tolerant) — handles escaped quotes and truncation
  // This works even if the JSON is incomplete
  const hookMatch = text.match(/"hook"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  let motivationMatch = text.match(/"motivation"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  
  // If motivation doesn't have closing quote, try to extract until end of line or text
  if (!motivationMatch && text.includes('"motivation"')) {
    motivationMatch = text.match(/"motivation"\s*:\s*"([^"]*)$/);
  }
  
  if (hookMatch) {
    return {
      hook: hookMatch[1].replace(/\\(.)/g, '$1').trim(),
      motivation: motivationMatch ? motivationMatch[1].replace(/\\(.)/g, '$1').trim() : '',
    };
  }

  // 2. Try JSON repair for common truncation issues
  let repaired = text
    .replace(/```(?:json)?\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
  
  // Fix trailing commas before closing braces/brackets
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');
  
  // Balance quotes - close any unclosed quotes
  const openQuotes = (repaired.match(/"/g) || []).length;
  if (openQuotes % 2 !== 0) {
    // Find the last quote and close it
    repaired += '"';
  }
  
  // Balance braces
  const openBraces = (repaired.match(/\{/g) || []).length;
  const closeBraces = (repaired.match(/\}/g) || []).length;
  for (let i = 0; i < openBraces - closeBraces; i++) repaired += '}';
  
  // Balance brackets
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/\]/g) || []).length;
  for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += ']';

  try {
    const parsed = JSON.parse(repaired);
    if (parsed.hook) {
      return {
        hook: String(parsed.hook).trim(),
        motivation: String(parsed.motivation || '').trim(),
      };
    }
  } catch (_) {
    // 3. Try relaxed parsing — look for hook: and motivation: patterns
    const relaxedHook = text.match(/hook[:\s]+["']?([^"'\n]+?)["']?\s*(?:,|\n|motivation)/i);
    const relaxedMotivation = text.match(/motivation[:\s]+["']?([^"'\n]+?)["']?\s*(?:\n|$|})/i);
    if (relaxedHook) {
      return {
        hook: relaxedHook[1].trim(),
        motivation: relaxedMotivation ? relaxedMotivation[1].trim() : '',
      };
    }
  }

  return null;
}

// ── Main Hook + Motivation Generation ──
// Returns { hook, motivationLines } — the two dynamic parts the structured template needs.
// AI never controls the full caption layout; the template always does.
export async function generateAICaption(deal, priceStats = null, options = {}) {
  const temporalContext = getTemporalContext();
  const priceTier = getPriceTier(deal.finalPrice || deal.price);

  // Select archetype
  const archetype = options.forceArchetype || selectArchetype(deal, priceStats, temporalContext);

  // Build lean prompt — only ask for hook + motivation
  const prompt = buildHookMotivationPrompt(deal, archetype, temporalContext, priceTier);

  // Call AI with retry
  const aiResult = await callAIForCaption(prompt, 2);

  if (aiResult.text) {
    try {
      const extracted = extractHookMotivation(aiResult.text);
      if (extracted && extracted.hook) {
        const hook = extracted.hook.substring(0, 120);
        const motivationRaw = extracted.motivation.substring(0, 200);
        const motivationLines = motivationRaw
          .split(/\n|(?<=\.)\s+/)
          .map(l => l.trim())
          .filter(l => l.length > 3)
          .slice(0, 2);

        recordCaptionPhrases(hook + ' ' + motivationRaw, archetype.id);
        logger.info('AI hook+motivation generated', {
          source: aiResult.source,
          hookLen: hook.length,
          motivationLines: motivationLines.length,
        });
        return {
          hook,
          motivationLines,
          archetype: archetype.id,
          archetypeName: archetype.name,
          source: aiResult.source,
          aiGenerated: true,
        };
      }
    } catch (parseErr) {
      logger.warn('AI returned unparseable hook+motivation, falling back', {
        error: parseErr.message,
        raw: aiResult.text?.substring(0, 200),
      });
    }
  }

  // Fallback: return null so caller uses template hooks
  logger.warn('AI hook generation failed, returning null for template fallback');
  return null;
}

// ── Digest Caption Generation ──
export async function generateDigestCaption(deals, digestType = 'morning') {
  if (!deals || deals.length === 0) return null;

  const temporalContext = getTemporalContext();
  const dealSummaries = deals.map((d, i) => {
    const price = d.finalPrice || d.price;
    const mrp = d.mrp || d.originalPrice;
    const discount = d.discountPct || (mrp ? Math.round((1 - price/mrp) * 100) : 0);
    const safeTitle = sanitizeForPrompt(d.title);
    return `${i + 1}. ${safeTitle.substring(0, 50)}${safeTitle.length > 50 ? '...' : ''} — ₹${price.toLocaleString('en-IN')}${discount > 0 ? ` (${discount}% off)` : ''}`;
  }).join('\n');

  const prompt = `You are DealDecode, a friendly Indian deal channel. Write a ${digestType === 'morning' ? 'morning digest' : digestType === 'evening' ? 'evening roundup' : 'deal digest'} caption for Telegram in Hinglish.

Tone: ${digestType === 'morning' ? 'energetic, "start your savings day"' : digestType === 'evening' ? 'relaxed, "here\'s what you missed"' : 'helpful, curated list'}

Rules:
- Keep under 900 characters
- Use HTML formatting (<b>bold</b>, <i>italic</i>)
- Group by a theme if possible
- End with a warm CTA
- 2-4 hashtags

Deals:\n${dealSummaries}\n\nWrite the digest caption now. Only output the caption.`;

  const aiResult = await callAIForCaption(prompt, 2);

  if (aiResult.text) {
    const cleanText = cleanAIOutput(aiResult.text);
    return {
      caption: cleanText.length > 1000 ? cleanText.substring(0, 997) + '...' : cleanText,
      archetype: 'digest',
      archetypeName: 'Deal Digest',
      source: aiResult.source,
      aiGenerated: true,
    };
  }

  return null;
}

// ── Engagement Post Generation ──
export async function generateEngagementPost(type, context = {}) {
  const temporalContext = getTemporalContext();

  let prompt = '';
  switch (type) {
    case 'poll':
      prompt = `Write a Telegram poll post in Hinglish asking Indian shoppers to vote between two popular brands/products.
Topic: ${context.topic || 'boAt vs JBL earphones'}
Rules: Keep it under 400 chars, fun tone, end with "Vote below! 👇" and 2 hashtags.`;
      break;
    case 'tip':
      prompt = `Write a quick Amazon shopping tip for Indian users in Hinglish.
Topic: ${context.topic || 'how to check if a deal is genuine'}
Rules: 3-4 bullet points, under 500 chars, helpful not preachy, 2 hashtags.`;
      break;
    case 'comparison':
      prompt = `Write a brand comparison teaser in Hinglish.
Products: ${context.products || 'Wireless earbuds under ₹2000'}
Rules: Mention 3 brands, say "full comparison coming tomorrow", under 400 chars, 2 hashtags.`;
      break;
    case 'price_alert':
      prompt = `Write a price alert prediction post in Hinglish.
Sale: ${context.sale || 'upcoming Amazon Great Indian Festival'}
Products: ${context.products || 'flagship phones and TVs'}
Rules: Build excitement, say "follow for alerts", under 400 chars, 2 hashtags.`;
      break;
    case 'weekly_winner':
      prompt = `Write a "deal of the week" celebration post in Hinglish.
Product: ${context.productTitle || 'Most popular deal'}
Clicks: ${context.clickCount || 'many'}
Rules: Thank subscribers, highlight why it was popular, under 400 chars, 2 hashtags.`;
      break;
    default:
      prompt = `Write a fun engagement post for a Telegram deal channel in Hinglish. Topic: ${context.topic || 'general shopping tip'}. Under 400 chars, 2 hashtags.`;
  }

  const aiResult = await callAIForCaption(prompt);

  if (aiResult.text) {
    return {
      content: aiResult.text,
      postType: type,
      source: aiResult.source,
      aiGenerated: true,
    };
  }

  // Fallback templates for engagement posts
  const fallbacks = {
    poll: `🗳️ Quick Poll\n\n${context.topic || 'boAt vs JBL'} — kaunsa brand zyada trustworthy lagta hai?\n\nA) boAt 🎧\nB) JBL 🎵\n\nVote karo! 👇\n\n#Poll #ShoppingIndia`,
    tip: `💡 Amazon Tip #${context.tipNumber || 1}\n\n${context.topic || 'Deal verify karne ka tarika:'}\n\n1. Price history check karo (Keepa use karo)\n2. Reviews padho — 4+ star + 500+ reviews = safe\n3. "Amazon Fulfilled" label dekho\n\nAur tips chahiye? Follow karo! ✅\n\n#AmazonTips #SmartShopping`,
    comparison: `🏆 Coming Tomorrow\n\n${context.products || 'Best earbuds under ₹2K'} — full comparison!\n\nboAt 🆚 JBL 🆚 Sony\n\nKaunsa value for money hai? Kaunsa sound best deta hai?\n\nKal same time post karenge. Notification on kar lo! 🔔\n\n#Comparison #TechIndia`,
    price_alert: `📢 Alert\n\n${context.sale || 'Great Indian Festival'} aa raha hai!\n\n${context.products || 'Phones & TVs'} pe heavy discounts expected.\n\nMain track kar raha hoon — jaise hi prices drop, instant post! ⚡\n\nFollow karo, miss mat karna. 🔔\n\n#PriceAlert #SaleIndia`,
    weekly_winner: `🏆 Is Hafte Ka Winner\n\n${context.productTitle || 'Sabse popular deal'} ne sabse zyada clicks liye!\n\nAap logo ko pasand aaya — yehi motivation hai. 💪\n\nAgle hafte aur bhi mast deals laa rahe hain.\n\nShukriya! ❤️\n\n#DealOfTheWeek #ThankYou`,
  };

  return {
    content: fallbacks[type] || fallbacks.tip,
    postType: type,
    source: 'template_fallback',
    aiGenerated: false,
  };
}

// ── Revenue Score Multiplier ──
export function getRevenueMultiplier(category) {
  const commission = getCategoryCommission(category);
  if (!commission) return 1.0;
  return commission.multiplier;
}

// ── Export utilities for testing ──
export { getTemporalContext, getPriceTier, getCategoryCommission };
