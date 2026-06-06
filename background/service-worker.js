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

const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const INNERTUBE_CONTEXT = {
  client: {
    clientName: 'WEB',
    clientVersion: '2.20250606.01.00'
  }
};

async function fetchTranscript(videoId) {
  try {
    console.log('[GetPeek] Fetching transcript for:', videoId);

    const playerResponse = await fetchWithTimeout(INNERTUBE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: INNERTUBE_CONTEXT,
        videoId: videoId
      })
    });

    if (!playerResponse.ok) {
      console.error('[GetPeek] Innertube HTTP error:', playerResponse.status);
      if (playerResponse.status === 429) {
        return { error: 'YouTube rate limit reached. Try again in a moment.' };
      }
      return { error: `Failed to fetch video info (HTTP ${playerResponse.status}).` };
    }

    const playerData = await playerResponse.json();
    console.log('[GetPeek] Playability:', playerData?.playabilityStatus?.status);

    if (playerData?.playabilityStatus?.status === 'ERROR') {
      return { error: 'Video is unavailable.' };
    }

    if (playerData.videoDetails?.isLiveContent && playerData.videoDetails?.isLive) {
      return { error: 'Live streams cannot be summarized.' };
    }

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
