/**
 * GetPeek — Overlay Card
 * Renders a floating summary card near YouTube thumbnails.
 * Uses Shadow DOM to isolate styles from YouTube's CSS.
 */

let shadowHost = null;
let shadowRoot = null;
let cardEl = null;

/**
 * Create the Shadow DOM host and inject styles.
 */
function createOverlay() {
  if (shadowHost) return;

  shadowHost = document.createElement('div');
  shadowHost.id = 'getpeek-overlay-host';
  shadowHost.style.cssText = 'position: fixed; top: 0; left: 0; z-index: 2147483647; pointer-events: none;';
  document.body.appendChild(shadowHost);

  shadowRoot = shadowHost.attachShadow({ mode: 'closed' });

  // Inject styles into shadow DOM
  const style = document.createElement('style');
  style.textContent = getCardStyles();
  shadowRoot.appendChild(style);

  // Create card container
  cardEl = document.createElement('div');
  cardEl.className = 'getpeek-card';
  cardEl.style.display = 'none';
  cardEl.addEventListener('mouseenter', () => cancelHide());
  cardEl.addEventListener('mouseleave', () => scheduleHide());
  cardEl.addEventListener('click', (e) => {
    if (!e.target.closest) return;
    const bgBtn = e.target.closest('.getpeek-bg-btn');
    if (bgBtn) {
      e.preventDefault();
      e.stopPropagation();
      handleBackgroundButtonClick();
      return;
    }
    const closeBtn = e.target.closest('.getpeek-close-btn');
    if (closeBtn) {
      e.preventDefault();
      e.stopPropagation();
      dismissCardImmediate();
    }
  });
  shadowRoot.appendChild(cardEl);
}

/**
 * Show the "saved to side panel" indicator without re-rendering the card.
 */
function showBackgroundIndicator() {
  if (!cardEl) return;
  if (cardEl.querySelector('.getpeek-bg-indicator')) return;
  const indicator = document.createElement('div');
  indicator.className = 'getpeek-bg-indicator';
  indicator.innerHTML = `<span>✓</span><span>Saved to side panel — keep browsing</span>`;
  const header = cardEl.querySelector('.getpeek-header');
  if (header && header.nextSibling) {
    cardEl.insertBefore(indicator, header.nextSibling);
  } else {
    cardEl.appendChild(indicator);
  }
  const bgBtn = cardEl.querySelector('.getpeek-bg-btn');
  if (bgBtn) bgBtn.remove();
}

/**
 * Position and show the overlay card near a thumbnail element.
 */
function showOverlay(anchorElement, state) {
  if (!cardEl) return;

  // Position the card
  const rect = anchorElement.getBoundingClientRect();
  const cardWidth = 380;
  const cardMaxHeight = 420;
  const gap = 8;

  // Prefer right side; fall back to left if not enough space
  let left = rect.right + gap;
  if (left + cardWidth > window.innerWidth) {
    left = rect.left - cardWidth - gap;
  }
  // If still off-screen, center below
  if (left < 0) {
    left = Math.max(8, rect.left + (rect.width - cardWidth) / 2);
  }

  let top = rect.top;
  if (top + cardMaxHeight > window.innerHeight) {
    top = Math.max(8, window.innerHeight - cardMaxHeight - 8);
  }

  cardEl.style.left = `${left}px`;
  cardEl.style.top = `${top}px`;
  cardEl.style.display = 'block';
  cardEl.style.pointerEvents = 'auto';

  renderCard(state);
}

/**
 * Update card content without repositioning.
 */
function updateOverlay(state) {
  if (!cardEl) return;
  renderCard(state);
}

/**
 * Hide the overlay card.
 */
function hideOverlay() {
  if (!cardEl) return;
  cardEl.style.display = 'none';
  cardEl.innerHTML = '';
}

/**
 * Render card content based on state.
 */
function renderCard(state) {
  let actionHtml = '';
  if (state.showBgButton) {
    actionHtml = `<button class="getpeek-bg-btn" title="Generate in background and add to side panel">↗ Background</button>`;
  } else if (state.data || state.error) {
    actionHtml = `<button class="getpeek-close-btn" title="Close">×</button>`;
  }
  const headerHtml = `
    <div class="getpeek-header">
      <span class="getpeek-logo">👁 GetPeek</span>
      ${actionHtml}
    </div>
  `;

  if (state.loading) {
    cardEl.innerHTML = `
      ${headerHtml}
      <div class="getpeek-loading">
        <div class="getpeek-spinner"></div>
        <span>Summarizing video...</span>
      </div>
    `;
    return;
  }

  if (state.error) {
    cardEl.innerHTML = `
      ${headerHtml}
      <div class="getpeek-error">
        <span class="getpeek-error-icon">⚠</span>
        <span>${escapeHtml(state.error)}</span>
      </div>
    `;
    return;
  }

  const { data } = state;
  if (!data) return;

  const summaryHtml = data.summary
    .map(point => `<li>${escapeHtml(point)}</li>`)
    .join('');

  const topicsHtml = data.topics
    .map(topic => {
      const depthClass = `getpeek-depth-${topic.depth}`;
      const depthLabel = topic.depth.charAt(0).toUpperCase() + topic.depth.slice(1);
      return `
        <div class="getpeek-topic">
          <div class="getpeek-topic-header">
            <span class="getpeek-topic-name">${escapeHtml(topic.name)}</span>
            <span class="getpeek-depth ${depthClass}">${depthLabel}</span>
          </div>
          <p class="getpeek-topic-context">${escapeHtml(topic.context)}</p>
        </div>
      `;
    })
    .join('');

  cardEl.innerHTML = `
    ${headerHtml}

    <div class="getpeek-section">
      <h3 class="getpeek-section-title">Summary</h3>
      <ul class="getpeek-summary">${summaryHtml}</ul>
    </div>

    <div class="getpeek-section">
      <h3 class="getpeek-section-title">Topics & Depth</h3>
      <p class="getpeek-recommendation-intro">If you're interested in these topics, here's how thoroughly they're covered:</p>
      <div class="getpeek-topics">${topicsHtml}</div>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getCardStyles() {
  return `
    .getpeek-card {
      position: fixed;
      width: 380px;
      max-height: 420px;
      overflow-y: auto;
      background: #1a1a2e;
      color: #e0e0e0;
      border: 1px solid rgba(124, 58, 237, 0.4);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(124, 58, 237, 0.1);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      padding: 16px;
      box-sizing: border-box;
      pointer-events: auto;
    }

    .getpeek-card::-webkit-scrollbar {
      width: 6px;
    }
    .getpeek-card::-webkit-scrollbar-track {
      background: transparent;
    }
    .getpeek-card::-webkit-scrollbar-thumb {
      background: rgba(124, 58, 237, 0.3);
      border-radius: 3px;
    }

    .getpeek-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    .getpeek-logo {
      font-size: 14px;
      font-weight: 700;
      color: #a78bfa;
      letter-spacing: 0.5px;
    }

    .getpeek-bg-btn {
      background: transparent;
      border: 1px solid rgba(167, 139, 250, 0.35);
      color: #a78bfa;
      font-size: 11px;
      font-weight: 600;
      padding: 4px 8px;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s, border-color 0.15s;
    }

    .getpeek-bg-btn:hover {
      background: rgba(124, 58, 237, 0.15);
      border-color: rgba(167, 139, 250, 0.6);
    }

    .getpeek-close-btn {
      background: transparent;
      border: none;
      color: #9ca3af;
      font-size: 18px;
      line-height: 1;
      padding: 2px 8px;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
    }

    .getpeek-close-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #e5e7eb;
    }

    .getpeek-bg-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      background: rgba(34, 197, 94, 0.08);
      border: 1px solid rgba(34, 197, 94, 0.2);
      border-radius: 6px;
      padding: 6px 10px;
      margin-bottom: 10px;
      font-size: 11px;
      color: #86efac;
    }

    .getpeek-bg-indicator span:first-child {
      color: #4ade80;
      font-weight: 700;
    }

    .getpeek-loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      padding: 24px 0;
      color: #9ca3af;
    }

    .getpeek-spinner {
      width: 28px;
      height: 28px;
      border: 3px solid rgba(124, 58, 237, 0.2);
      border-top-color: #7c3aed;
      border-radius: 50%;
      animation: getpeek-spin 0.8s linear infinite;
    }

    @keyframes getpeek-spin {
      to { transform: rotate(360deg); }
    }

    .getpeek-error {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 12px;
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.2);
      border-radius: 8px;
      color: #fca5a5;
    }

    .getpeek-error-icon {
      flex-shrink: 0;
      font-size: 16px;
    }

    .getpeek-section {
      margin-bottom: 12px;
    }

    .getpeek-section:last-child {
      margin-bottom: 0;
    }

    .getpeek-section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #7c3aed;
      margin: 0 0 8px 0;
    }

    .getpeek-summary {
      margin: 0;
      padding: 0 0 0 18px;
      list-style: disc;
    }

    .getpeek-summary li {
      margin-bottom: 4px;
      color: #d1d5db;
    }

    .getpeek-summary li:last-child {
      margin-bottom: 0;
    }

    .getpeek-recommendation-intro {
      font-size: 12px;
      color: #9ca3af;
      margin: 0 0 8px 0;
      font-style: italic;
    }

    .getpeek-topics {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .getpeek-topic {
      background: rgba(255, 255, 255, 0.04);
      border-radius: 8px;
      padding: 10px;
    }

    .getpeek-topic-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }

    .getpeek-topic-name {
      font-weight: 600;
      color: #e5e7eb;
      font-size: 13px;
    }

    .getpeek-depth {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 2px 8px;
      border-radius: 10px;
    }

    .getpeek-depth-shallow {
      background: rgba(251, 191, 36, 0.15);
      color: #fbbf24;
    }

    .getpeek-depth-moderate {
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
    }

    .getpeek-depth-deep {
      background: rgba(34, 197, 94, 0.15);
      color: #4ade80;
    }

    .getpeek-topic-context {
      margin: 0;
      font-size: 12px;
      color: #9ca3af;
    }

    @media (prefers-color-scheme: light) {
      .getpeek-card {
        background: #ffffff;
        color: #1f2937;
        border-color: rgba(124, 58, 237, 0.25);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(124, 58, 237, 0.08);
      }

      .getpeek-summary li {
        color: #374151;
      }

      .getpeek-topic {
        background: rgba(0, 0, 0, 0.03);
      }

      .getpeek-topic-name {
        color: #1f2937;
      }

      .getpeek-topic-context {
        color: #6b7280;
      }

      .getpeek-recommendation-intro {
        color: #6b7280;
      }

      .getpeek-error {
        background: rgba(239, 68, 68, 0.05);
        color: #dc2626;
      }

      .getpeek-loading {
        color: #6b7280;
      }

      .getpeek-bg-btn {
        border-color: rgba(124, 58, 237, 0.3);
        color: #7c3aed;
      }

      .getpeek-bg-btn:hover {
        background: rgba(124, 58, 237, 0.08);
      }

      .getpeek-bg-indicator {
        background: rgba(34, 197, 94, 0.06);
        border-color: rgba(34, 197, 94, 0.2);
        color: #15803d;
      }

      .getpeek-bg-indicator span:first-child {
        color: #16a34a;
      }
    }
  `;
}
