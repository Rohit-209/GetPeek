/**
 * GetPeek — Cache Layer
 * Manages summary caching and daily request tracking via chrome.storage.local.
 */

const CACHE_PREFIX = 'cache_';
const DEFAULT_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Get a cached summary for a video.
 * @returns {Promise<object|null>} Cached data or null if miss/expired
 */
async function getCachedSummary(videoId) {
  const key = CACHE_PREFIX + videoId;
  const result = await chrome.storage.local.get(key);
  const entry = result[key];

  if (!entry) return null;

  // Check TTL
  const settings = await getSettings();
  const maxAge = settings.cacheMaxAge || DEFAULT_CACHE_MAX_AGE;

  if (Date.now() - entry.cachedAt > maxAge) {
    // Expired — remove it
    await chrome.storage.local.remove(key);
    return null;
  }

  return entry.data;
}

/**
 * Cache a summary for a video.
 */
async function setCachedSummary(videoId, data) {
  const key = CACHE_PREFIX + videoId;
  await chrome.storage.local.set({
    [key]: {
      data,
      cachedAt: Date.now()
    }
  });
}

/**
 * Get extension settings.
 */
async function getSettings() {
  const result = await chrome.storage.local.get('settings');
  return result.settings || {};
}

/**
 * Track a request for daily quota monitoring.
 * @returns {Promise<{count: number, limit: number, warning: boolean}>}
 */
async function trackRequest() {
  const result = await chrome.storage.local.get('stats');
  const stats = result.stats || { requestsToday: 0, lastResetDate: '' };

  const today = new Date().toISOString().slice(0, 10);

  // Reset counter if new day
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

/**
 * Get current daily usage stats.
 */
async function getUsageStats() {
  const result = await chrome.storage.local.get('stats');
  const stats = result.stats || { requestsToday: 0, lastResetDate: '' };

  const today = new Date().toISOString().slice(0, 10);
  if (stats.lastResetDate !== today) {
    return { requestsToday: 0, lastResetDate: today };
  }

  return stats;
}

/**
 * Clear all cached summaries.
 */
async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX));
  if (cacheKeys.length > 0) {
    await chrome.storage.local.remove(cacheKeys);
  }
  return cacheKeys.length;
}
