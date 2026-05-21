/**
 * Sarvam TTS — Hindi/Hinglish voice note generator for urgent deal alerts.
 *
 * Used only for "hot" and "good" deals valued at ₹999+.
 * Rotates through multiple API keys to avoid rate limits.
 *
 * API: https://api.sarvam.ai/text-to-speech
 * Model: bulbul:v3 (latest, 30+ voices, temperature control)
 * Voice: priya (female, natural Hindi)
 * Output: base64-encoded WAV → Buffer → sent as Telegram voice note
 */

import axios from 'axios';
import { createLogger } from './logger.js';
import { callAI } from './ai-client.js';

const logger = createLogger('sarvam-tts');

// Rotate keys round-robin to distribute load across all keys
const getKeys = () =>
  (process.env.SARVAM_API_KEY || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

// callIndex used for round-robin key selection across calls
let callIndex = 0;

/**
 * Key status tracking for intelligent rotation
 * Each key tracks:
 *   - status: 'active' | 'rate_limited' | 'failed'
 *   - lastFailure: timestamp
 *   - failureCount: number of consecutive failures
 *   - cooldownUntil: when rate-limited key can be retried
 */
const keyStatuses = new Map();

/**
 * Constants for key health management
 */
const MAX_CONSECUTIVE_FAILURES = 3;  // Mark key failed after this many consecutive failures
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;  // 15 minutes cooldown for rate-limited keys
const FAILURE_COOLDOWN_MS = 60 * 60 * 1000;      // 1 hour cooldown for failed keys

/**
 * Get or create key status
 */
function getKeyStatus(key) {
  const keyId = key.slice(-8); // Use last 8 chars as key identifier
  
  if (!keyStatuses.has(keyId)) {
    keyStatuses.set(keyId, {
      status: 'active',
      lastFailure: 0,
      failureCount: 0,
      cooldownUntil: 0,
      lastSuccess: 0,
      totalUses: 0,
    });
  }
  
  return keyStatuses.get(keyId);
}

/**
 * Update key status based on API response
 */
function updateKeyStatus(key, status, errorType = null) {
  const keyStatus = getKeyStatus(key);
  const now = Date.now();
  
  if (status === 'success') {
    keyStatus.status = 'active';
    keyStatus.lastSuccess = now;
    keyStatus.failureCount = 0;
    keyStatus.cooldownUntil = 0;
    keyStatus.totalUses++;
    return;
  }
  
  keyStatus.lastFailure = now;
  keyStatus.failureCount++;
  
  if (errorType === 'rate_limit' || errorType === 429) {
    // Rate limited — put on cooldown but don't mark as failed immediately
    keyStatus.status = 'rate_limited';
    keyStatus.cooldownUntil = now + RATE_LIMIT_COOLDOWN_MS;
    logger.info(`Key ...${key.slice(-6)} rate limited, cooldown for ${RATE_LIMIT_COOLDOWN_MS/60000} min`);
  } else if (errorType === 'unauthorized') {
    // 401/403 — Invalid or expired key, mark as failed immediately
    keyStatus.status = 'failed';
    keyStatus.cooldownUntil = now + FAILURE_COOLDOWN_MS;
    logger.warn(`Key ...${key.slice(-6)} marked as failed (invalid/unauthorized)`);
  } else if (errorType === 'invalid') {
    // 400 Bad Request — client-side payload error, NOT a key problem
    keyStatus.status = 'active';
    logger.warn(`Key ...${key.slice(-6)} got 400 bad request — not blacklisting (client error)`);
  } else if (keyStatus.failureCount >= MAX_CONSECUTIVE_FAILURES) {
    // Too many failures — mark as failed
    keyStatus.status = 'failed';
    keyStatus.cooldownUntil = now + FAILURE_COOLDOWN_MS;
    logger.warn(`Key ...${key.slice(-6)} marked as failed after ${MAX_CONSECUTIVE_FAILURES} failures`);
  } else {
    // Temporary failure — keep as active but track failure
    keyStatus.status = 'active';
    logger.warn(`Key ...${key.slice(-6)} failure ${keyStatus.failureCount}/${MAX_CONSECUTIVE_FAILURES}`);
  }
}

/**
 * Check if a key is available to use
 */
function isKeyAvailable(key) {
  const keyStatus = getKeyStatus(key);
  
  if (keyStatus.status === 'active') return true;
  
  // Check if cooldown period has expired
  const now = Date.now();
  if (now > keyStatus.cooldownUntil) {
    // Reactivate key after cooldown
    keyStatus.status = 'active';
    keyStatus.failureCount = 0;
    logger.info(`Key ...${key.slice(-6)} reactivated after cooldown`);
    return true;
  }
  
  return false;
}

/**
 * Get available keys, prioritizing healthy keys
 */
function getAvailableKeys() {
  const keys = getKeys();
  if (keys.length === 0) return [];
  
  // First, try keys that are currently available
  const available = keys.filter(isKeyAvailable);
  
  if (available.length > 0) {
    return available;
  }
  
  // If all keys are on cooldown, force reactivate the one with shortest remaining cooldown
  logger.warn('All keys on cooldown, forcing reactivation of least recently failed key');
  const sortedByCooldown = [...keys].sort((a, b) => {
    const statusA = getKeyStatus(a);
    const statusB = getKeyStatus(b);
    return statusA.cooldownUntil - statusB.cooldownUntil;
  });
  
  // Reset status for the key with shortest cooldown
  const keyToReset = sortedByCooldown[0];
  const status = getKeyStatus(keyToReset);
  status.status = 'active';
  status.failureCount = 0;
  status.cooldownUntil = 0;
  
  return [keyToReset];
}

/**
 * Generate a voice note script for an urgent deal using the AI client.
 * Kept short — Telegram voice notes work best under 30s (~200 chars of Hindi text).
 */
// Sanitize product title for TTS prompts - remove problematic chars
function sanitizeForTTS(text) {
  if (!text) return '';
  return String(text)
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f]/g, '') // Control chars
    .replace(/[|<>\{\}\[\]"]/g, ',')               // Structural chars to comma
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildVoiceScript(deal) {
  const price    = deal.finalPrice || deal.price;
  const mrp      = deal.mrp || deal.originalPrice;
  const discount = deal.discountPct || (mrp ? Math.round((1 - price / mrp) * 100) : 0);
  const title    = sanitizeForTTS(deal.title || '').substring(0, 50);

  // Extract semantic product name - clean and simple
  const semanticTitle = title
    .replace(/\([^)]*\)/g, '')
    .split(/[-,]/)[0]
    .trim()
    .substring(0, 30);

  // Simple, natural-sounding complete sentences
  // Each template is a full sentence that flows naturally in spoken Hindi
  const templates = [
    // Direct deal announcement
    `${semanticTitle} सिर्फ ${price} रुपये में! ${discount > 0 ? discount + ' परसेंट की छूट भी है' : ''}. जल्दी से ले लो!`,
    
    // Personal recommendation style
    `ये देखो, ${semanticTitle} ${price} रुपये में मिल रहा है! ${discount > 0 ? 'पूरे ' + discount + ' परसेंट ऑफ है' : ''}. फटाफट ऑर्डर कर दो!`,
    
    // Urgency style
    `धमाका deal! ${semanticTitle} अब सिर्फ ${price} रुपये! ${discount > 0 ? discount + ' परसेंट बचत होगी' : ''}. स्टॉक जल्दी खत्म होगा!`,
    
    // Friend suggestion style  
    `भाई ये मत miss करना! ${semanticTitle} ${price} रुपये में है! ${discount > 0 ? discount + ' परसेंट का discount' : ''}. अभी ले लो!`,
    
    // Simple announcement
    ` attention please! ${semanticTitle} ${price} रुपये में मिल रहा है! ${discount > 0 ? discount + ' परसेंट की बचत' : ''}. जल्दी करो!`,
    
    // Excited style
    `वाह! ${semanticTitle} सिर्फ ${price} रुपये! ${discount > 0 ? 'और ' + discount + ' परसेंट off' : ''}. ये deal बहुत अच्छी है!`,
    
    // Short and punchy
    `deal alert! ${semanticTitle} ${price} रुपये में! ${discount > 0 ? discount + ' परसेंट छूट' : ''}. अभी खरीदो!`,
  ];
  
  // Select random template
  const script = templates[Math.floor(Math.random() * templates.length)];
  
  // Randomly select voice gender for variety
  deal._voiceGender = Math.random() > 0.5 ? 'male' : 'female';
  
  return script;
}


/**
 * Convert text to speech using Sarvam API (bulbul:v3).
 * Returns a Buffer (WAV audio) or null if all keys fail.
 *
 * API format (from docs):
 *   POST https://api.sarvam.ai/text-to-speech
 *   Body: { text: string, target_language_code: string, speaker?: string, model?: string, pace?: number }
 *   Response: { audios: ["<base64>"] }
 *
 * bulbul:v3 notes:
 *   - pitch, loudness, enable_preprocessing are NOT supported
 *   - pace range: 0.5 to 2.0
 *   - temperature range: 0.01 to 2.0 (default 0.6)
 *   - valid speakers: shubh, aditya, ritu, priya, neha, rahul, pooja, rohan, etc.
 *
 * @param {string} text - Text to speak
 * @returns {Promise<Buffer|null>}
 */
export async function textToSpeech(text, voiceGender = 'female') {
  const keys = getAvailableKeys();
  if (keys.length === 0) {
    logger.warn('No Sarvam API keys configured');
    return null;
  }

  // Select voice based on gender - multiple options for variety
  const maleVoices = ['arvind', 'shubh', 'rahul', 'rohan'];
  const femaleVoices = ['priya', 'ritu', 'neha', 'pooja'];
  
  const voicePool = voiceGender === 'male' ? maleVoices : femaleVoices;
  const speaker = voicePool[Math.floor(Math.random() * voicePool.length)];

  // Guard: prevent burning API keys on bad payloads
  if (typeof text !== 'string' || text.length === 0) {
    logger.error('textToSpeech called with invalid text — aborting before hitting API keys', {
      type: typeof text,
      textPreview: String(text).substring(0, 50),
    });
    return null;
  }

  // Round-robin: each call starts from a different key, but tries ALL available keys
  const startIndex = callIndex % keys.length;
  callIndex++;

  let lastError = null;
  let attemptedKeys = 0;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = keys[(startIndex + attempt) % keys.length];
    attemptedKeys++;
    
    try {
      const res = await axios.post(
        'https://api.sarvam.ai/text-to-speech',
        {
          text,                              // string, NOT array
          target_language_code: 'hi-IN',
          speaker,                           // randomly selected voice matching gender
          model: 'bulbul:v3',                // latest model
          pace: 1.15,                        // slightly faster — energetic deal vibe
          temperature: 1.0,                  // Max allowed is 1.0 (increased for emotion)
          speech_sample_rate: 24000,          // default for v3
          // NOTE: pitch, loudness, enable_preprocessing are NOT supported in v3
        },
        {
          headers: {
            'api-subscription-key': key,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        }
      );

      // Response: { audios: [ "<base64 wav>" ] }
      const b64 = res.data?.audios?.[0];
      if (!b64) {
        logger.warn('Sarvam returned empty audio', { keyHint: key.slice(-6) });
        updateKeyStatus(key, 'failure', 'empty_response');
        continue;
      }

      // Success! Update key status and return audio
      updateKeyStatus(key, 'success');
      logger.info('Sarvam TTS success', { 
        speaker, 
        keyHint: key.slice(-6), 
        textLen: text.length,
        attempt: attempt + 1,
        totalKeys: keys.length 
      });
      return Buffer.from(b64, 'base64');
      
    } catch (e) {
      const status = e.response?.status;
      const errMsg = e.response?.data?.message || e.response?.data?.error || e.message;
      lastError = errMsg;
      
      // Determine error type for proper key status management
      let errorType = 'unknown';
      if (status === 429) {
        errorType = 'rate_limit';
      } else if (status === 401 || status === 403) {
        errorType = 'unauthorized';
      } else if (status === 400) {
        errorType = 'invalid';
      } else if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') {
        errorType = 'timeout';
      } else if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED') {
        errorType = 'network';
      }
      
      // Update key status based on error type
      updateKeyStatus(key, 'failure', errorType);
      
      logger.warn(`Sarvam key ...${key.slice(-6)} failed (attempt ${attempt + 1}/${keys.length}): ${errMsg}`, { 
        status,
        errorType,
        detail: JSON.stringify(e.response?.data)?.substring(0, 200),
      });
    }
  }

  // All keys failed — log detailed diagnostics
  const allKeys = getKeys();
  const keyDiagnostics = allKeys.map(k => {
    const status = getKeyStatus(k);
    return {
      hint: `...${k.slice(-6)}`,
      status: status.status,
      failures: status.failureCount,
      lastSuccess: status.lastSuccess ? new Date(status.lastSuccess).toISOString() : 'never',
      cooldownRemaining: status.cooldownUntil > Date.now() 
        ? Math.round((status.cooldownUntil - Date.now()) / 60000) + ' min' 
        : 'none',
    };
  });
  
  logger.error('All Sarvam keys failed for TTS', { 
    attemptedKeys,
    totalKeys: allKeys.length,
    lastError,
    keyDiagnostics,
    textLen: text.length 
  });
  
  return null;
}

/**
 * Get health status of all Sarvam API keys
 * Useful for monitoring and diagnostics
 */
export function getKeyHealthStatus() {
  const keys = getKeys();
  const now = Date.now();
  
  return keys.map(key => {
    const status = getKeyStatus(key);
    return {
      hint: `...${key.slice(-6)}`,
      status: status.status,
      failureCount: status.failureCount,
      totalUses: status.totalUses,
      lastSuccess: status.lastSuccess ? new Date(status.lastSuccess).toISOString() : null,
      lastFailure: status.lastFailure ? new Date(status.lastFailure).toISOString() : null,
      cooldownRemaining: status.cooldownUntil > now 
        ? Math.round((status.cooldownUntil - now) / 60000) 
        : 0,
      isAvailable: isKeyAvailable(key),
    };
  });
}

/**
 * Force reset all key statuses — useful for manual recovery
 */
export function resetAllKeyStatuses() {
  keyStatuses.clear();
  logger.info('All Sarvam key statuses reset');
}

/**
 * shouldSendVoiceNote — decides if a deal warrants a voice note.
 *
 * Criteria (ALL must be true):
 *  1. Verdict is 'hot' or 'good' (from deal-analysis scoring)
 *  2. Deal value ≥ ₹999 (voice notes only for meaningful purchases)
 *
 * This reduces Sarvam API usage to only high-value deals that justify
 * the voice note production cost and user attention.
 */
export function shouldSendVoiceNote(deal, score) {
  if (!process.env.SARVAM_API_KEY) return false;

  // TESTING MODE: always send voice notes when testing
  if (process.env.TESTING_MODE === 'true') return true;

  // Must be a hot or good deal (which covers all deals we post)
  const verdict = score?.verdict || deal?.verdict;
  if (verdict !== 'hot' && verdict !== 'good') {
    return false;
  }

  // --- Voice Note Price Threshold ---
  // Currently set to return true for ALL approved deals.
  // To restrict voice notes ONLY to deals over ₹999, uncomment the 2 lines below
  // and remove the "return true;" line.
  
  // const price = deal?.finalPrice || deal?.price || 0;
  // return price >= 999;
  
  return true;
}

