import { createLogger } from '../../shared/utils/logger.js';
import { query } from '../../shared/utils/db.js';
import redis from '../../shared/utils/redis.js';

const logger = createLogger('ab-testing');

/**
 * A/B Testing Engine — Data-Driven Content Optimization
 * Tests caption variants, posting times, and archetype effectiveness.
 */

const REDIS_PREFIX = 'ab_test:';

// ── Experiment Registry ──
const ACTIVE_EXPERIMENTS = {
  // Caption tone test: AI vs template
  'caption_source': {
    id: 'caption_source',
    name: 'AI vs Template Caption',
    description: 'Test whether AI-generated captions outperform template-based captions',
    variants: ['ai', 'template'],
    weights: [0.7, 0.3], // 70% AI, 30% template (gradual migration)
    metric: 'click_through_rate',
    minSampleSize: 100,
    enabled: true,
  },
  // Archetype effectiveness
  'archetype_urgency': {
    id: 'archetype_urgency',
    name: 'Urgency Archetype Test',
    description: 'Test if urgency_drop archetype drives more clicks than data_nerd for high-discount deals',
    variants: ['urgency_drop', 'data_nerd'],
    weights: [0.5, 0.5],
    metric: 'click_through_rate',
    minSampleSize: 50,
    enabled: false, // Enable manually after initial AI rollout
  },
  // CTA style test
  'cta_style': {
    id: 'cta_style',
    name: 'CTA Urgency Test',
    description: 'Test "Check if still available" vs "Buy Now" CTA language',
    variants: ['soft_cta', 'hard_cta'],
    weights: [0.6, 0.4],
    metric: 'click_through_rate',
    minSampleSize: 80,
    enabled: false,
  },
  // Posting time test
  'posting_time': {
    id: 'posting_time',
    name: 'Evening vs Night Posting',
    description: 'Test 6PM vs 9PM posting for conversion',
    variants: ['evening_6pm', 'night_9pm'],
    weights: [0.5, 0.5],
    metric: 'revenue_per_post',
    minSampleSize: 40,
    enabled: false,
  },
  // Digest format test
  'digest_format': {
    id: 'digest_format',
    name: 'Digest AI vs Template',
    description: 'Test AI-generated digest captions vs template digests',
    variants: ['ai_digest', 'template_digest'],
    weights: [0.5, 0.5],
    metric: 'click_through_rate',
    minSampleSize: 30,
    enabled: false,
  },
};

// ── Variant Assignment ──
export function assignVariant(experimentId, dealId = null) {
  const experiment = ACTIVE_EXPERIMENTS[experimentId];
  if (!experiment || !experiment.enabled) {
    return { variant: experiment?.variants?.[0] || 'control', assigned: false, reason: 'experiment_disabled' };
  }

  // Deterministic assignment based on dealId or random
  const seed = dealId || Math.random().toString(36).substring(2, 10);
  const hash = hashString(seed + experimentId);
  const normalized = hash / 0xFFFFFFFF;

  let cumulative = 0;
  for (let i = 0; i < experiment.variants.length; i++) {
    cumulative += experiment.weights[i];
    if (normalized <= cumulative) {
      return {
        variant: experiment.variants[i],
        assigned: true,
        experimentId,
        reason: 'randomized_assignment',
      };
    }
  }

  return { variant: experiment.variants[experiment.variants.length - 1], assigned: true, experimentId };
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

// ── Record Assignment ──
export async function recordAssignment(postId, experimentId, variant) {
  try {
    await query(`
      INSERT INTO ab_test_assignments (post_id, experiment_id, variant, assigned_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (post_id, experiment_id) DO NOTHING
    `, [postId, experimentId, variant]);
  } catch (e) {
    logger.warn('Failed to record A/B assignment', { error: e.message, postId, experimentId });
  }
}

// ── Get Results ──
export async function getExperimentResults(experimentId, days = 14) {
  try {
    const result = await query(`
      SELECT
        a.variant,
        COUNT(*) as sample_size,
        COALESCE(AVG(p.clicks), 0) as avg_clicks,
        COALESCE(AVG(p.estimated_revenue), 0) as avg_revenue,
        COALESCE(SUM(p.clicks), 0) as total_clicks,
        COALESCE(SUM(p.estimated_revenue), 0) as total_revenue,
        COALESCE(
          (SUM(p.clicks) * 1.0 / NULLIF(COUNT(DISTINCT p.message_id), 0)),
          0
        ) as click_through_rate
      FROM ab_test_assignments a
      JOIN posted_deals p ON a.post_id = p.message_id
      WHERE a.experiment_id = $1
        AND a.assigned_at >= NOW() - INTERVAL '${days} days'
      GROUP BY a.variant
      ORDER BY avg_revenue DESC
    `, [experimentId]);

    const variants = result.rows;
    const experiment = ACTIVE_EXPERIMENTS[experimentId];

    if (!experiment || variants.length < 2) {
      return { variants, ready: false, reason: 'insufficient_variants' };
    }

    // Check sample size
    const totalSamples = variants.reduce((sum, v) => sum + parseInt(v.sample_size), 0);
    const ready = totalSamples >= experiment.minSampleSize;

    // Calculate confidence (simple approach)
    const winner = variants[0]; // Highest avg_revenue
    const improvement = variants.length > 1
      ? ((parseFloat(winner.avg_revenue) - parseFloat(variants[1].avg_revenue)) / parseFloat(variants[1].avg_revenue || 1) * 100)
      : 0;

    return {
      variants,
      totalSamples,
      ready,
      winner: ready ? winner.variant : null,
      improvement: ready ? Math.round(improvement * 100) / 100 : null,
      metric: experiment.metric,
    };
  } catch (e) {
    logger.error('Failed to get experiment results', { error: e.message, experimentId });
    return { variants: [], ready: false, error: e.message };
  }
}

// ── Caption Variant Generator ──
export async function generateCaptionVariant(deal, experimentAssignments, baseCaption = null) {
  // If no experiments active, return base
  if (!experimentAssignments || experimentAssignments.length === 0) {
    return { caption: baseCaption, metadata: {} };
  }

  const metadata = {};
  let caption = baseCaption;

  for (const assignment of experimentAssignments) {
    metadata[assignment.experimentId] = assignment.variant;

    switch (assignment.experimentId) {
      case 'cta_style':
        if (caption) {
          caption = modifyCTA(caption, assignment.variant);
        }
        break;
      // Add more experiment-specific modifications here
    }
  }

  return { caption, metadata };
}

function modifyCTA(caption, variant) {
  if (!caption) return caption;

  if (variant === 'soft_cta') {
    return caption
      .replace(/BUY NOW/gi, 'Check it out')
      .replace(/👉 Buy Now/gi, '👉 Check it out')
      .replace(/Grab it now/gi, 'Take a look');
  }

  if (variant === 'hard_cta') {
    return caption
      .replace(/Check it out/gi, 'BUY NOW')
      .replace(/👉 Check it out/gi, '👉 Buy Now')
      .replace(/Take a look/gi, 'Grab it now');
  }

  return caption;
}

// ── Auto-Optimize Weights ──
export async function autoOptimizeWeights() {
  for (const [id, experiment] of Object.entries(ACTIVE_EXPERIMENTS)) {
    if (!experiment.enabled) continue;

    const results = await getExperimentResults(id, 14);
    if (!results.ready || !results.winner) {
      logger.info(`Experiment ${id} not ready for optimization`, { samples: results.totalSamples });
      continue;
    }

    // Gradually shift weight toward winner (max 80% to avoid exploitation-only)
    const winnerIdx = experiment.variants.indexOf(results.winner);
    const newWeights = experiment.variants.map((_, i) =>
      i === winnerIdx ? 0.8 : 0.2 / (experiment.variants.length - 1)
    );

    // Update weights
    experiment.weights = newWeights;
    logger.info(`Optimized experiment ${id} weights`, {
      winner: results.winner,
      improvement: results.improvement,
      newWeights,
    });

    // Store in Redis for persistence
    try {
      await redis.setex(`${REDIS_PREFIX}weights:${id}`, 86400 * 30, JSON.stringify(newWeights));
    } catch (e) {
      logger.warn('Failed to store optimized weights', { error: e.message });
    }
  }
}

// ── Metrics Recording ──
export async function recordClickMetrics(messageId, clicks = 1) {
  try {
    // Update posted_deals clicks
    await query(`
      UPDATE posted_deals
      SET clicks = clicks + $1,
          last_click_at = NOW()
      WHERE message_id = $2
    `, [clicks, messageId]);

    // Recalculate estimated revenue based on clicks and category
    await query(`
      UPDATE posted_deals
      SET estimated_revenue = (
        SELECT CASE
          WHEN category ILIKE '%fashion%' OR category ILIKE '%luggage%' THEN clicks * 0.095 * COALESCE(final_price, deal_price) * 0.02
          WHEN category ILIKE '%home%' OR category ILIKE '%kitchen%' THEN clicks * 0.075 * COALESCE(final_price, deal_price) * 0.02
          WHEN category ILIKE '%beauty%' OR category ILIKE '%grooming%' THEN clicks * 0.065 * COALESCE(final_price, deal_price) * 0.02
          WHEN category ILIKE '%electronics%' OR category ILIKE '%headphone%' THEN clicks * 0.03 * COALESCE(final_price, deal_price) * 0.02
          WHEN category ILIKE '%mobile%' OR category ILIKE '%laptop%' THEN clicks * 0.015 * COALESCE(final_price, deal_price) * 0.02
          ELSE clicks * 0.05 * COALESCE(final_price, deal_price) * 0.02
        END
      )
      WHERE message_id = $1
    `, [messageId]);
  } catch (e) {
    logger.warn('Failed to record click metrics', { error: e.message, messageId });
  }
}

// ── Weekly Report ──
export async function generateWeeklyReport() {
  try {
    const result = await query(`
      SELECT
        DATE_TRUNC('week', time) as week,
        COUNT(*) as total_posts,
        COALESCE(SUM(clicks), 0) as total_clicks,
        COALESCE(SUM(estimated_revenue), 0) as total_revenue,
        COALESCE(AVG(clicks), 0) as avg_clicks_per_post,
        COALESCE(AVG(estimated_revenue), 0) as avg_revenue_per_post,
        COUNT(DISTINCT CASE WHEN ai_generated THEN message_id END) as ai_posts,
        COUNT(DISTINCT CASE WHEN NOT ai_generated THEN message_id END) as template_posts
      FROM posted_deals
      WHERE time >= NOW() - INTERVAL '30 days'
      GROUP BY DATE_TRUNC('week', time)
      ORDER BY week DESC
    `);

    const archetypeResult = await query(`
      SELECT
        archetype,
        COUNT(*) as posts,
        COALESCE(AVG(clicks), 0) as avg_clicks,
        COALESCE(AVG(estimated_revenue), 0) as avg_revenue
      FROM posted_deals
      WHERE time >= NOW() - INTERVAL '14 days'
        AND archetype IS NOT NULL
      GROUP BY archetype
      ORDER BY avg_revenue DESC
    `);

    return {
      weekly: result.rows,
      byArchetype: archetypeResult.rows,
      experiments: await Promise.all(
        Object.entries(ACTIVE_EXPERIMENTS)
          .filter(([_, e]) => e.enabled)
          .map(async ([id, _]) => await getExperimentResults(id, 14))
      ),
    };
  } catch (e) {
    logger.error('Failed to generate weekly report', { error: e.message });
    return { weekly: [], byArchetype: [], experiments: [] };
  }
}

export { ACTIVE_EXPERIMENTS };
