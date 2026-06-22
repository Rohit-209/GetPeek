/**
 * GetPeek — Background Service Worker
 * Sends YouTube URLs to Gemini for video summarization, with caching.
 */

console.log('[GetPeek] Service worker starting...');

async function getPanelMode() {
  const { settings } = await chrome.storage.local.get('settings');
  return (settings && settings.panelMode) || 'sidepanel';
}

async function openPanelAsPopup() {
  console.log('[GetPeek] Opening panel as popup window');
  const REQ_WIDTH = 440;
  const REQ_HEIGHT = 720;
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('sidepanel/sidepanel.html'),
    type: 'popup',
    state: 'normal',
    width: REQ_WIDTH,
    height: REQ_HEIGHT,
    top: 80,
    left: 100,
    focused: true
  });
  console.log('[GetPeek] Popup window created:', win?.id, win?.width + 'x' + win?.height, 'state=' + win?.state);
  // Arc ignores type:'popup' + sizing and opens a full window. Detect that and
  // fall back to a tab in the current window (Arc handles tabs cleanly).
  const ignoredSizing = win && (
    win.state === 'fullscreen' ||
    win.state === 'maximized' ||
    (typeof win.width === 'number' && win.width > REQ_WIDTH * 1.5)
  );
  if (ignoredSizing) {
    console.warn('[GetPeek] Browser ignored popup sizing — falling back to tab');
    chrome.windows.remove(win.id).catch(err => console.warn('[GetPeek] could not close oversized popup:', err));
    return openPanelAsTab();
  }
  return win;
}

async function openPanelAsTab() {
  console.log('[GetPeek] Opening panel as tab');
  return chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html') });
}

async function openPanel(tab) {
  const mode = await getPanelMode();
  console.log('[GetPeek] Open panel requested, mode =', mode);

  if (mode === 'popup') {
    return openPanelAsPopup().catch(err => {
      console.warn('[GetPeek] popup failed, falling back to tab:', err);
      return openPanelAsTab();
    });
  }

  if (mode === 'tab') {
    return openPanelAsTab().catch(err => console.warn('[GetPeek] tab open failed:', err));
  }

  try {
    if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
      await chrome.sidePanel.open({ windowId: tab?.windowId });
      console.log('[GetPeek] sidePanel.open resolved');
      return;
    }
    throw new Error('sidePanel API unavailable');
  } catch (err) {
    console.warn('[GetPeek] sidePanel.open failed, falling back to popup:', err);
    return openPanelAsPopup().catch(() => openPanelAsTab());
  }
}

// Disable Chrome's default "auto-open side panel on action click" so that
// chrome.action.onClicked always fires and our handler decides what to do.
// Without this, Arc swallows the click trying to open the manifest-declared
// side panel — but never actually renders any UI.
try {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false })
    .then(() => console.log('[GetPeek] setPanelBehavior(false) ok'))
    .catch(err => console.warn('[GetPeek] setPanelBehavior failed:', err));
} catch (err) {
  console.warn('[GetPeek] setPanelBehavior threw:', err);
}

chrome.action.onClicked.addListener((tab) => {
  console.log('[GetPeek] action.onClicked fired');
  openPanel(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({
      id: 'getpeek-open-panel',
      title: 'Open GetPeek panel',
      contexts: ['action']
    });
  } catch (err) {
    console.warn('[GetPeek] contextMenus.create failed:', err);
  }
});

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'getpeek-open-panel') openPanel(tab);
  });
}

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
// SIDE PANEL HISTORY + BADGE
// ============================================================

const HISTORY_LIMIT = 50;
let unseenCount = 0;
const enrolled = new Map();

async function getHistory() {
  const { history } = await chrome.storage.local.get('history');
  return Array.isArray(history) ? history : [];
}

async function upsertHistory(entry) {
  const history = await getHistory();
  const idx = history.findIndex(h => h.videoId === entry.videoId);
  if (idx >= 0) {
    history[idx] = { ...history[idx], ...entry };
  } else {
    history.unshift(entry);
  }
  while (history.length > HISTORY_LIMIT) history.pop();
  await chrome.storage.local.set({ history });
  broadcastHistory(history);
  return history;
}

function broadcastHistory(history) {
  chrome.runtime.sendMessage({ type: 'HISTORY_UPDATED', history }).catch(() => {});
}

async function markCompleted(videoId, data, title) {
  await upsertHistory({
    videoId,
    title,
    status: 'done',
    data,
    completedAt: Date.now()
  });
  unseenCount++;
  chrome.action.setBadgeText({ text: String(unseenCount) }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' }).catch(() => {});
}

async function markError(videoId, error, title) {
  await upsertHistory({
    videoId,
    title,
    status: 'error',
    error,
    completedAt: Date.now()
  });
}

async function markLoading(videoId, title) {
  await upsertHistory({
    videoId,
    title,
    status: 'loading',
    startedAt: Date.now()
  });
}

function resetBadge() {
  unseenCount = 0;
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
}

// ============================================================
// GEMINI API
// ============================================================

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

const SUMMARY_PROMPT = `You are a YouTube video summarizer. Watch the provided video and produce a structured JSON response.

Rules:
- Summaries must be factual and based only on the video content
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

async function summarizeWithGemini(videoId, apiKey, model) {
  const modelName = model || DEFAULT_MODEL;
  const url = `${GEMINI_BASE_URL}/${modelName}:generateContent?key=${apiKey}`;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const body = {
    contents: [{
      parts: [
        {
          fileData: { fileUri: videoUrl },
          videoMetadata: { fps: 0.5 }
        },
        { text: SUMMARY_PROMPT }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.3,
      maxOutputTokens: 4096,
      mediaResolution: 'MEDIA_RESOLUTION_LOW',
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  console.log('[GetPeek] Calling Gemini', modelName, '...');
  const RETRY_DELAYS_MS = [1000, 3000];
  let response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, 120000);
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('Video took too long to process. Try a shorter video.');
      }
      throw err;
    }
    if (response.ok) break;
    // Retry transient server errors (overloaded / unavailable / gateway).
    if ([500, 502, 503, 504].includes(response.status) && attempt < RETRY_DELAYS_MS.length) {
      console.warn('[GetPeek] Gemini', response.status, '— retrying in', RETRY_DELAYS_MS[attempt], 'ms');
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    break;
  }

  if (!response.ok) {
    const status = response.status;
    const errBody = await response.text().catch(() => '');
    console.error('[GetPeek] Gemini HTTP error:', status, errBody.slice(0, 500));
    if (status === 401 || status === 403) {
      throw new Error('Invalid API key. Check your Gemini API key in GetPeek settings.');
    }
    if (status === 429) {
      throw new Error('Gemini rate limit reached. Try again later.');
    }
    if (status === 400) {
      throw new Error('Gemini rejected this video. It may be private, restricted, or unsupported.');
    }
    if ([500, 502, 503, 504].includes(status)) {
      throw new Error('Gemini is overloaded. Try again in a moment.');
    }
    throw new Error(`Gemini API error (${status}).`);
  }

  const result = await response.json();
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    console.error('[GetPeek] Gemini empty response:', JSON.stringify(result).slice(0, 500));
    throw new Error('Gemini returned an empty response.');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const finishReason = result?.candidates?.[0]?.finishReason;
    console.error('[GetPeek] JSON parse failed. finishReason:', finishReason, 'tail:', text.slice(-200));
    if (finishReason === 'MAX_TOKENS') {
      throw new Error('Summary too long for token limit. Try again.');
    }
    throw new Error('Gemini returned malformed JSON.');
  }
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

  if (message.type === 'SUMMARIZE') {
    handleSummarize(message)
      .then(sendResponse)
      .catch(err => {
        console.error('[GetPeek] Error:', err);
        sendResponse({ error: err.message || 'Something went wrong.' });
      });
    return true;
  }

  if (message.type === 'ENROLL_HISTORY') {
    enrolled.set(message.videoId, message.title || '');
    markLoading(message.videoId, message.title).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'GET_HISTORY') {
    getHistory().then(sendResponse);
    return true;
  }

  if (message.type === 'RESET_BADGE') {
    resetBadge();
    sendResponse({ ok: true });
    return false;
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

async function handleSummarize({ videoId, title }) {
  const recordWith = (data, errMsg) => {
    if (!enrolled.has(videoId)) return Promise.resolve();
    const t = enrolled.get(videoId) || title;
    enrolled.delete(videoId);
    return errMsg ? markError(videoId, errMsg, t) : markCompleted(videoId, data, t);
  };

  const cached = await getCachedSummary(videoId);
  if (cached) {
    console.log('[GetPeek] Cache hit:', videoId);
    await recordWith(cached, null);
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

  console.log('[GetPeek] Summarizing video:', videoId);

  try {
    const parsed = await summarizeWithGemini(videoId, settings.geminiApiKey, settings.model);
    await setCachedSummary(videoId, parsed);
    await recordWith(parsed, null);
    return { data: parsed };
  } catch (err) {
    await recordWith(null, err.message || 'Failed.');
    throw err;
  }
}

console.log('[GetPeek] Service worker ready.');
