/**
 * GetPeek — Content Script (isolated world)
 * Detects hover on YouTube video thumbnails, extracts video ID,
 * requests transcript via page bridge (MAIN world), then sends
 * transcript to service worker for AI summarization.
 */

// overlay.js is loaded before this file via manifest content_scripts

const HOVER_DELAY = 800;
let hoverTimer = null;
let currentVideoId = null;

/**
 * Extract video ID from a YouTube link element.
 */
function extractVideoId(element) {
  const anchor = element.closest('a[href]') || element.querySelector('a[href]');
  if (!anchor) return null;

  const href = anchor.getAttribute('href');
  if (!href) return null;

  const watchMatch = href.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
  if (watchMatch) return watchMatch[1];

  const shortsMatch = href.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
  if (shortsMatch) return shortsMatch[1];

  return null;
}

/**
 * Find the thumbnail container element from any child element.
 */
function findThumbnailContainer(target) {
  const selectors = [
    'ytd-thumbnail',
    'ytd-playlist-thumbnail',
    'ytd-rich-grid-media',
    'ytd-compact-video-renderer',
    'ytd-video-renderer',
    'ytd-rich-item-renderer'
  ];

  for (const sel of selectors) {
    const container = target.closest(sel);
    if (container) return container;
  }
  return null;
}

function onThumbnailEnter(event) {
  const container = findThumbnailContainer(event.target);
  if (!container) return;

  const videoId = extractVideoId(container);
  if (!videoId || videoId === currentVideoId) return;

  clearTimeout(hoverTimer);

  hoverTimer = setTimeout(() => {
    currentVideoId = videoId;
    requestSummary(videoId, container);
  }, HOVER_DELAY);
}

function onThumbnailLeave(event) {
  const container = findThumbnailContainer(event.target);
  if (!container) return;

  const related = event.relatedTarget;
  if (related && container.contains(related)) return;

  clearTimeout(hoverTimer);
  currentVideoId = null;
  hideOverlay();
}

/**
 * Request transcript from page bridge, then summary from service worker.
 */
async function requestSummary(videoId, anchorElement) {
  showOverlay(anchorElement, { loading: true, videoId });

  try {
    // Step 1: Check if we already have a cached summary
    const cached = await chrome.runtime.sendMessage({ type: 'CHECK_CACHE', videoId });
    if (cached && cached.data) {
      if (currentVideoId === videoId) {
        updateOverlay({ data: cached.data, videoId });
      }
      return;
    }

    // Step 2: Fetch transcript via page bridge (MAIN world, has YouTube cookies)
    const transcriptResult = await fetchTranscriptViaBridge(videoId);

    if (currentVideoId !== videoId) return;

    if (transcriptResult.error) {
      updateOverlay({ error: transcriptResult.error, videoId });
      return;
    }

    // Step 3: Send transcript to service worker for Gemini summarization
    updateOverlay({ loading: true, videoId }); // still loading — now summarizing

    const response = await Promise.race([
      chrome.runtime.sendMessage({
        type: 'SUMMARIZE',
        videoId,
        transcript: transcriptResult.data.transcript,
        language: transcriptResult.data.language,
        truncated: transcriptResult.data.truncated
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 45000))
    ]);

    if (currentVideoId !== videoId) return;

    if (!response) {
      updateOverlay({ error: 'No response from service worker.', videoId });
    } else if (response.error) {
      updateOverlay({ error: response.error, videoId });
    } else {
      updateOverlay({ data: response.data, videoId });
    }

  } catch (err) {
    if (currentVideoId === videoId) {
      const msg = err.message === 'timeout'
        ? 'Request timed out. Try again.'
        : 'Failed to get summary. Please try again.';
      updateOverlay({ error: msg, videoId });
    }
  }
}

/**
 * Fetch transcript via the page bridge (MAIN world script).
 * Uses CustomEvents to communicate across world boundaries.
 */
function fetchTranscriptViaBridge(videoId) {
  return new Promise((resolve) => {
    const requestId = Math.random().toString(36).slice(2);
    const timeout = setTimeout(() => {
      window.removeEventListener('getpeek-transcript-result', handler);
      resolve({ error: 'Transcript fetch timed out.' });
    }, 20000);

    function handler(event) {
      if (event.detail && event.detail.requestId === requestId) {
        clearTimeout(timeout);
        window.removeEventListener('getpeek-transcript-result', handler);
        if (event.detail.error) {
          resolve({ error: event.detail.error });
        } else {
          resolve({ data: event.detail.data });
        }
      }
    }

    window.addEventListener('getpeek-transcript-result', handler);

    // Dispatch request to the MAIN world page bridge
    window.dispatchEvent(new CustomEvent('getpeek-fetch-transcript', {
      detail: { videoId, requestId }
    }));
  });
}

/**
 * Initialize.
 */
function init() {
  createOverlay();
  document.addEventListener('mouseover', onThumbnailEnter, true);
  document.addEventListener('mouseout', onThumbnailLeave, true);

  window.addEventListener('yt-navigate-finish', () => {
    hideOverlay();
    currentVideoId = null;
    clearTimeout(hoverTimer);
  });

  console.log('[GetPeek] Content script ready.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
