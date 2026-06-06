/**
 * GetPeek — Content Script
 * Detects hover on YouTube video thumbnails, extracts video ID,
 * requests summary from background service worker, renders overlay.
 */

// overlay.js is loaded before this file via manifest content_scripts

const HOVER_DELAY = 800; // ms before triggering summary fetch
let hoverTimer = null;
let currentVideoId = null;
let abortController = null;

/**
 * Extract video ID from a YouTube link element.
 * Handles /watch?v=, /shorts/, and youtu.be formats.
 */
function extractVideoId(element) {
  const anchor = element.closest('a[href]') || element.querySelector('a[href]');
  if (!anchor) return null;

  const href = anchor.getAttribute('href');
  if (!href) return null;

  // /watch?v=VIDEO_ID
  const watchMatch = href.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
  if (watchMatch) return watchMatch[1];

  // /shorts/VIDEO_ID
  const shortsMatch = href.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
  if (shortsMatch) return shortsMatch[1];

  return null;
}

/**
 * Find the thumbnail container element from any child element.
 */
function findThumbnailContainer(target) {
  // Walk up to find the thumbnail wrapper
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

/**
 * Handle mouse entering a thumbnail area.
 */
function onThumbnailEnter(event) {
  const container = findThumbnailContainer(event.target);
  if (!container) return;

  const videoId = extractVideoId(container);
  if (!videoId || videoId === currentVideoId) return;

  // Clear any pending hover
  clearTimeout(hoverTimer);

  hoverTimer = setTimeout(() => {
    currentVideoId = videoId;
    requestSummary(videoId, container);
  }, HOVER_DELAY);
}

/**
 * Handle mouse leaving a thumbnail area.
 */
function onThumbnailLeave(event) {
  const container = findThumbnailContainer(event.target);
  if (!container) return;

  // Check if we're moving to a child element (not actually leaving)
  const related = event.relatedTarget;
  if (related && container.contains(related)) return;

  clearTimeout(hoverTimer);

  // Abort any in-flight request
  if (abortController) {
    abortController.abort();
    abortController = null;
  }

  currentVideoId = null;
  hideOverlay();
}

/**
 * Request summary from background service worker.
 */
async function requestSummary(videoId, anchorElement) {
  // Abort previous request if any
  if (abortController) abortController.abort();
  abortController = new AbortController();

  // Show loading state
  showOverlay(anchorElement, { loading: true, videoId });

  try {
    // Race the message against a 45-second timeout so we never hang forever
    const response = await Promise.race([
      chrome.runtime.sendMessage({ type: 'GET_SUMMARY', videoId }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 45000)
      )
    ]);

    // Check if we're still hovering the same video
    if (currentVideoId !== videoId) return;

    if (!response) {
      updateOverlay({ error: 'No response from service worker. Try reloading the extension.', videoId });
    } else if (response.error) {
      updateOverlay({ error: response.error, videoId });
    } else {
      updateOverlay({ data: response.data, videoId });
    }
  } catch (err) {
    if (currentVideoId === videoId) {
      const msg = err.message === 'timeout'
        ? 'Request timed out. The service worker may not be running — try reloading the extension.'
        : 'Failed to get summary. Please try again.';
      updateOverlay({ error: msg, videoId });
    }
  }
}

/**
 * Initialize hover listeners using event delegation.
 */
function init() {
  createOverlay();

  // Event delegation — capture phase to catch events on dynamic elements
  document.addEventListener('mouseover', onThumbnailEnter, true);
  document.addEventListener('mouseout', onThumbnailLeave, true);

  // Handle YouTube SPA navigation
  window.addEventListener('yt-navigate-finish', () => {
    hideOverlay();
    currentVideoId = null;
    clearTimeout(hoverTimer);
  });
}

// Run when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
