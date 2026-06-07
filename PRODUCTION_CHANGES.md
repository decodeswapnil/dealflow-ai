# Production Changes - May 13, 2026

## Summary
System configured for production with active-hours-only operation and improved voice note generation.

---

## Changes Applied

### 1. Testing Mode Disabled ✅
**File**: `.env`
```
TESTING_MODE=false
```

**Impact**:
- System now respects active hours (7 AM - 11 PM IST)
- Production deal-score thresholds enforced:
  - Hot deals: score ≥ 6.5
  - Good deals: score ≥ 4.5
  - Average deals: score ≥ 3.0
- Category gates active (B/C tier categories need higher scores)
- No 24/7 posting - only during peak engagement hours

---

### 2. Sarvam Voice Note Threshold Lowered ✅
**File**: `shared/utils/sarvam-tts.js`

**Change**: `shouldSendVoiceNote()` threshold lowered from 7.5 to 4.0

**Trigger Criteria** (ANY one):
- Deal score ≥ 4.0 (was 7.5)
- Discount ≥ 60% (unchanged)

**Impact**: More deals will receive voice notes, increasing engagement

---

### 3. Story-Based Voice Script Generation ✅
**File**: `shared/utils/sarvam-tts.js`

**New Structure**: Hook → Buildup → Reveal → CTA (like Instagram Reels)

**Example Script**:
```
"दोस्तों आखिरकार मिल गया. इतने दिनों से मैं ऑफर के लिए वेट कर रहा था, 
आखिरकार Realme 14 Pro सिर्फ 25000 रुपये में मिल रहा है! 70 परसेंट की छूट! 
तो जिनको भी चाहिए फटाफट ऑर्डर कर लो!"
```

**Components**:
- **10 Hook variations**: "दोस्तों आखिरकार मिल गया", "यार सुनो क्या मिला मुझे", etc.
- **10 Buildup variations**: "इतने दिनों से मैं ऑफर के लिए वेट कर रहा था", etc.
- **10 CTA variations**: "तो जिनको भी चाहिए फटाफट ऑर्डर कर लो", etc.

---

### 4. Multiple Voice Models with Gender Awareness ✅
**File**: `shared/utils/sarvam-tts.js`

**Voice Pool** (8 voices total):
- **Male voices**: arvind, shubh, rahul, rohan
- **Female voices**: priya, ritu, neha, pooja

**Gender-Aware Scripts**:
- Male: "मैं...रहा था", "मैं...हो गया"
- Female: "मैं...रही थी", "मैं...हो गई"

**Selection**: Random gender + random voice from pool for variety

---

## Testing Results

### Threshold Test
✅ All 7 test cases passed
- Score 4.0 triggers voice note ✓
- Score 3.9 does not trigger ✓
- Discount ≥ 60% triggers regardless of score ✓

### Audio Generation Test
✅ 3 sample audio files generated successfully
- Deal 1 (iPhone): Male voice (rohan) - 535 KB
- Deal 2 (boAt): Female voice (ritu) - 566 KB
- Deal 3 (Noise): Male voice (rohan) - 573 KB

All scripts follow natural story flow with varied language.

---

## Production Status

### Services Running
```
✅ postgres (healthy)
✅ redis (healthy)
✅ deal-discovery (running)
✅ deal-analysis (running)
✅ telegram-posting (running)
✅ curated-lists (running)
✅ prometheus (running)
✅ grafana (running)
```

### Active Hours
System will post deals during: **7 AM - 11 PM IST**

Current time: 4:58 AM IST - System is in **standby mode** waiting for active hours.

---

## Next Steps

1. ✅ System is ready for production
2. ⏳ Waiting for active hours (starts at 7 AM IST)
3. 📊 Monitor Grafana dashboard: http://localhost:3000
4. 📈 Monitor Prometheus metrics: http://localhost:9090

---

## Files Modified

1. `.env` - TESTING_MODE=false
2. `shared/utils/sarvam-tts.js` - Voice script generation + threshold
3. `scratch/test-sarvam-threshold.js` - Threshold validation (new)
4. `scratch/test-sarvam-audio.js` - Audio generation test (new)

---

**Deployment Time**: May 13, 2026, 4:58 AM IST
**Status**: ✅ Production Ready
