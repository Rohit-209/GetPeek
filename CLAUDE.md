# GetPeek

Chrome extension that summarizes YouTube videos on hover using Gemini AI.

## Architecture
- `content/overlay.js` + `content/content.js` — injected into YouTube pages, hover detection + floating card (Shadow DOM)
- `background/service-worker.js` — orchestrator, message handler
- `background/transcript.js` — Innertube API transcript fetcher (no API key needed)
- `background/gemini.js` — Gemini API client with structured JSON prompt
- `background/cache.js` — chrome.storage.local cache with TTL + daily quota tracking
- `options/` — settings page for API key, model selection, cache management

## Tech stack
- Vanilla JS, no framework, no build step
- Manifest V3 (Chromium browsers: Chrome, Edge, Arc, Brave, Opera)
- Google Gemini API (free tier, gemini-2.5-flash)

## Development
- Load unpacked extension from this directory in `chrome://extensions`
- Requires a free Gemini API key from aistudio.google.com/apikey
