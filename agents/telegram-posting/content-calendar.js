import { createLogger } from '../../shared/utils/logger.js';
import { query } from '../../shared/utils/db.js';
import redis from '../../shared/utils/redis.js';
import { getTemporalContext, getRevenueMultiplier, selectArchetype } from './ai-caption-engine.js';

const logger = createLogger('content-calendar');

/**
 * Content Calendar — Revenue-Aligned Scheduling System
 * Adjusts posting rhythm based on: day-of-week conversion curves, 
 * time-of-day engagement, and daily/weekly revenue targets.
 */

// ── Config ──
const DAILY_REVENUE_TARGET = parseFloat(process.env.DAILY_REVENUE_TARGET) || 150; // ₹150/day target
const WEEKLY_REVENUE_TARGET = DAILY_REVENUE_TARGET * 7;

// Day-of-week conversion multipliers (based on Indian e-commerce patterns)
const DAY_CONVERSION_MULTIPLIERS = {
  0: { multiplier: 1.15, label: 'Sunday', reason: 'weekend_browsing_peak' },   // Sunday: highest
  1: { multiplier: 0.75, label: 'Monday', reason: 'post_weekend_fatigue' },      // Monday: lowest
  2: { multiplier: 0.85, label: 'Tuesday', reason: 'mid_week_recovery' },
  3: { multiplier: 0.90, label: 'Wednesday', reason: 'steady_midweek' },
  4: { multiplier: 0.95, label: 'Thursday', reason: 'pre_payday_browsing' },
  5: { multiplier: 1.05, label: 'Friday', reason: 'payday_impulse' },           // Friday: payday
  6: { multiplier: 1.10, label: 'Saturday', reason: 'weekend_shopping' },
};

// ── Sale Tracking ──
// Major Indian e-commerce sales (update as needed)
const KNOWN_SALES = [
  { name: 'Great Republic Day Sale', startMonth: 0, startDay: 13, endDay: 19, emoji: '🇮🇳' },
  { name: 'Valentine\'s Day Sale', startMonth: 1, startDay: 7, endDay: 14, emoji: '💝' },
  { name: 'Summer Sale', startMonth: 2, startDay: 15, endDay: 31, emoji: '☀️' },
  { name: 'Great Summer Sale', startMonth: 3, startDay: 1, endDay: 15, emoji: '☀️' },
  { name: 'Mother\'s Day Sale', startMonth: 4, startDay: 5, endDay: 12, emoji: '💐' },
  { name: 'Prime Day Sale', startMonth: 6, startDay: 15, endDay: 22, emoji: '👑' },
  { name: 'Independence Day Sale', startMonth: 7, startDay: 10, endDay: 17, emoji: '🇮🇳' },
  { name: 'Great Indian Festival', startMonth: 9, startDay: 8, endDay: 15, emoji: '🪔' },
  { name: 'Diwali Sale', startMonth: 10, startDay: 1, endDay: 14, emoji: '🪔' },
  { name: 'Black Friday Sale', startMonth: 10, startDay: 20, endDay: 30, emoji: '🖤' },
  { name: 'Year End Sale', startMonth: 11, startDay: 20, endDay: 31, emoji: '🎉' },
  { name: 'New Year Sale', startMonth: 0, startDay: 1, endDay: 5, emoji: '🎆' },
];

/**
 * Check if there's an active sale today
 */
export function getActiveSale() {
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentDay = now.getDate();
  
  for (const sale of KNOWN_SALES) {
    if (sale.startMonth === currentMonth && currentDay >= sale.startDay && currentDay <= sale.endDay) {
      const daysRemaining = sale.endDay - currentDay;
      return {
        ...sale,
        isActive: true,
        daysRemaining,
        urgency: daysRemaining <= 2 ? 'high' : daysRemaining <= 5 ? 'medium' : 'low',
      };
    }
  }
  
  return null;
}

/**
 * Get sale-aware posting multiplier
 */
export function getSaleMultiplier() {
  const sale = getActiveSale();
  if (!sale) return 1.0;
  
  // Boost posting during sales
  if (sale.urgency === 'high') return 1.5;
  if (sale.urgency === 'medium') return 1.3;
  return 1.2;
}


// Hourly posting slots with Indian engagement patterns
const HOURLY_SLOTS = {
  8:  { label: 'morning_rush',     score: 0.85, type: 'deal' },     // 8-9 AM: commute check
  9:  { label: 'mid_morning',      score: 0.75, type: 'deal' },
  10: { label: 'coffee_break',     score: 0.70, type: 'deal' },
  11: { label: 'pre_lunch',        score: 0.65, type: 'deal' },
  12: { label: 'lunch_peak',       score: 0.90, type: 'deal' },    // 12-1 PM: lunch scroll
  13: { label: 'post_lunch',       score: 0.80, type: 'deal' },
  14: { label: 'afternoon_slump',  score: 0.60, type: 'engagement' }, // 2-3 PM: low conversion, engagement only
  15: { label: 'tea_time',         score: 0.70, type: 'deal' },
  16: { label: 'late_afternoon',   score: 0.65, type: 'deal' },
  17: { label: 'commute_home',     score: 0.80, type: 'deal' },    // 5-6 PM: commute
  18: { label: 'evening_peak',     score: 1.00, type: 'deal' },     // 6-7 PM: highest engagement
  19: { label: 'prime_time',       score: 0.95, type: 'deal' },    // 7-8 PM: family browsing
  20: { label: 'night_scroll',     score: 0.85, type: 'deal' },     // 8-9 PM: bedtime scroll
  21: { label: 'late_night',       score: 0.70, type: 'deal' },
  22: { label: 'impulse_hour',     score: 0.75, type: 'deal' },    // 10-11 PM: late night impulse
};

// Daily content type quotas (adjusted by day-of-week)
const BASE_CONTENT_QUOTA = {
  deals: { min: 4, max: 8, target: 6 },
  digests: { min: 1, max: 2, target: 1 },
  engagement: { min: 1, max: 2, target: 1 },
  reposts: { min: 0, max: 1, target: 0 },
};

export function getDayOfWeekConfig() {
  const day = new Date().getDay();
  return DAY_CONVERSION_MULTIPLIERS[day];
}

export function getCurrentSlotConfig() {
  const hour = new Date().getHours();
  return HOURLY_SLOTS[hour] || { label: 'off_hours', score: 0.40, type: 'none' };
}

// ── Revenue Pacing ──
export async function getRevenuePacing() {
  try {
    // Today's actual so far
    const todayResult = await query(`
      SELECT COALESCE(SUM(estimated_revenue), 0) as today_revenue,
             COALESCE(SUM(clicks), 0) as today_clicks,
             COUNT(*) as today_posts
      FROM posted_deals
      WHERE time >= DATE_TRUNC('day', NOW()) AND time < DATE_TRUNC('day', NOW() + INTERVAL '1 day')
    `);
    const todayRevenue = parseFloat(todayResult.rows[0]?.today_revenue || 0);
    const todayClicks = parseInt(todayResult.rows[0]?.today_clicks || 0);
    const todayPosts = parseInt(todayResult.rows[0]?.today_posts || 0);

    // This week's actual so far
    const weekResult = await query(`
      SELECT COALESCE(SUM(estimated_revenue), 0) as week_revenue,
             COALESCE(SUM(clicks), 0) as week_clicks
      FROM posted_deals
      WHERE time >= NOW() - INTERVAL '7 days'
    `);
    const weekRevenue = parseFloat(weekResult.rows[0]?.week_revenue || 0);

    // Today's target adjusted for day-of-week
    const dayConfig = getDayOfWeekConfig();
    const adjustedDailyTarget = DAILY_REVENUE_TARGET * dayConfig.multiplier;

    // Pace: ahead or behind
    const hourOfDay = new Date().getHours();
    const dayProgress = hourOfDay / 24; // 0 to 1
    const expectedSoFar = adjustedDailyTarget * dayProgress;
    const pace = todayRevenue / (expectedSoFar || 1);

    return {
      todayRevenue,
      todayClicks,
      todayPosts,
      weekRevenue,
      adjustedDailyTarget,
      expectedSoFar,
      pace,
      dayConfig,
      status: pace >= 1.0 ? 'on_track' : pace >= 0.7 ? 'slightly_behind' : 'behind',
    };
  } catch (e) {
    logger.error('Revenue pacing query failed', { error: e.message });
    return {
      todayRevenue: 0, todayClicks: 0, todayPosts: 0, weekRevenue: 0,
      adjustedDailyTarget: DAILY_REVENUE_TARGET,
      expectedSoFar: 0, pace: 1.0,
      dayConfig: getDayOfWeekConfig(),
      status: 'unknown',
    };
  }
}

// ── Content Quota for Today ──
export function getTodayContentQuota(revenuePacing = null) {
  const dayConfig = getDayOfWeekConfig();
  const pacing = revenuePacing || { pace: 1.0, status: 'on_track' };

  const quota = {};

  for (const [type, limits] of Object.entries(BASE_CONTENT_QUOTA)) {
    let target = Math.round(limits.target * dayConfig.multiplier);

    // Adjust based on revenue pacing
    if (pacing.status === 'behind') {
      if (type === 'deals') target = Math.round(target * 1.2); // Post more deals
      if (type === 'engagement') target = Math.max(limits.min, target - 1); // Fewer engagement posts
    } else if (pacing.status === 'on_track' && pacing.pace > 1.3) {
      // We're way ahead — can afford fewer posts, more quality
      if (type === 'deals') target = Math.max(limits.min, Math.round(target * 0.9));
    }

    quota[type] = {
      target: Math.min(target, limits.max),
      min: limits.min,
      max: limits.max,
    };
  }

  return quota;
}

// ── Slot Evaluation ──
export function shouldPostNow(revenuePacing = null) {
  const slot = getCurrentSlotConfig();
  const pacing = revenuePacing || { pace: 1.0, status: 'on_track' };

  // Basic slot quality check
  if (slot.type === 'none') {
    return { shouldPost: false, reason: 'off_hours', urgency: 'skip' };
  }

  // If we're behind on revenue, be more aggressive
  if (pacing.status === 'behind') {
    if (slot.score >= 0.60) {
      return { shouldPost: true, reason: 'revenue_behind_aggressive', urgency: 'high', slot };
    }
    return { shouldPost: false, reason: 'even_behind_slot_too_weak', urgency: 'medium', slot };
  }

  // If we're on track, only post in good+ slots
  if (slot.score >= 0.70) {
    return { shouldPost: true, reason: 'good_slot_on_track', urgency: 'normal', slot };
  }

  // Afternoon slump — only engagement posts
  if (slot.label === 'afternoon_slump') {
    return { shouldPost: true, reason: 'engagement_slot', urgency: 'low', slot, contentType: 'engagement' };
  }

  return { shouldPost: false, reason: 'weak_slot_skip', urgency: 'skip', slot };
}

// ── Deal Ranking for Posting Priority ──
export function rankDealsForPosting(deals, revenuePacing = null) {
  const temporal = getTemporalContext();
  const slot = getCurrentSlotConfig();
  const pacing = revenuePacing || { pace: 1.0 };

  return deals.map(deal => {
    let score = deal.dealScore || deal.score || 5;
    const price = deal.finalPrice || deal.price;
    const category = (deal.category || 'general').toLowerCase();

    // Revenue weighting: boost high-commission categories when behind
    const revenueMultiplier = getRevenueMultiplier(category);
    if (pacing.status === 'behind') {
      score *= (1 + (revenueMultiplier - 1) * 1.5); // Amplify revenue boost
    } else {
      score *= revenueMultiplier;
    }

    // Time-of-day fit
    const archetype = selectArchetype(deal, null, temporal);
    if (slot.label === 'morning_rush' && archetype.id === 'urgency_drop') score *= 1.1;
    if (slot.label === 'evening_peak' && archetype.id === 'smart_advisor') score *= 1.1;
    if (slot.label === 'night_scroll' && archetype.id === 'gift_finder') score *= 1.1;
    if (slot.label === 'afternoon_slump') score *= 0.8; // General dip

    // Weekend gifting boost
    if (temporal.day.isWeekend && ['gift_finder', 'smart_advisor'].includes(archetype.id)) {
      score *= 1.15;
    }

    // Friday payday impulse boost
    if (temporal.day.isPayday && price < 2000) {
      score *= 1.1; // Budget items do well on payday
    }

    return {
      ...deal,
      postingScore: Math.round(score * 100) / 100,
      archetype: archetype.id,
      archetypeName: archetype.name,
    };
  }).sort((a, b) => b.postingScore - a.postingScore);
}

// ── Redis Helpers for State ──
const REDIS_PREFIX = 'content_calendar:';

export async function getTodayPostCounts() {
  try {
    const counts = await redis.get(`${REDIS_PREFIX}daily_counts:${new Date().toDateString()}`);
    if (counts) return JSON.parse(counts);
  } catch (e) { /* ignore */ }

  return { deals: 0, digests: 0, engagement: 0, reposts: 0 };
}

export async function incrementPostCount(type) {
  const key = `${REDIS_PREFIX}daily_counts:${new Date().toDateString()}`;
  try {
    const existing = await redis.get(key);
    const counts = existing ? JSON.parse(existing) : { deals: 0, digests: 0, engagement: 0, reposts: 0 };
    counts[type] = (counts[type] || 0) + 1;
    await redis.setex(key, 86400, JSON.stringify(counts));
    return counts;
  } catch (e) {
    logger.warn('Failed to increment post count in Redis', { error: e.message });
    return null;
  }
}

// ── Update Deal Post with Content Strategy Metadata ──
export async function recordPostMetadata(messageId, metadata) {
  try {
    await query(`
      UPDATE posted_deals
      SET content_strategy = $1,
          archetype = $2,
          ai_generated = $3,
          posting_slot = $4,
          revenue_multiplier = $5
      WHERE message_id = $6
    `, [
      metadata.strategy || 'standard',
      metadata.archetype || null,
      metadata.aiGenerated || false,
      metadata.slot || null,
      metadata.revenueMultiplier || 1.0,
      messageId,
    ]);
  } catch (e) {
    logger.warn('Failed to record post metadata', { error: e.message, messageId });
  }
}

// ── Content Type Decision ──
export function decideContentType(quota, currentCounts, slotConfig, revenuePacing) {
  const remaining = {
    deals: Math.max(0, quota.deals.target - (currentCounts.deals || 0)),
    digests: Math.max(0, quota.digests.target - (currentCounts.digests || 0)),
    engagement: Math.max(0, quota.engagement.target - (currentCounts.engagement || 0)),
    reposts: Math.max(0, quota.reposts.target - (currentCounts.reposts || 0)),
  };

  // Afternoon slump = engagement only
  if (slotConfig.label === 'afternoon_slump' && remaining.engagement > 0) {
    return { type: 'engagement', reason: 'afternoon_engagement_slot', priority: 'normal' };
  }

  // Morning = digest if we haven't done one
  if ((slotConfig.label === 'morning_rush' || slotConfig.label === 'mid_morning') && remaining.digests > 0) {
    return { type: 'digest', reason: 'morning_digest_window', priority: 'high' };
  }

  // Behind on revenue? Prioritize deals
  if (revenuePacing?.status === 'behind') {
    if (remaining.deals > 0) {
      return { type: 'deal', reason: 'revenue_recovery_deal', priority: 'high' };
    }
  }

  // Normal flow: deals first, then engagement, then reposts
  if (remaining.deals > 0) {
    return { type: 'deal', reason: 'standard_deal', priority: 'normal' };
  }

  if (remaining.engagement > 0) {
    return { type: 'engagement', reason: 'engagement_fill', priority: 'low' };
  }

  if (remaining.reposts > 0) {
    return { type: 'repost', reason: 'repost_fill', priority: 'low' };
  }

  if (remaining.digests > 0) {
    return { type: 'digest', reason: 'digest_fill', priority: 'normal' };
  }

  return { type: 'none', reason: 'quota_full', priority: 'skip' };
}

export {
  DAILY_REVENUE_TARGET,
  DAY_CONVERSION_MULTIPLIERS,
  HOURLY_SLOTS,
  BASE_CONTENT_QUOTA,
};
