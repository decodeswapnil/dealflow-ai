/**
 * Shared AI Client — unified fallback chain for all agents.
 *
 * Priority order:
 *   1. Ollama         — local model (OLLAMA_HOST), zero cost, qwen2.5:7b default
 *   2. Replicate      — meta/meta-llama-3-8b-instruct (very cheap, fast)
 *   3. OpenRouter     — configurable model (OPENROUTER_MODEL)
 *   4. Google Gemini  — all keys in GEMINI_API_KEY (comma-separated), rotated
 *
 * Returns: { text, source, cost } or { text: null, source: 'none', cost: 'zero' }
 */

import axios from 'axios';
import { createLogger } from './logger.js';
import { isMemoryConstrained } from './system-monitor.js';

const logger = createLogger('ai-client');

// ── Retry helper with exponential backoff ───────────────────────────────────

async function withRetry(fn, { retries = 2, baseDelay = 1000, maxDelay = 10000, label = 'operation' } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await fn();
      if (result !== null && result !== undefined) return result;
      if (attempt < retries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        logger.warn(`${label} returned empty on attempt ${attempt + 1}, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (err) {
      lastError = err;
      const isRateLimit = err.response?.status === 429;
      if (isRateLimit && attempt < retries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt) * 2, maxDelay); // Extra delay for rate limits
        logger.warn(`${label} rate limited (429), retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else if (attempt < retries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        logger.warn(`${label} failed on attempt ${attempt + 1}: ${err.message}, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  logger.error(`${label} failed after ${retries + 1} attempts`, { error: lastError?.message });
  return null;
}

// ── Replicate helpers ──────────────────────────────────────────────────────

const REPLICATE_MODEL = process.env.REPLICATE_MODEL || 'meta/meta-llama-3-8b-instruct';  // $0.05/M in, cheap & capable
const REPLICATE_BASE = 'https://api.replicate.com/v1';

async function callReplicate(prompt, { maxTokens = 512, temperature = 0.75, timeout = 30000 } = {}) {
  const key = process.env.REPLICATE_API_KEY;
  if (!key) return null;

  return withRetry(async () => {
    // Create prediction — use `Prefer: wait` for synchronous response (up to 60s)
    const createRes = await axios.post(
      `${REPLICATE_BASE}/models/${REPLICATE_MODEL}/predictions`,
      {
        input: {
          prompt,
          max_new_tokens: maxTokens,
          temperature,
          top_p: 0.9,
          system_prompt: 'You are a helpful assistant. Respond concisely and directly.',
        },
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'wait',       // synchronous — wait up to 60s for output
        },
        timeout,
      }
    );

    // Synchronous response: output is already in the body
    const output = createRes.data?.output;
    if (output) {
      const text = Array.isArray(output) ? output.join('') : String(output);
      if (text.trim()) return text.trim();
    }

    // Async fallback: poll if we got a prediction ID back
    const predictionId = createRes.data?.id;
    if (!predictionId) return null;

    const pollDeadline = Date.now() + 25000; // max 25s polling
    while (Date.now() < pollDeadline) {
      await new Promise(r => setTimeout(r, 1500));
      const pollRes = await axios.get(`${REPLICATE_BASE}/predictions/${predictionId}`, {
        headers: { Authorization: `Bearer ${key}` },
        timeout: 8000,
      });
      const { status, output: pollOutput, error } = pollRes.data;
      if (error) throw new Error(error);
      if (status === 'succeeded' && pollOutput) {
        const text = Array.isArray(pollOutput) ? pollOutput.join('') : String(pollOutput);
        return text.trim() || null;
      }
      if (status === 'failed' || status === 'canceled') return null;
    }

    logger.warn('Replicate polling timed out');
    return null;
  }, { retries: 2, baseDelay: 1500, label: 'Replicate' });
}

// ── Gemini helpers ─────────────────────────────────────────────────────────

async function callGeminiKeys(prompt, { maxTokens = 512, temperature = 0.75 } = {}) {
  // Support comma-separated key list + optional dedicated fallback key
  const keys = [
    ...(process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean),
    ...(process.env.GEMINI_FALLBACK_KEY ? [process.env.GEMINI_FALLBACK_KEY.trim()] : []),
  ];
  if (keys.length === 0) return null;

  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  for (const key of keys) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature, maxOutputTokens: maxTokens, topP: 0.9 },
        },
        { timeout: 15000 }
      );

      // Check for safety blocks / empty candidates
      const candidates = res.data?.candidates;
      if (!candidates || candidates.length === 0) {
        const blockReason = res.data?.promptFeedback?.blockReason;
        if (blockReason) {
          logger.warn(`Gemini blocked: ${blockReason}`);
        }
        continue; // Try next key
      }

      const text = candidates[0]?.content?.parts?.[0]?.text;
      if (text?.trim()) return text.trim();
    } catch (e) {
      const status = e.response?.status;
      if (status === 429) {
        logger.warn(`Gemini key ...${key.slice(-6)} rate limited, will retry with backoff`);
      } else {
        logger.warn(`Gemini key ...${key.slice(-6)} failed: ${e.message}`);
      }
    }
  }
  return null;
}

// ── OpenRouter helper ──────────────────────────────────────────────────────

async function callOpenRouter(prompt, { maxTokens = 512, temperature = 0.75 } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;

  return withRetry(async () => {
    const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature,
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://dealdecode.in',
          'X-Title': 'DealDecode',
        },
        timeout: 20000,
      }
    );
    const text = res.data?.choices?.[0]?.message?.content;
    return text?.trim() || null;
  }, { retries: 2, baseDelay: 1000, label: 'OpenRouter' });
}

// ── Ollama helper ──────────────────────────────────────────────────────────

async function callOllama(prompt, { maxTokens = 512, temperature = 0.75 } = {}) {
  const host = process.env.OLLAMA_HOST;
  if (!host) return null;

  return withRetry(async () => {
    const model = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';
    const res = await axios.post(
      `${host}/api/generate`,
      {
        model,
        prompt,
        stream: false,
        context: [],        // Empty context = stateless, no history accumulation
        keep_alive: '5m',   // Unload model after 5min idle to free VRAM
        options: { num_predict: maxTokens, temperature },
      },
      { timeout: 60000 }
    );
    const text = res.data?.response;
    return text?.trim() || null;
  }, { retries: 1, baseDelay: 2000, label: 'Ollama' });
}

// ── Main exported function ─────────────────────────────────────────────────

/**
 * callAI(prompt, opts) — tries providers in priority order, returns first success.
 * With per-provider retry and overall fallback chain.
 * @param {string} prompt
 * @param {{ maxTokens?, temperature?, timeout? }} opts
 * @returns {{ text: string|null, source: string, cost: string }}
 */
export async function callAI(prompt, opts = {}) {
  const startTime = Date.now();
  let lastError;

  const bypassLocalModel = process.env.BYPASS_RAM_MANAGEMENT_AND_USE_LOCAL_MODEL === 'true';
  const isMemConstrained = isMemoryConstrained(0.9);

  // 1. Ollama (local, zero cost, with retry)
  if (bypassLocalModel || !isMemConstrained) {
    try {
      const ollamaText = await callOllama(prompt, opts);
      if (ollamaText) {
        logger.info('AI response from Ollama', { len: ollamaText.length, latency: Date.now() - startTime });
        return { text: ollamaText, source: 'ollama', cost: 'zero' };
      }
    } catch (e) {
      lastError = e;
      logger.warn('Ollama failed', { error: e.message });
    }
  } else {
    logger.warn('Skipping Ollama due to high RAM usage constraint. Falling back to cloud APIs.');
  }

  // 2. Replicate (Llama 3.1 8B — cheap and capable, with retry)
  try {
    const replicateText = await callReplicate(prompt, opts);
    if (replicateText) {
      logger.info('AI response from Replicate', { len: replicateText.length, latency: Date.now() - startTime });
      return { text: replicateText, source: 'replicate', cost: 'low' };
    }
  } catch (e) {
    lastError = e;
    logger.warn('Replicate failed', { error: e.message });
  }

  // 3. OpenRouter (with retry)
  try {
    const openRouterText = await callOpenRouter(prompt, opts);
    if (openRouterText) {
      logger.info('AI response from OpenRouter', { len: openRouterText.length, latency: Date.now() - startTime });
      return { text: openRouterText, source: 'openrouter', cost: 'medium' };
    }
  } catch (e) {
    lastError = e;
    logger.warn('OpenRouter failed', { error: e.message });
  }

  // 4. Gemini (all keys, rotating, with internal per-key retry)
  try {
    const geminiText = await callGeminiKeys(prompt, opts);
    if (geminiText) {
      logger.info('AI response from Gemini', { len: geminiText.length, latency: Date.now() - startTime });
      return { text: geminiText, source: 'gemini', cost: 'low' };
    }
  } catch (e) {
    lastError = e;
    logger.warn('Gemini chain failed', { error: e.message });
  }

  logger.error('All AI providers failed', { error: lastError?.message, latency: Date.now() - startTime });
  return { text: null, source: 'none', cost: 'zero' };
}
