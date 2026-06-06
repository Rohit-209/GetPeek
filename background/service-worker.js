/**
 * GetPeek — Background Service Worker
 * Orchestrates transcript fetching, AI summarization, and caching.
 */

importScripts('background/transcript.js', 'background/gemini.js', 'background/cache.js');

/**
 * Handle messages from content scripts.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_SUMMARY') {
    handleGetSummary(message.videoId).then(sendResponse);
    return true; // Keep message channel open for async response
  }

  if (message.type === 'GET_STATS') {
    getUsageStats().then(sendResponse);
    return true;
  }

  if (message.type === 'CLEAR_CACHE') {
    clearCache().then(count => sendResponse({ cleared: count }));
    return true;
  }
});

/**
 * Main summary pipeline: cache check → transcript → Gemini → cache store.
 */
async function handleGetSummary(videoId) {
  try {
    // 1. Check cache
    const cached = await getCachedSummary(videoId);
    if (cached) {
      return { data: cached };
    }

    // 2. Get settings (API key)
    const settings = await getSettings();
    if (!settings.geminiApiKey) {
      return { error: 'No API key configured. Right-click the GetPeek icon → Options to add your Gemini API key.' };
    }

    // 3. Check daily quota
    const quota = await trackRequest();
    if (quota.exceeded) {
      return { error: 'Daily request limit reached. Summaries will resume tomorrow.' };
    }

    // 4. Fetch transcript
    const transcriptResult = await fetchTranscript(videoId);
    if (transcriptResult.error) {
      return { error: transcriptResult.error };
    }

    // 5. Summarize with Gemini
    const summaryResult = await summarizeWithGemini(
      transcriptResult.transcript,
      settings.geminiApiKey,
      settings.model
    );

    if (summaryResult.error) {
      return { error: summaryResult.error };
    }

    // Add metadata
    const data = {
      ...summaryResult.data,
      language: transcriptResult.language,
      truncated: transcriptResult.truncated || false
    };

    // 6. Cache the result
    await setCachedSummary(videoId, data);

    return { data };
  } catch (err) {
    console.error('[GetPeek] Summary pipeline error:', err);
    return { error: 'Something went wrong. Please try again.' };
  }
}
