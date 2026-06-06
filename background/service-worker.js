/**
 * GetPeek — Background Service Worker (single-file build)
 * Orchestrates transcript fetching, AI summarization, and caching.
 */

console.log('[GetPeek] Service worker starting...');

// ============================================================
// UTILITIES
// ============================================================

function fetchWithTimeout(url, options = {}, timeout = 15000) {
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
    limit: dailyLimit,
    warning: stats.requestsToday >= dailyLimit * 0.8,
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
// TRANSCRIPT FETCHER
// ============================================================

/**
 * Fetch transcript by scraping the YouTube watch page HTML.
 * This works because the page embeds ytInitialPlayerResponse
 * which contains caption track URLs. Unlike the Innertube API,
 * a simple GET to the watch page doesn't return 403.
 */
async function fetchTranscript(videoId) {
  try {
    console.log('[GetPeek] Fetching transcript for:', videoId);

    // Step 1: Fetch the YouTube watch page HTML
    const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const pageResponse = await fetchWithTimeout(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    }, 15000);

    if (!pageResponse.ok) {
      console.error('[GetPeek] Page fetch error:', pageResponse.status);
      return { error: `Failed to load video page (HTTP ${pageResponse.status}).` };
    }

    const html = await pageResponse.text();
    console.log('[GetPeek] Page fetched, length:', html.length);

    // Step 2: Extract ytInitialPlayerResponse from the page
    const playerData = extractPlayerResponse(html);
    if (!playerData) {
      return { error: 'Could not extract video data from the page.' };
    }

    console.log('[GetPeek] Playability:', playerData?.playabilityStatus?.status);

    if (playerData?.playabilityStatus?.status === 'ERROR' ||
        playerData?.playabilityStatus?.status === 'LOGIN_REQUIRED') {
      return { error: 'Video is unavailable or requires login.' };
    }

    if (playerData.videoDetails?.isLiveContent && playerData.videoDetails?.isLive) {
      return { error: 'Live streams cannot be summarized.' };
    }

    // Step 3: Get caption tracks
    const captionTracks = playerData?.captions
      ?.playerCaptionsTracklistRenderer
      ?.captionTracks;

    if (!captionTracks || captionTracks.length === 0) {
      return { error: 'No captions available for this video.' };
    }

    console.log('[GetPeek] Found', captionTracks.length, 'caption tracks');
    const track = pickBestTrack(captionTracks);
    if (!track) {
      return { error: 'No suitable captions found.' };
    }

    console.log('[GetPeek] Using track:', track.languageCode, track.kind || 'manual');

    // Step 4: Fetch the actual transcript XML/JSON
    const transcriptUrl = track.baseUrl + '&fmt=json3';
    const transcriptResponse = await fetchWithTimeout(transcriptUrl);

    if (!transcriptResponse.ok) {
      return { error: 'Failed to fetch video transcript.' };
    }

    const transcriptData = await transcriptResponse.json();
    const text = parseTranscriptEvents(transcriptData.events || []);

    if (!text || text.trim().length < 20) {
      return { error: 'Transcript is too short or empty.' };
    }

    console.log('[GetPeek] Transcript:', text.length, 'chars');
    const MAX_CHARS = 100000;
    const truncated = text.length > MAX_CHARS;

    return {
      transcript: truncated ? text.slice(0, MAX_CHARS) : text,
      language: track.languageCode,
      truncated
    };
  } catch (err) {
    console.error('[GetPeek] Transcript error:', err);
    if (err.name === 'AbortError') {
      return { error: 'Request timed out. Please try again.' };
    }
    return { error: 'Failed to fetch transcript. Please try again.' };
  }
}

/**
 * Extract ytInitialPlayerResponse JSON from YouTube page HTML.
 */
function extractPlayerResponse(html) {
  // Try var ytInitialPlayerResponse = {...};
  const patterns = [
    /var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var|<\/script>)/s,
    /ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var|<\/script>)/s
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      try {
        return JSON.parse(match[1]);
      } catch (e) {
        console.warn('[GetPeek] Failed to parse player response:', e.message);
      }
    }
  }

  // Fallback: try to find it in ytcfg or embedded script data
  const altMatch = html.match(/ytInitialPlayerResponse"\s*:\s*(\{.+?\})\s*,\s*"/s);
  if (altMatch && altMatch[1]) {
    try {
      return JSON.parse(altMatch[1]);
    } catch (e) {
      console.warn('[GetPeek] Failed to parse alt player response:', e.message);
    }
  }

  return null;
}

function pickBestTrack(tracks) {
  return tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr')
    || tracks.find(t => t.languageCode === 'en' && t.kind === 'asr')
    || tracks.find(t => t.languageCode.startsWith('en'))
    || tracks.find(t => t.kind !== 'asr')
    || tracks[0];
}

function parseTranscriptEvents(events) {
  return events
    .filter(e => e.segs)
    .map(e => e.segs.map(s => s.utf8 || '').join(''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  if (!apiKey) {
    return { error: 'No API key configured. Open GetPeek settings to add your Gemini API key.' };
  }

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

  try {
    console.log('[GetPeek] Calling Gemini', modelName, '...');
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, 30000);

    if (!response.ok) {
      const status = response.status;
      console.error('[GetPeek] Gemini HTTP error:', status);
      if (status === 401 || status === 403) {
        return { error: 'Invalid API key. Check your Gemini API key in GetPeek settings.' };
      }
      if (status === 429) {
        return { error: 'Gemini rate limit reached. Try again later.' };
      }
      return { error: `Gemini API error (${status}). Please try again.` };
    }

    const result = await response.json();
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error('[GetPeek] Gemini empty response:', JSON.stringify(result).slice(0, 500));
      return { error: 'Gemini returned an empty response.' };
    }

    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.summary) || !Array.isArray(parsed.topics)) {
      return { error: 'Gemini returned an unexpected format.' };
    }

    console.log('[GetPeek] Summary ready:', parsed.summary.length, 'points,', parsed.topics.length, 'topics');
    return { data: parsed };
  } catch (err) {
    console.error('[GetPeek] Gemini error:', err);
    if (err.name === 'AbortError') {
      return { error: 'Gemini request timed out. Try a shorter video.' };
    }
    if (err instanceof SyntaxError) {
      return { error: 'Failed to parse Gemini response.' };
    }
    return { error: 'Failed to connect to Gemini. Check your internet connection.' };
  }
}

// ============================================================
// MESSAGE HANDLER
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[GetPeek] Received message:', message.type);

  if (message.type === 'GET_SUMMARY') {
    handleGetSummary(message.videoId)
      .then(result => {
        console.log('[GetPeek] Sending response:', result.error || 'success');
        sendResponse(result);
      })
      .catch(err => {
        console.error('[GetPeek] Unhandled error:', err);
        sendResponse({ error: 'Something went wrong. Please try again.' });
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

async function handleGetSummary(videoId) {
  try {
    const cached = await getCachedSummary(videoId);
    if (cached) {
      console.log('[GetPeek] Cache hit for:', videoId);
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

    const transcriptResult = await fetchTranscript(videoId);
    if (transcriptResult.error) {
      return { error: transcriptResult.error };
    }

    const summaryResult = await summarizeWithGemini(
      transcriptResult.transcript,
      settings.geminiApiKey,
      settings.model
    );
    if (summaryResult.error) {
      return { error: summaryResult.error };
    }

    const data = {
      ...summaryResult.data,
      language: transcriptResult.language,
      truncated: transcriptResult.truncated || false
    };

    await setCachedSummary(videoId, data);
    return { data };
  } catch (err) {
    console.error('[GetPeek] Pipeline error:', err);
    return { error: 'Something went wrong. Please try again.' };
  }
}

console.log('[GetPeek] Service worker ready.');
