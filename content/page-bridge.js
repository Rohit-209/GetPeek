/**
 * GetPeek — Page Bridge (runs in YouTube's MAIN world)
 * Has access to YouTube's cookies and JS context.
 * Communicates with the isolated content script via CustomEvents.
 */

(function () {
  'use strict';

  // Listen for transcript requests from the content script
  window.addEventListener('getpeek-fetch-transcript', async (event) => {
    const { videoId, requestId } = event.detail;

    try {
      console.log('[GetPeek Bridge] Fetching transcript for:', videoId);

      // Get YouTube's own Innertube config from the page
      const clientVersion = (typeof ytcfg !== 'undefined' && ytcfg.get)
        ? ytcfg.get('INNERTUBE_CLIENT_VERSION')
        : '2.20250101.00.00';
      const apiKey = (typeof ytcfg !== 'undefined' && ytcfg.get)
        ? ytcfg.get('INNERTUBE_API_KEY')
        : '';
      const clientName = (typeof ytcfg !== 'undefined' && ytcfg.get)
        ? ytcfg.get('INNERTUBE_CLIENT_NAME')
        : 'WEB';

      console.log('[GetPeek Bridge] Using client:', clientName, clientVersion);

      const innertubeUrl = apiKey
        ? `https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`
        : 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

      // Step 1: Call Innertube API using YouTube's own client config
      const playerResponse = await fetch(innertubeUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: {
            client: {
              clientName: clientName,
              clientVersion: clientVersion,
              hl: document.documentElement.lang || 'en'
            }
          },
          videoId: videoId
        })
      });

      if (!playerResponse.ok) {
        sendResult(requestId, videoId, null, `YouTube API error (HTTP ${playerResponse.status})`);
        return;
      }

      const playerData = await playerResponse.json();
      console.log('[GetPeek Bridge] Playability:', playerData?.playabilityStatus?.status);

      // Check playability
      if (playerData?.playabilityStatus?.status === 'ERROR' ||
          playerData?.playabilityStatus?.status === 'LOGIN_REQUIRED') {
        sendResult(requestId, videoId, null, 'Video is unavailable.');
        return;
      }

      if (playerData?.videoDetails?.isLiveContent && playerData?.videoDetails?.isLive) {
        sendResult(requestId, videoId, null, 'Live streams cannot be summarized.');
        return;
      }

      // Step 2: Get caption tracks
      const captionTracks = playerData?.captions
        ?.playerCaptionsTracklistRenderer
        ?.captionTracks;

      if (!captionTracks || captionTracks.length === 0) {
        sendResult(requestId, videoId, null, 'No captions available for this video.');
        return;
      }

      console.log('[GetPeek Bridge] Found', captionTracks.length, 'caption tracks');

      // Pick best track
      const track = pickBestTrack(captionTracks);
      if (!track) {
        sendResult(requestId, videoId, null, 'No suitable captions found.');
        return;
      }

      console.log('[GetPeek Bridge] Using track:', track.languageCode, track.kind || 'manual');

      // Step 3: Fetch transcript with credentials
      let transcript = null;

      // Try json3 format
      const jsonUrl = setFmt(track.baseUrl, 'json3');
      try {
        const resp = await fetch(jsonUrl, { credentials: 'include' });
        if (resp.ok) {
          const text = await resp.text();
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
        const srv1Url = setFmt(track.baseUrl, 'srv1');
        try {
          const resp = await fetch(srv1Url, { credentials: 'include' });
          if (resp.ok) {
            const text = await resp.text();
            if (text.length > 0) {
              transcript = parseXml(text);
            }
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
            if (text.length > 0) {
              transcript = parseXml(text) || text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            }
          }
        } catch (e) {
          console.warn('[GetPeek Bridge] raw URL failed:', e.message);
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
    // Handle both <text> (srv1) and <p><s> (srv3) formats
    let parts = [];

    // Try srv1: <text start="..." dur="...">content</text>
    const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/g;
    let match;
    while ((match = textRegex.exec(xml)) !== null) {
      const decoded = decodeEntities(match[1]);
      if (decoded.trim()) parts.push(decoded.trim());
    }

    if (parts.length > 0) {
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    // Try srv3: <p t="..." d="..."><s>content</s></p>
    const segRegex = /<s[^>]*>([\s\S]*?)<\/s>/g;
    while ((match = segRegex.exec(xml)) !== null) {
      const decoded = decodeEntities(match[1]);
      if (decoded.trim()) parts.push(decoded.trim());
    }

    if (parts.length > 0) {
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

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
