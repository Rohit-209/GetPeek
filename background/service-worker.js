/**
 * GetPeek — Background Service Worker
 * Handles Gemini API summarization and caching.
 * Transcript fetching is done by the page-bridge.js (MAIN world).
 */

console.log('[GetPeek] Service worker starting...');

// ============================================================
// UTILITIES
// ============================================================

function fetchWithTimeout(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ============================================================
// CACHE
// ============================================================

const CACHE_PREFIX = 'cache_';
const DEFAULT_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

async function getSettings() {
  const result = await chrome.storage.local.get('settings');
  return result.settings || {};
}

async function getCachedSummary(videoId) {
  const key = CACHE_PREFIX + videoId;
  const result = await chrome.storage.local.get(key);
  const entry = result[key];
  if (!entry) return null;

  const settings = await getSettings();
  const maxAge = settings.cacheMaxAge || DEFAULT_CACHE_MAX_AGE;
  if (Date.now() - entry.cachedAt > maxAge) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry.data;
}

async function setCachedSummary(videoId, data) {
  const key = CACHE_PREFIX + videoId;
  await chrome.storage.local.set({
    [key]: { data, cachedAt: Date.now() }
  });
}

async function trackRequest() {
  const result = await chrome.storage.local.get('stats');
  const stats = result.stats || { requestsToday: 0, lastResetDate: '' };
  const today = new Date().toISOString().slice(0, 10);

  if (stats.lastResetDate !== today) {
    stats.requestsToday = 0;
    stats.lastResetDate = today;
  }
  stats.requestsToday++;
  await chrome.storage.local.set({ stats });

  const dailyLimit = 1500;
  return {
    count: stats.requestsToday,
    exceeded: stats.requestsToday >= dailyLimit
  };
}

async function getUsageStats() {
  const result = await chrome.storage.local.get('stats');
  const stats = result.stats || { requestsToday: 0, lastResetDate: '' };
  const today = new Date().toISOString().slice(0, 10);
  if (stats.lastResetDate !== today) {
    return { requestsToday: 0, lastResetDate: today };
  }
  return stats;
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX));
  if (cacheKeys.length > 0) {
    await chrome.storage.local.remove(cacheKeys);
  }
  return cacheKeys.length;
}

// ============================================================
// GEMINI API
// ============================================================

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';

const SUMMARY_PROMPT = `You are a YouTube video summarizer. Given a video transcript, produce a structured JSON response.

Rules:
- Summaries must be factual and based only on the transcript content
- Each bullet should be one clear, complete sentence
- Topics should be distinct (not overlapping)
- Depth ratings reflect how thoroughly the video covers each topic
- "shallow" = briefly mentioned or surface-level overview
- "moderate" = explained with some detail and examples
- "deep" = thoroughly explored with in-depth analysis, examples, or evidence

Respond with ONLY valid JSON in this exact format:
{
  "summary": [
    "First key point from the video.",
    "Second key point from the video.",
    "Third key point from the video."
  ],
  "topics": [
    {
      "name": "Topic Name",
      "depth": "shallow | moderate | deep",
      "context": "One sentence explaining what the video covers about this topic and how well it is explored."
    }
  ]
}

Produce 3-5 summary bullets and 3-8 topics.`;

async function summarizeWithGemini(transcript, apiKey, model) {
  const modelName = model || DEFAULT_MODEL;
  const url = `${GEMINI_BASE_URL}/${modelName}:generateContent?key=${apiKey}`;

  const truncationNote = transcript.length >= 100000
    ? '\n[TRANSCRIPT TRUNCATED — video is very long. Summarize based on available content.]'
    : '';

  const body = {
    contents: [{
      parts: [{
        text: `${SUMMARY_PROMPT}\n\nTRANSCRIPT:\n${transcript}${truncationNote}`
      }]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.3,
      maxOutputTokens: 1024
    }
  };

  console.log('[GetPeek] Calling Gemini', modelName, '...');
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 45000);

  if (!response.ok) {
    const status = response.status;
    console.error('[GetPeek] Gemini HTTP error:', status);
    if (status === 401 || status === 403) {
      throw new Error('Invalid API key. Check your Gemini API key in GetPeek settings.');
    }
    if (status === 429) {
      throw new Error('Gemini rate limit reached. Try again later.');
    }
    throw new Error(`Gemini API error (${status}).`);
  }

  const result = await response.json();
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    console.error('[GetPeek] Gemini empty response:', JSON.stringify(result).slice(0, 500));
    throw new Error('Gemini returned an empty response.');
  }

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.summary) || !Array.isArray(parsed.topics)) {
    throw new Error('Gemini returned an unexpected format.');
  }

  console.log('[GetPeek] Summary ready:', parsed.summary.length, 'points,', parsed.topics.length, 'topics');
  return parsed;
}

// ============================================================
// MESSAGE HANDLER
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[GetPeek] Message:', message.type);

  if (message.type === 'CHECK_CACHE') {
    getCachedSummary(message.videoId)
      .then(data => sendResponse(data ? { data } : null))
      .catch(() => sendResponse(null));
    return true;
  }

  if (message.type === 'SUMMARIZE') {
    handleSummarize(message)
      .then(sendResponse)
      .catch(err => {
        console.error('[GetPeek] Error:', err);
        sendResponse({ error: err.message || 'Something went wrong.' });
      });
    return true;
  }

  if (message.type === 'GET_STATS') {
    getUsageStats().then(sendResponse).catch(() => sendResponse({}));
    return true;
  }

  if (message.type === 'CLEAR_CACHE') {
    clearCache().then(count => sendResponse({ cleared: count })).catch(() => sendResponse({ cleared: 0 }));
    return true;
  }
});

async function handleSummarize({ videoId, transcript, language, truncated }) {
  // Check cache first
  const cached = await getCachedSummary(videoId);
  if (cached) {
    console.log('[GetPeek] Cache hit:', videoId);
    return { data: cached };
  }

  const settings = await getSettings();
  if (!settings.geminiApiKey) {
    return { error: 'No API key configured. Right-click the GetPeek icon → Options to add your Gemini API key.' };
  }

  const quota = await trackRequest();
  if (quota.exceeded) {
    return { error: 'Daily request limit reached. Summaries will resume tomorrow.' };
  }

  console.log('[GetPeek] Summarizing', transcript.length, 'chars for', videoId);

  const parsed = await summarizeWithGemini(transcript, settings.geminiApiKey, settings.model);

  const data = {
    ...parsed,
    language: language || 'en',
    truncated: truncated || false
  };

  await setCachedSummary(videoId, data);
  return { data };
}

console.log('[GetPeek] Service worker ready.');
