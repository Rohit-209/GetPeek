/**
 * GetPeek — Content Script (isolated world)
 * Detects hover on YouTube video thumbnails, extracts video ID,
 * and asks the service worker for an AI summary.
 */

// overlay.js is loaded before this file via manifest content_scripts

const HOVER_DELAY = 800;
const HIDE_DELAY = 200;
const STICKY_AFTER = 5000;
const BG_ENROLL_AFTER = 10000;

let hoverTimer = null;
let hideTimer = null;
let stickyTimer = null;
let enrollTimer = null;

let currentVideoId = null;
let currentTitle = '';
let isSticky = false;
let isEnrolled = false;
const inflight = new Map();

function scheduleHide() {
  if (isSticky) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    resetHoverState();
    hideOverlay();
  }, HIDE_DELAY);
}

function cancelHide() {
  clearTimeout(hideTimer);
}

function resetHoverState() {
  currentVideoId = null;
  currentTitle = '';
  isSticky = false;
  isEnrolled = false;
  clearTimeout(stickyTimer);
  clearTimeout(enrollTimer);
}

function dismissCardImmediate() {
  cancelHide();
  resetHoverState();
  hideOverlay();
}

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

function extractTitle(container) {
  const titleEl =
    container.querySelector('#video-title') ||
    container.querySelector('a#video-title-link') ||
    container.querySelector('h3 a');
  if (titleEl) {
    const t = (titleEl.getAttribute('title') || titleEl.textContent || '').trim();
    if (t) return t;
  }
  const anchor = container.querySelector('a#video-title-link, a#thumbnail, a[href*="/watch?v="]');
  if (anchor) {
    const t = (anchor.getAttribute('title') || anchor.getAttribute('aria-label') || '').trim();
    if (t) return t;
  }
  return '';
}

function findThumbnailContainer(target) {
  const selectors = [
    'ytd-rich-item-renderer',
    'ytd-rich-grid-media',
    'ytd-compact-video-renderer',
    'ytd-video-renderer',
    'ytd-playlist-thumbnail',
    'ytd-thumbnail'
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
  if (!videoId) return;

  if (videoId === currentVideoId) {
    cancelHide();
    return;
  }

  clearTimeout(hoverTimer);

  hoverTimer = setTimeout(() => {
    currentVideoId = videoId;
    currentTitle = extractTitle(container);
    isSticky = false;
    isEnrolled = false;
    clearTimeout(stickyTimer);
    clearTimeout(enrollTimer);

    stickyTimer = setTimeout(() => {
      if (currentVideoId === videoId) isSticky = true;
    }, STICKY_AFTER);

    enrollTimer = setTimeout(() => {
      if (currentVideoId === videoId) enrollInBackground(videoId, currentTitle);
    }, BG_ENROLL_AFTER);

    requestSummary(videoId, container);
  }, HOVER_DELAY);
}

function onThumbnailLeave(event) {
  const container = findThumbnailContainer(event.target);
  if (!container) return;

  const related = event.relatedTarget;
  if (related && container.contains(related)) return;

  clearTimeout(hoverTimer);
  scheduleHide();
}

function enrollInBackground(videoId, title) {
  if (isEnrolled) return;
  isEnrolled = true;
  chrome.runtime.sendMessage({ type: 'ENROLL_HISTORY', videoId, title }).catch(() => {});
  showBackgroundIndicator();
}

function handleBackgroundButtonClick() {
  if (!currentVideoId) return;
  enrollInBackground(currentVideoId, currentTitle);
  dismissCardImmediate();
}

async function requestSummary(videoId, anchorElement) {
  showOverlay(anchorElement, { loading: true, videoId, showBgButton: true });

  try {
    let pending = inflight.get(videoId);
    if (!pending) {
      pending = Promise.race([
        chrome.runtime.sendMessage({ type: 'SUMMARIZE', videoId, title: currentTitle }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 130000))
      ]).finally(() => inflight.delete(videoId));
      inflight.set(videoId, pending);
    }
    const response = await pending;

    if (currentVideoId !== videoId) return;

    if (!response) {
      updateOverlay({ error: 'No response from service worker.', videoId });
    } else if (response.error) {
      updateOverlay({ error: response.error, videoId });
    } else {
      updateOverlay({ data: response.data, videoId, showBgButton: false });
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

function init() {
  createOverlay();
  document.addEventListener('mouseover', onThumbnailEnter, true);
  document.addEventListener('mouseout', onThumbnailLeave, true);

  window.addEventListener('yt-navigate-finish', () => {
    cancelHide();
    resetHoverState();
    hideOverlay();
    clearTimeout(hoverTimer);
  });

  console.log('[GetPeek] Content script ready.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
