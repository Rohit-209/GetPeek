# 👁 GetPeek

**Summarize YouTube videos on hover** — get the gist before you watch.

GetPeek is a browser extension that shows an AI-generated summary when you hover over any YouTube video thumbnail. It tells you what topics are covered and how deeply each one is explored, so you can decide if the video is worth your time.

## Features

- **Instant summaries** — hover over any YouTube thumbnail to see a structured summary
- **Topic depth ratings** — see whether topics are covered at a shallow, moderate, or deep level
- **Smart caching** — summaries are cached locally for 7 days, so repeat hovers are instant
- **Dark & light mode** — automatically matches your system theme
- **Works everywhere on YouTube** — Home, Watch Later, Search, Subscriptions, Shorts

## How It Works

1. Hover over a YouTube video thumbnail
2. GetPeek fetches the video's transcript (using YouTube's caption system)
3. The transcript is sent to Google Gemini for summarization
4. A floating card appears with:
   - **Summary** — 3-5 key points
   - **Topics & Depth** — what's discussed and how thoroughly

## Setup

### 1. Get a Gemini API Key (Free)

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Click "Create API Key"
3. Copy the key

### 2. Install the Extension

1. Download or clone this repo
2. Open your browser and go to `chrome://extensions` (or `arc://extensions`, `edge://extensions`, `brave://extensions`)
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked** and select the `GetPeek` folder
5. Right-click the GetPeek icon → **Options**
6. Paste your Gemini API key and click **Save**

### 3. Use It

Go to YouTube and hover over any video thumbnail. Wait ~2 seconds for the summary card to appear.

## Browser Compatibility

Works on all Chromium-based browsers:
- Google Chrome
- Microsoft Edge
- Arc
- Brave
- Opera

## Limitations

- Videos without captions cannot be summarized
- Live streams are not supported
- Very long videos (4+ hours) are summarized based on the first portion of the transcript
- Free Gemini API tier has a daily request limit (~1,500/day)

## Tech Stack

- Vanilla JavaScript (no frameworks, no build step)
- Chrome Extension Manifest V3
- Google Gemini API (free tier)
- Shadow DOM for style isolation

## License

MIT
