/**
 * GetPeek — YouTube Transcript Fetcher
 * Uses YouTube's Innertube Player API to fetch video captions.
 * No API key required — works from the extension's service worker.
 */

const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

const INNERTUBE_CONTEXT = {
  client: {
    clientName: 'WEB',
    clientVersion: '2.20250606.01.00'
  }
};

const FETCH_TIMEOUT = 15000; // 15 seconds

/**
 * Create a fetch call with a timeout.
 */
function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

/**
 * Fetch transcript text for a YouTube video.
 * @param {string} videoId - The YouTube video ID
 * @returns {Promise<{transcript: string, language: string} | {error: string}>}
 */
async function fetchTranscript(videoId) {
  try {
    // Step 1: Get caption track URLs from Innertube
    console.log('[GetPeek] Calling Innertube for video:', videoId);
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
      return { error: `Failed to fetch video information (HTTP ${playerResponse.status}).` };
    }

    const playerData = await playerResponse.json();
    console.log('[GetPeek] Innertube response received, playability:', playerData?.playabilityStatus?.status);

    // Check playability
    if (playerData?.playabilityStatus?.status === 'ERROR') {
      return { error: 'Video is unavailable.' };
    }

    // Check if video is a live stream
    if (playerData.videoDetails?.isLiveContent && playerData.videoDetails?.isLive) {
      return { error: 'Live streams cannot be summarized.' };
    }

    // Extract caption tracks
    const captionTracks = playerData?.captions
      ?.playerCaptionsTracklistRenderer
      ?.captionTracks;

    if (!captionTracks || captionTracks.length === 0) {
      return { error: 'No captions available for this video.' };
    }

    console.log('[GetPeek] Found', captionTracks.length, 'caption tracks');

    // Step 2: Pick the best caption track
    const track = pickBestTrack(captionTracks);
    if (!track) {
      return { error: 'No suitable captions found.' };
    }

    console.log('[GetPeek] Using caption track:', track.languageCode, track.kind || 'manual');

    // Step 3: Fetch the actual transcript
    const transcriptUrl = track.baseUrl + '&fmt=json3';
    const transcriptResponse = await fetchWithTimeout(transcriptUrl);

    if (!transcriptResponse.ok) {
      return { error: 'Failed to fetch video transcript.' };
    }

    const transcriptData = await transcriptResponse.json();

    // Step 4: Parse transcript events into plain text
    const text = parseTranscriptEvents(transcriptData.events || []);

    if (!text || text.trim().length < 20) {
      return { error: 'Transcript is too short or empty.' };
    }

    console.log('[GetPeek] Transcript length:', text.length, 'chars');

    // Truncate very long transcripts (4+ hour videos)
    const MAX_CHARS = 100000;
    const truncated = text.length > MAX_CHARS;
    const finalText = truncated ? text.slice(0, MAX_CHARS) : text;

    return {
      transcript: finalText,
      language: track.languageCode,
      truncated
    };
  } catch (err) {
    console.error('[GetPeek] Transcript fetch error:', err);
    if (err.name === 'AbortError') {
      return { error: 'Request timed out. Please try again.' };
    }
    return { error: 'Failed to fetch transcript. Please try again.' };
  }
}

/**
 * Pick the best caption track.
 * Priority: manual English > auto-generated English > manual any > auto any
 */
function pickBestTrack(tracks) {
  // Manual English
  const manualEn = tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr');
  if (manualEn) return manualEn;

  // Auto-generated English
  const autoEn = tracks.find(t => t.languageCode === 'en' && t.kind === 'asr');
  if (autoEn) return autoEn;

  // Any English variant (en-US, en-GB, etc.)
  const anyEn = tracks.find(t => t.languageCode.startsWith('en'));
  if (anyEn) return anyEn;

  // Manual in any language
  const manualAny = tracks.find(t => t.kind !== 'asr');
  if (manualAny) return manualAny;

  // Fall back to first available
  return tracks[0];
}

/**
 * Parse Innertube transcript events into plain text.
 */
function parseTranscriptEvents(events) {
  return events
    .filter(event => event.segs)
    .map(event => event.segs.map(seg => seg.utf8 || '').join(''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
