/**
 * GetPeek — Gemini API Client
 * Sends video transcripts to Google Gemini for structured summarization.
 */

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';

const SUMMARY_PROMPT = `You are a YouTube video summarizer. Given a video transcript, produce a structured JSON response.

Rules:
- Summaries must be factual and based only on the transcript content
- Each bullet should be one clear, complete sentence
- Topics should be distinct (not overlapping)
- Depth ratings reflect how thoroughly the video covers each topic
- "shallow" = briefly mentioned or surface-level overview
- "moderate" = explained with some detail and examples
- "deep" = thoroughly explored with in-depth analysis, examples, or evidence

Respond with ONLY valid JSON in this exact format:
{
  "summary": [
    "First key point from the video.",
    "Second key point from the video.",
    "Third key point from the video."
  ],
  "topics": [
    {
      "name": "Topic Name",
      "depth": "shallow | moderate | deep",
      "context": "One sentence explaining what the video covers about this topic and how well it is explored."
    }
  ]
}

Produce 3-5 summary bullets and 3-8 topics.`;

/**
 * Summarize a transcript using Gemini API.
 * @param {string} transcript - The video transcript text
 * @param {string} apiKey - Gemini API key
 * @param {string} [model] - Model name (defaults to gemini-2.5-flash)
 * @returns {Promise<{data: object} | {error: string}>}
 */
async function summarizeWithGemini(transcript, apiKey, model) {
  if (!apiKey) {
    return { error: 'No API key configured. Open GetPeek settings to add your Gemini API key.' };
  }

  const modelName = model || DEFAULT_MODEL;
  const url = `${GEMINI_BASE_URL}/${modelName}:generateContent?key=${apiKey}`;

  const truncationNote = transcript.length >= 100000
    ? '\n[TRANSCRIPT TRUNCATED — video is very long. Summarize based on available content.]'
    : '';

  const body = {
    contents: [
      {
        parts: [
          { text: `${SUMMARY_PROMPT}\n\nTRANSCRIPT:\n${transcript}${truncationNote}` }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.3,
      maxOutputTokens: 1024
    }
  };

  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, 30000); // 30s timeout for Gemini (longer transcripts take time)

    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) {
        return { error: 'Invalid API key. Check your Gemini API key in GetPeek settings.' };
      }
      if (status === 429) {
        return { error: 'Gemini rate limit reached. Try again later or check your daily quota.' };
      }
      return { error: `Gemini API error (${status}). Please try again.` };
    }

    const result = await response.json();

    // Extract the generated text
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return { error: 'Gemini returned an empty response.' };
    }

    // Parse the JSON response
    const parsed = JSON.parse(text);

    // Validate structure
    if (!Array.isArray(parsed.summary) || !Array.isArray(parsed.topics)) {
      return { error: 'Gemini returned an unexpected format.' };
    }

    return { data: parsed };
  } catch (err) {
    console.error('[GetPeek] Gemini error:', err);
    if (err.name === 'AbortError') {
      return { error: 'Gemini request timed out. Try again or use a shorter video.' };
    }
    if (err instanceof SyntaxError) {
      return { error: 'Failed to parse Gemini response.' };
    }
    return { error: 'Failed to connect to Gemini. Check your internet connection.' };
  }
}
