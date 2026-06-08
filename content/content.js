/**
 * GetPeek — Content Script (isolated world)
 * Detects hover on YouTube video thumbnails, extracts video ID,
 * and asks the service worker for an AI summary.
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

async function requestSummary(videoId, anchorElement) {
  showOverlay(anchorElement, { loading: true, videoId });

  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage({ type: 'SUMMARIZE', videoId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 130000))
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
