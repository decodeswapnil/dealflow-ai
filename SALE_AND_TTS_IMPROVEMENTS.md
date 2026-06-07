# Sale Awareness & TTS Improvements

## Summary
Fixed Sarvam API key exhaustion issues, added sale awareness system, and simplified voice script generation for better natural language output.

## Changes Made

### 1. Sarvam API Key Management Fix ✅
**File:** `shared/utils/sarvam-tts.js`

**Problem:** Keys were marked as exhausted after single failures, even when they were actually working.

**Solution:**
- Added intelligent key status tracking (active, rate_limited, failed)
- Implemented cooldown periods:
  - Rate-limited keys: 15 minutes cooldown
  - Failed keys: 1 hour cooldown
  - Temporary failures: retry up to 3 times
- Automatic key reactivation after cooldown expires
- Force reactivation of least recently failed key if all are on cooldown
- Detailed diagnostics logging for troubleshooting

**New Functions:**
- `getKeyStatus()` - Track individual key health
- `updateKeyStatus()` - Update based on API response
- `isKeyAvailable()` - Check if key can be used
- `getAvailableKeys()` - Get healthy keys for rotation
- `getKeyHealthStatus()` - Monitor all keys (exposed via `/sarvam-health` endpoint)
- `resetAllKeyStatuses()` - Manual recovery (exposed via `/sarvam-reset` endpoint)

### 2. Sale Awareness System ✅
**File:** `agents/telegram-posting/content-calendar.js`

**Added:**
- `KNOWN_SALES` array with major Indian e-commerce sales:
  - Republic Day Sale, Prime Day, Great Indian Festival
  - Diwali Sale, Black Friday, Year End Sale, etc.
- `getActiveSale()` - Detects if a sale is currently active
- `getSaleMultiplier()` - Adjusts posting frequency during sales

**File:** `agents/telegram-posting/index.js`

**Added:**
- Sale-specific hooks for each major sale event
- `SALE_HOOKS` - Dedicated hooks for Prime Day, Diwali, Black Friday, etc.
- `SALE_MOTIVATION` - Sale-specific motivation lines
- `getSaleAwareHook()` - Automatically uses sale hooks when active
- `getSaleAwareMotivation()` - Adds sale context to posts

**Benefits:**
- Posts automatically mention active sales
- Increased urgency during sale periods
- Better context for users

### 3. Simplified Voice Script Generation ✅
**File:** `shared/utils/sarvam-tts.js`

**Problem:** Over-engineered templates with complex sentence structures that didn't flow naturally in spoken Hindi.

**Solution:**
- Replaced complex multi-part templates with simple, complete sentences
- Each template is a full, grammatically correct sentence
- Natural flow for spoken Hindi/Hinglish
- 7 different styles: direct, personal, urgent, friendly, simple, excited, punchy

**Example Scripts:**
```
"Smartphone सिर्फ 15000 रुपये में! 40 परसेंट की छूट भी है. जल्दी से ले लो!"
"ये देखो, Laptop 45000 रुपये में मिल रहा है! पूरे 30 परसेंट ऑफ है. फटाफट ऑर्डर कर दो!"
"धमाका deal! Headphones अब सिर्फ 2000 रुपये! 50 परसेंट बचत होगी. स्टॉक जल्दी खत्म होगा!"
```

### 4. Monitoring Endpoints ✅
**File:** `agents/telegram-posting/index.js`

**New Endpoints:**
- `GET /sarvam-health` - Check status of all Sarvam API keys
  - Returns: healthy status, available/rate-limited/failed counts
  - Individual key diagnostics with cooldown timers
  
- `POST /sarvam-reset` - Manually reset all key statuses
  - Useful for recovery after temporary issues
  - Clears all cooldowns and failure counts

## Testing

### Sarvam Key Management Test
Run: `node scratch/test-sarvam-key-management.js`

**Results:**
- ✅ Key rotation works correctly
- ✅ Status tracking is accurate
- ✅ Cooldown logic functions properly
- ✅ Reset functionality works
- ✅ System handles multiple failure scenarios gracefully

### Sale Detection
Currently active sale (if any) will be automatically detected and used in posts.

To manually check: Call `getActiveSale()` from content-calendar.js

## Usage

### Check Sarvam Key Health
```bash
curl http://localhost:3004/sarvam-health
```

### Reset Sarvam Keys (if needed)
```bash
curl -X POST http://localhost:3004/sarvam-reset
```

### Monitor Sale Status
Sale detection is automatic. Check logs for:
```
"Using sale-aware hook for [sale name]"
```

## Benefits

1. **Reliability**: No more false "all keys exhausted" errors
2. **Efficiency**: Maximizes API key utilization with intelligent rotation
3. **Recovery**: Automatic reactivation after cooldown periods
4. **Visibility**: Better logging and monitoring endpoints
5. **Context**: Posts automatically adapt to active sales
6. **Quality**: More natural, grammatically correct voice scripts

## Next Steps (Optional)

1. Monitor `/sarvam-health` endpoint to track key usage patterns
2. Adjust cooldown periods if needed based on actual API limits
3. Add more sales to `KNOWN_SALES` array as they're announced
4. Fine-tune voice script templates based on user feedback

## Files Modified

1. `shared/utils/sarvam-tts.js` - Key management + voice scripts
2. `agents/telegram-posting/content-calendar.js` - Sale tracking
3. `agents/telegram-posting/index.js` - Sale-aware hooks + monitoring endpoints
4. `scratch/test-sarvam-key-management.js` - Test script (new)

## Deployment

All changes are backward compatible. No database migrations required.

Simply restart the telegram-posting agent:
```bash
docker-compose restart telegram-posting
```

Or if running locally:
```bash
# Stop current process
# Then restart
node agents/telegram-posting/index.js
```
