/**
 * GetPeek — Page Bridge (runs in YouTube's MAIN world)
 * Has access to YouTube's cookies and JS context.
 * Uses YouTube's get_transcript Innertube endpoint for reliable transcript fetching.
 */

(function () {
  'use strict';

  window.addEventListener('getpeek-fetch-transcript', async (event) => {
    const { videoId, requestId } = event.detail;

    try {
      console.log('[GetPeek Bridge] Fetching transcript for:', videoId);

      // Primary: use get_transcript Innertube endpoint (what YouTube's own UI uses)
      let transcript = null;
      let language = 'en';

      try {
        const result = await fetchViaGetTranscript(videoId);
        transcript = result.transcript;
        language = result.language || 'en';
        console.log('[GetPeek Bridge] get_transcript succeeded:', transcript.length, 'chars');
      } catch (e) {
        console.warn('[GetPeek Bridge] get_transcript failed:', e.message);
      }

      // Fallback: fetch watch page HTML and try caption URLs
      if (!transcript) {
        try {
          const result = await fetchViaWatchPage(videoId);
          if (result.error) {
            sendResult(requestId, videoId, null, result.error);
            return;
          }
          transcript = result.transcript;
          language = result.language || 'en';
        } catch (e) {
          console.warn('[GetPeek Bridge] Watch page fallback failed:', e.message);
        }
      }

      if (!transcript || transcript.trim().length < 20) {
        sendResult(requestId, videoId, null, 'Transcript is too short or empty.');
        return;
      }

      // Truncate very long transcripts
      const MAX_CHARS = 100000;
      const truncated = transcript.length > MAX_CHARS;
      const finalText = truncated ? transcript.slice(0, MAX_CHARS) : transcript;

      console.log('[GetPeek Bridge] Transcript ready:', finalText.length, 'chars');

      sendResult(requestId, videoId, {
        transcript: finalText,
        language,
        truncated
      }, null);

    } catch (err) {
      console.error('[GetPeek Bridge] Error:', err);
      sendResult(requestId, videoId, null, 'Failed to fetch transcript.');
    }
  });

  // ================================================================
  // PRIMARY: YouTube's get_transcript Innertube endpoint
  // ================================================================

  async function fetchViaGetTranscript(videoId) {
    const context = getInnertubeContext();
    if (!context) throw new Error('No Innertube context');

    const params = encodeTranscriptParams(videoId);
    console.log('[GetPeek Bridge] get_transcript params:', params);

    const headers = {
      'Content-Type': 'application/json',
    };

    // Add SAPISIDHASH auth if available
    const authHeader = await getSapiSidHash('https://www.youtube.com');
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }

    const apiKey = window.ytcfg?.get?.('INNERTUBE_API_KEY') || '';
    const url = `https://www.youtube.com/youtubei/v1/get_transcript${apiKey ? '?key=' + apiKey : ''}`;

    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context, params })
    });

    console.log('[GetPeek Bridge] get_transcript status:', resp.status);

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    console.log('[GetPeek Bridge] get_transcript response keys:', Object.keys(data));

    return parseGetTranscriptResponse(data);
  }

  function getInnertubeContext() {
    // Try ytcfg first (available on all YouTube pages)
    const ctx = window.ytcfg?.get?.('INNERTUBE_CONTEXT');
    if (ctx) return ctx;

    // Manual fallback
    const clientVersion = window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') || '2.20260601.00.00';
    return {
      client: {
        clientName: 'WEB',
        clientVersion
      }
    };
  }

  /**
   * Encode protobuf params for get_transcript endpoint.
   * Structure: { 1: { 1: videoId } }
   */
  function encodeTranscriptParams(videoId) {
    // Protobuf wire format:
    // Field 1, wire type 2 (length-delimited) = tag 0x0a
    // Inner field 1, wire type 2 = tag 0x0a
    const videoIdBytes = new TextEncoder().encode(videoId);
    const inner = new Uint8Array([0x0a, videoIdBytes.length, ...videoIdBytes]);
    const outer = new Uint8Array([0x0a, inner.length, ...inner]);
    return btoa(String.fromCharCode(...outer));
  }

  /**
   * Generate SAPISIDHASH authorization header.
   */
  async function getSapiSidHash(origin) {
    const match = document.cookie.match(/SAPISID=([^;]+)/);
    if (!match) {
      // Try __Secure-3PAPISID as fallback
      const secureMatch = document.cookie.match(/__Secure-3PAPISID=([^;]+)/);
      if (!secureMatch) return null;
      return computeSapiSidHash(secureMatch[1], origin);
    }
    return computeSapiSidHash(match[1], origin);
  }

  async function computeSapiSidHash(sapisid, origin) {
    const timestamp = Math.floor(Date.now() / 1000);
    const input = `${timestamp} ${sapisid} ${origin}`;
    const hashBuffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
    const hash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return `SAPISIDHASH ${timestamp}_${hash}`;
  }

  /**
   * Parse the get_transcript API response into plain text.
   */
  function parseGetTranscriptResponse(data) {
    // Response structure:
    // actions[0].updateEngagementPanelAction.content.transcriptRenderer
    //   .body.transcriptBodyRenderer.cueGroups[]
    //     .transcriptCueGroupRenderer.cues[]
    //       .transcriptCueRenderer.cue.simpleText

    const actions = data?.actions;
    if (!actions || actions.length === 0) {
      throw new Error('No transcript actions in response');
    }

    // Find the transcript renderer
    let cueGroups = null;
    for (const action of actions) {
      const renderer = action?.updateEngagementPanelAction
        ?.content?.transcriptRenderer;
      const body = renderer?.body?.transcriptBodyRenderer;
      if (body?.cueGroups) {
        cueGroups = body.cueGroups;
        break;
      }
    }

    // Also check for transcriptSearchPanelRenderer path
    if (!cueGroups) {
      for (const action of actions) {
        const segments = action?.updateEngagementPanelAction
          ?.content?.transcriptRenderer
          ?.body?.transcriptBodyRenderer
          ?.cueGroups;
        if (segments) {
          cueGroups = segments;
          break;
        }
      }
    }

    if (!cueGroups || cueGroups.length === 0) {
      // Try alternative response format (initial segments)
      const initialSegments = findNestedKey(data, 'initialSegments');
      if (initialSegments && Array.isArray(initialSegments)) {
        const text = initialSegments
          .map(seg => seg?.transcriptSectionHeaderRenderer?.snippet?.runs?.map(r => r.text).join('') ||
                      seg?.transcriptSegmentRenderer?.snippet?.runs?.map(r => r.text).join('') || '')
          .filter(t => t.trim())
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text.length > 20) return { transcript: text, language: 'en' };
      }
      throw new Error('No cue groups found in transcript response');
    }

    const parts = [];
    for (const group of cueGroups) {
      const cues = group?.transcriptCueGroupRenderer?.cues;
      if (!cues) continue;
      for (const cue of cues) {
        const text = cue?.transcriptCueRenderer?.cue?.simpleText;
        if (text && text.trim()) {
          parts.push(text.trim());
        }
      }
    }

    if (parts.length === 0) {
      throw new Error('No transcript text found in cue groups');
    }

    return {
      transcript: parts.join(' ').replace(/\s+/g, ' ').trim(),
      language: 'en'
    };
  }

  /**
   * Recursively find a key in a nested object.
   */
  function findNestedKey(obj, key, maxDepth = 10) {
    if (maxDepth <= 0 || !obj || typeof obj !== 'object') return null;
    if (obj[key] !== undefined) return obj[key];
    for (const k of Object.keys(obj)) {
      const result = findNestedKey(obj[k], key, maxDepth - 1);
      if (result !== null) return result;
    }
    return null;
  }

  // ================================================================
  // FALLBACK: Fetch watch page HTML + caption URLs
  // ================================================================

  async function fetchViaWatchPage(videoId) {
    const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const pageResponse = await fetch(pageUrl, { credentials: 'include' });

    if (!pageResponse.ok) {
      return { error: `Failed to load video page (HTTP ${pageResponse.status})` };
    }

    const html = await pageResponse.text();
    console.log('[GetPeek Bridge] Watch page loaded, length:', html.length);

    const playerData = extractPlayerResponse(html);
    if (!playerData) {
      return { error: 'Could not extract video data.' };
    }

    const playStatus = playerData?.playabilityStatus?.status;
    console.log('[GetPeek Bridge] Watch page playability:', playStatus);

    if (playStatus === 'ERROR' || playStatus === 'LOGIN_REQUIRED') {
      return { error: 'Video is unavailable.' };
    }
    if (playStatus === 'UNPLAYABLE') {
      return { error: 'Video is unplayable.' };
    }
    if (playerData?.videoDetails?.isLiveContent && playerData?.videoDetails?.isLive) {
      return { error: 'Live streams cannot be summarized.' };
    }

    const captionTracks = playerData?.captions
      ?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!captionTracks || captionTracks.length === 0) {
      return { error: 'No captions available for this video.' };
    }

    const track = pickBestTrack(captionTracks);
    if (!track) {
      return { error: 'No suitable captions found.' };
    }

    console.log('[GetPeek Bridge] Trying caption URL for:', track.languageCode);

    // Try fetching caption URL with different formats
    let transcript = null;
    for (const fmt of ['json3', 'srv1', null]) {
      try {
        const url = fmt ? setFmt(track.baseUrl, fmt) : track.baseUrl;
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) continue;
        const text = await resp.text();
        console.log(`[GetPeek Bridge] Caption ${fmt || 'raw'} length:`, text.length);
        if (text.length === 0) continue;

        if (fmt === 'json3' && text.trimStart().startsWith('{')) {
          const data = JSON.parse(text);
          transcript = parseJson3(data);
        } else {
          transcript = parseXml(text);
        }
        if (transcript && transcript.length >= 20) break;
      } catch (e) {
        console.warn(`[GetPeek Bridge] Caption ${fmt || 'raw'} failed:`, e.message);
      }
    }

    if (!transcript || transcript.trim().length < 20) {
      return { error: 'Caption data was empty.' };
    }

    return { transcript, language: track.languageCode };
  }

  // ================================================================
  // SHARED HELPERS
  // ================================================================

  function sendResult(requestId, videoId, data, error) {
    window.dispatchEvent(new CustomEvent('getpeek-transcript-result', {
      detail: { requestId, videoId, data, error }
    }));
  }

  function extractPlayerResponse(html) {
    const marker = 'ytInitialPlayerResponse';
    let idx = html.indexOf(marker);
    if (idx === -1) return null;

    idx = html.indexOf('{', idx);
    if (idx === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = idx; i < html.length; i++) {
      const ch = html[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(html.substring(idx, i + 1));
            } catch (e) {
              return null;
            }
          }
        }
      }
    }
    return null;
  }

  function setFmt(url, fmt) {
    if (url.includes('&fmt=')) {
      return url.replace(/&fmt=[^&]+/, '&fmt=' + fmt);
    }
    return url + '&fmt=' + fmt;
  }

  function pickBestTrack(tracks) {
    return tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr')
      || tracks.find(t => t.languageCode === 'en' && t.kind === 'asr')
      || tracks.find(t => t.languageCode.startsWith('en'))
      || tracks.find(t => t.kind !== 'asr')
      || tracks[0];
  }

  function parseJson3(data) {
    if (!data.events) return null;
    return data.events
      .filter(e => e.segs)
      .map(e => e.segs.map(s => s.utf8 || '').join(''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseXml(xml) {
    let parts = [];
    const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/g;
    let match;
    while ((match = textRegex.exec(xml)) !== null) {
      const decoded = decodeEntities(match[1]);
      if (decoded.trim()) parts.push(decoded.trim());
    }
    if (parts.length > 0) return parts.join(' ').replace(/\s+/g, ' ').trim();

    const segRegex = /<s[^>]*>([\s\S]*?)<\/s>/g;
    while ((match = segRegex.exec(xml)) !== null) {
      const decoded = decodeEntities(match[1]);
      if (decoded.trim()) parts.push(decoded.trim());
    }
    if (parts.length > 0) return parts.join(' ').replace(/\s+/g, ' ').trim();

    return null;
  }

  function decodeEntities(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/<[^>]+>/g, '');
  }

  console.log('[GetPeek Bridge] Ready (MAIN world)');
})();
