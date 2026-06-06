/**
 * GetPeek — Page Bridge (runs in YouTube's MAIN world)
 * Has access to YouTube's cookies and JS context.
 * Fetches video watch pages to extract transcript data.
 */

(function () {
  'use strict';

  window.addEventListener('getpeek-fetch-transcript', async (event) => {
    const { videoId, requestId } = event.detail;

    try {
      console.log('[GetPeek Bridge] Fetching transcript for:', videoId);

      // Fetch the watch page (MAIN world fetch includes YouTube cookies)
      const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const pageResponse = await fetch(pageUrl, { credentials: 'include' });

      if (!pageResponse.ok) {
        sendResult(requestId, videoId, null, `Failed to load video page (HTTP ${pageResponse.status})`);
        return;
      }

      const html = await pageResponse.text();
      console.log('[GetPeek Bridge] Page loaded, length:', html.length);

      // Extract ytInitialPlayerResponse from the HTML
      const playerData = extractPlayerResponse(html);
      if (!playerData) {
        sendResult(requestId, videoId, null, 'Could not extract video data.');
        return;
      }

      console.log('[GetPeek Bridge] Playability:', playerData?.playabilityStatus?.status);

      const playStatus = playerData?.playabilityStatus?.status;
      if (playStatus === 'ERROR' || playStatus === 'LOGIN_REQUIRED') {
        sendResult(requestId, videoId, null, 'Video is unavailable.');
        return;
      }
      if (playStatus === 'UNPLAYABLE') {
        sendResult(requestId, videoId, null, 'Video is unplayable.');
        return;
      }

      if (playerData?.videoDetails?.isLiveContent && playerData?.videoDetails?.isLive) {
        sendResult(requestId, videoId, null, 'Live streams cannot be summarized.');
        return;
      }

      // Get caption tracks
      const captionTracks = playerData?.captions
        ?.playerCaptionsTracklistRenderer
        ?.captionTracks;

      if (!captionTracks || captionTracks.length === 0) {
        sendResult(requestId, videoId, null, 'No captions available for this video.');
        return;
      }

      console.log('[GetPeek Bridge] Found', captionTracks.length, 'caption tracks');
      const track = pickBestTrack(captionTracks);
      if (!track) {
        sendResult(requestId, videoId, null, 'No suitable captions found.');
        return;
      }

      console.log('[GetPeek Bridge] Using track:', track.languageCode, track.kind || 'manual');

      // Fetch transcript (with cookies so signed URLs work)
      let transcript = null;

      // Try json3 format
      try {
        const jsonUrl = setFmt(track.baseUrl, 'json3');
        const resp = await fetch(jsonUrl, { credentials: 'include' });
        if (resp.ok) {
          const text = await resp.text();
          console.log('[GetPeek Bridge] json3 length:', text.length);
          if (text.length > 0 && text.trimStart().startsWith('{')) {
            const data = JSON.parse(text);
            transcript = parseJson3(data);
          }
        }
      } catch (e) {
        console.warn('[GetPeek Bridge] json3 failed:', e.message);
      }

      // Fallback: srv1 format
      if (!transcript) {
        try {
          const srv1Url = setFmt(track.baseUrl, 'srv1');
          const resp = await fetch(srv1Url, { credentials: 'include' });
          if (resp.ok) {
            const text = await resp.text();
            console.log('[GetPeek Bridge] srv1 length:', text.length);
            if (text.length > 0) transcript = parseXml(text);
          }
        } catch (e) {
          console.warn('[GetPeek Bridge] srv1 failed:', e.message);
        }
      }

      // Fallback: raw baseUrl
      if (!transcript) {
        try {
          const resp = await fetch(track.baseUrl, { credentials: 'include' });
          if (resp.ok) {
            const text = await resp.text();
            console.log('[GetPeek Bridge] raw length:', text.length);
            if (text.length > 0) {
              transcript = parseXml(text) || text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            }
          }
        } catch (e) {
          console.warn('[GetPeek Bridge] raw fetch failed:', e.message);
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
        language: track.languageCode,
        truncated: truncated
      }, null);

    } catch (err) {
      console.error('[GetPeek Bridge] Error:', err);
      sendResult(requestId, videoId, null, 'Failed to fetch transcript.');
    }
  });

  function sendResult(requestId, videoId, data, error) {
    window.dispatchEvent(new CustomEvent('getpeek-transcript-result', {
      detail: { requestId, videoId, data, error }
    }));
  }

  /**
   * Extract ytInitialPlayerResponse from YouTube page HTML.
   * Uses brace-counting to reliably find the JSON boundaries.
   */
  function extractPlayerResponse(html) {
    const marker = 'ytInitialPlayerResponse';
    let idx = html.indexOf(marker);
    if (idx === -1) return null;

    // Find the opening brace
    idx = html.indexOf('{', idx);
    if (idx === -1) return null;

    // Brace-counting with string awareness
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
              console.warn('[GetPeek Bridge] JSON parse failed:', e.message);
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

    // srv1: <text start="..." dur="...">content</text>
    const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/g;
    let match;
    while ((match = textRegex.exec(xml)) !== null) {
      const decoded = decodeEntities(match[1]);
      if (decoded.trim()) parts.push(decoded.trim());
    }
    if (parts.length > 0) return parts.join(' ').replace(/\s+/g, ' ').trim();

    // srv3: <p><s>content</s></p>
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
