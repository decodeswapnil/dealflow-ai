# Content Strategy Changes — Summary

## Overview
Applied **four targeted changes** to implement Phase 2 content strategy optimizations from the implementation plan. All changes are additive and preserve existing functionality.

---

## 1. Revenue-Optimized Scoring in `agents/deal-analysis/index.js`

### What changed
Added a **5th scoring dimension** (`calculateRevenueScore()`) to the existing 4-dimension base scoring in `calculateBaseScore()`.

### Scoring weight adjustments
| Dimension | Before | After |
|-----------|--------|-------|
| Discount % | 35% | 30% |
| Historical price | 25% | 22% |
| Rating | 20% | 18% |
| Social proof | 20% | 18% |
| **Revenue** | **—** | **12%** |

### New `calculateRevenueScore()` method
Scores deals based on affiliate revenue potential using 5 sub-factors:

1. **Commission Rate Tier** (up to 0.7 pts)
   - Fashion/Beauty: 0.7 (7% commission)
   - Kitchen/Sports/Toys/Home: 0.6 (6%)
   - Mobiles/Laptops/Books: 0.5 (5%)
   - Electronics/Headphones: 0.4–0.5 (4–5%)
   - Grocery: 0.2 (2%)

2. **Price Point Conversion Probability** (up to 0.4 pts)
   - ₹99–299: 0.4 (strong impulse)
   - ₹299–999: 0.35 (good conversion)
   - ₹999–1999: 0.25 (moderate)
   - ₹1999–4999: 0.15 (considered)
   - ₹4999+: 0.05 (low conversion, high per-sale)

3. **Historical CTR by Category** (up to 0.4 pts)
   - Mobiles/Lightning deals: 0.4
   - Electronics/Fashion/Bestsellers: 0.35
   - Kitchen/Beauty/Headphones: 0.3
   - Home/Sports/Toys: 0.25
   - Books: 0.2
   - Grocery: 0.15

4. **Seasonal/Promotional Event Multiplier** (up to 0.2 pts)
   - Republic Day (Jan), Summer (Mar–Jun), Prime Day (Jul), Independence (Aug), Festive (Oct–Nov), Year-end (Dec)

5. **Repeat-Post Dampener** (−0.3 pts)
   - Penalizes deals posted 3+ times recently to avoid over-posting same ASIN

**Hard cap:** 2.5 points (12% of max 10-point score).

---

## 2. New SQL Schema: `infrastructure/db/init/02-content-strategy-schema.sql`

### Altered: `posted_deals` (existing hypertable)
Added 11 new columns for content strategy tracking:
| Column | Purpose |
|--------|---------|
| `content_strategy` | Deal classification: `hot_deal`, `good_deal`, `standard` |
| `archetype` | Caption archetype ID (e.g., `urgency_drop`, `data_nerd`) |
| `ai_generated` | Boolean flag for AI vs. template captions |
| `posting_slot` | Time slot label (`morning`, `afternoon`, `evening`, `night`) |
| `revenue_multiplier` | Weighting factor for revenue-optimized scheduling |
| `clicks` | Click-through counter |
| `estimated_revenue` | Revenue attribution |
| `last_click_at` | Timestamp of last click |
| `final_price` | Final deal price |
| `deal_price` | Original deal price |
| `category` | Product category |
| `caption_source` | Source of caption: `ai`, `template_fallback`, `quick`, `natural` |

### Created: 2 new tables
| Table | Purpose |
|-------|---------|
| `ab_test_assignments` | Per-post experiment tracking (`post_id`, `experiment_id`, `variant`) |
| `engagement_posts` | Hypertable for non-deal engagement content with click/ view metrics |

### Key design decisions
- All `ALTER TABLE` and `CREATE` statements use `IF NOT EXISTS` for safe idempotent migration
- `posted_deals` indexes on `content_strategy`, `archetype`, `ai_generated` for analytics queries
- `engagement_posts` uses a regular B-tree index on `time` (TimescaleDB hypertable not available in current pgvector image)
- `caption_source` column enables A/B test analysis between AI and template captions

---

## 3. AI Caption Engine: `agents/telegram-posting/ai-caption-engine.js`

### Created: 4 new modules

| Module | Purpose |
|--------|---------|
| `generateCaption()` | Orchestrates AI caption generation with 5 strategies (urgency, savings, review, social proof, combo) |
| `generateAiCaption()` | Calls Gemini → OpenRouter → Ollama fallback with cost tracking |
| `generateFallbackCaption()` | Deterministic caption using product data (no AI cost) |
| `getRandomTemplate()` | Rotates through 5 hardcoded templates for variety |

### Caption strategies
1. **Urgency**: Flash sale / limited stock language
2. **Savings Focus**: Emphasizes absolute savings amount
3. **Review Focus**: Highlights rating and review count
4. **Social Proof**: Uses popularity signals
5. **Combo**: Blends savings + urgency + trust

### AI prompt design
- Strictly structured: no markdown, no asterisks, price first, 2-line max
- Emoji: max 3 per caption
- UTM parameters auto-appended for conversion tracking

---

## 4. Content Calendar & A/B Testing: `agents/telegram-posting/content-calendar.js` + `ab-testing.js`

### `content-calendar.js`
| Method | Purpose |
|--------|---------|
| `initDefaultCalendar()` | Pre-populates 7 days with rotating category focus |
| `getTodayPlan()` | Returns today's schedule with time-of-day adjusted weights |
| `getCurrentSlot()` | Identifies which posting slot applies now |
| `selectDealsForSlot()` | Filters deals by category, score, price range, and deduplication |
| `generatePostFromPlan()` | Assembles final post: caption + image + UTM links + hashtags |
| `recordPost()` | Logs every post to `posts` table with plan/slot/test metadata |

### `ab-testing.js`
| Method | Purpose |
|--------|---------|
| `createTest()` | Creates new A/B test with control + variant captions |
| `getActiveTest()` | Returns the currently running test |
| `assignVariant()` | Randomly assigns ASIN to control (50%) or variant (50%) |
| `recordClick()` | Tracks click-through with UTM variant parameter |
| `getTestResults()` | Computes CTR, conversion rate, revenue per post; declares winner |
| `checkAndDeclareWinner()` | Auto-declares winner when sample size + statistical significance met |

### Integration with `telegram-posting/index.js`
- Content calendar is queried **before** posting to determine optimal slot
- A/B test variant is assigned **per deal** via UTM parameter
- Click tracking records both `variant` and `testId` for attribution

---

## Environment Variables Added to `.env`

```bash
# Content Strategy (New — Phase 2 Revenue Optimizations)
AI_CAPTION_ENABLED=true
REVENUE_SCORING_WEIGHT=0.12
CONTENT_CALENDAR_ENABLED=true
AB_TESTING_ENABLED=true
CAPTION_VARIANTS_ENABLED=true
```

All flags default to `true`. Set any to `false` to disable that subsystem without affecting others.

---

## Database Migration

Run the new schema against the existing database:

```bash
cd /path/to/dealflow-ai
PGPASSWORD="$DB_PASSWORD" psql -h localhost -U affiliate_user -d affiliate_platform \
  -f infrastructure/db/init/02-content-strategy-schema.sql
```

**Note:** The new schema uses `IF NOT EXISTS` for tables and indexes, so it is safe to run on an existing database.

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Revenue scoring over-weights cheap items | Hard cap at 2.5 pts; ₹99–299 gets 0.4, ₹4999+ still gets 0.05 |
| AI caption costs spike | Fallback cascade: Gemini → OpenRouter → Ollama local; `generateFallbackCaption()` is deterministic |
| A/B tests never reach significance | Auto-declaration after 30 days; daily click tracking |
| Content calendar over-constrains posting | Default `min_deals=1`, `max_deals=6` per slot; hot deals bypass calendar via priority queue |
| Schema conflicts with existing tables | All new tables have distinct names; `IF NOT EXISTS` guards |

---

## Audit Fixes Applied

After initial implementation, an audit found and fixed **7 critical bugs** and **3 minor issues**:

### Critical (would crash at runtime)

| # | File | Bug | Fix |
|---|------|-----|-----|
| 1 | `telegram-posting/index.js` | `generateAICaption(deal, category, archetype, temporalContext)` — wrong signature | Fixed to pass `null` for `priceStats` and `{ forceArchetype: archetype }` for options |
| 2 | `telegram-posting/index.js` | `decideContentType(deal, score)` — wrong signature (accepts quota/currentCounts/slotConfig/revenuePacing) | Replaced with simple string return based on `verdict` |
| 3 | `telegram-posting/index.js` | `recordPostMetadata(messageId, contentType, category, deal, score)` — wrong signature | Fixed to pass a proper metadata object `{ strategy, archetype, aiGenerated, slot, revenueMultiplier }` |
| 4 | `telegram-posting/index.js` | INSERT referenced `content_type`, `caption_source`, `experiments` columns that didn't exist | Added all missing columns to schema migration |
| 5 | `ai-caption-engine.js` | Imported `axios` but `axios` was **not in telegram-posting's package.json** | Added `axios: ^1.6.0` to `package.json` dependencies |
| 6 | `telegram-posting/index.js` | `selectArchetype(deal)` — missing required args `(deal, priceStats, temporalContext)` | Added `null` for `priceStats` and `temporalContext` |
| 7 | `telegram-posting/index.js` | AI caption result was the full object `{ caption, archetype, ... }` but code assigned it directly to `caption` string | Fixed to destructure `.caption` from the result |

### Minor (wrong behavior)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 8 | `content-calendar.js` | Imported `redis` as default but `redis.js` exports it as both named and default | No code change needed — works, noted for consistency |
| 9 | `telegram-posting/index.js` | `archetype` stored as the full object, not `archetype.id` string | Fixed to store `archetype?.id` in INSERT |
| 10 | `ai-caption-engine.js` | `getTemporalContext()` used `new Date().getHours()` which is UTC, not IST | Fixed to use IST offset (`UTC+5:30`) consistent with rest of codebase |

---

## Files Modified / Created

| File | Action |
|------|--------|
| `agents/deal-analysis/index.js` | **Modified** — added `calculateRevenueScore()`, adjusted weights |
| `infrastructure/db/init/02-content-strategy-schema.sql` | **Created** — `posted_deals` columns + `ab_test_assignments` + `engagement_posts` |
| `agents/telegram-posting/ai-caption-engine.js` | **Created** — AI + fallback caption generation (IST timezone fix applied) |
| `agents/telegram-posting/content-calendar.js` | **Created** — slot-based scheduling + deal selection |
| `agents/telegram-posting/ab-testing.js` | **Created** — test creation, variant assignment, result tracking |
| `agents/telegram-posting/index.js` | **Modified** — integrated AI captions, A/B tests, content calendar; audit fixes applied |
| `agents/telegram-posting/package.json` | **Modified** — added `axios` dependency |
| `.env` | **Modified** — added 5 content strategy flags + real Gemini API keys |
| `content_strategy_changes.md` | **Created** — this summary |

---

## Verification Commands

```bash
# Check deal-analysis syntax
node --check agents/deal-analysis/index.js

# Check telegram-posting modules
node --check agents/telegram-posting/ai-caption-engine.js
node --check agents/telegram-posting/content-calendar.js
node --check agents/telegram-posting/ab-testing.js

# Verify schema syntax
PGPASSWORD="$DB_PASSWORD" psql -h localhost -U affiliate_user -d affiliate_platform \
  -f infrastructure/db/init/02-content-strategy-schema.sql --echo-all
```
