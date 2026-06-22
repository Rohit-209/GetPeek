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
    const pinBtn = e.target.closest('.getpeek-pin-btn');
    if (pinBtn) {
      e.preventDefault();
      e.stopPropagation();
      togglePin();
      return;
    }
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
 * Sync the pin button's visual state without re-rendering the card.
 */
function updatePinButton(pinned) {
  if (!cardEl) return;
  const btn = cardEl.querySelector('.getpeek-pin-btn');
  if (!btn) return;
  btn.classList.toggle('getpeek-pin-active', pinned);
  btn.title = pinned ? 'Unpin' : 'Pin card';
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
  const pinClass = state.pinned ? 'getpeek-icon-btn getpeek-pin-btn getpeek-pin-active' : 'getpeek-icon-btn getpeek-pin-btn';
  const pinTitle = state.pinned ? 'Unpin' : 'Pin card';
  const pinSvg = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`;
  const closeSvg = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  const bgSvg = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="8 7 17 7 17 16"/></svg>`;
  const pinHtml = `<button class="${pinClass}" title="${pinTitle}" aria-label="${pinTitle}">${pinSvg}</button>`;
  const closeHtml = `<button class="getpeek-icon-btn getpeek-close-btn" title="Close" aria-label="Close">${closeSvg}</button>`;
  const bgHtml = state.showBgButton
    ? `<button class="getpeek-bg-btn" title="Generate in background and add to side panel">${bgSvg}<span>Background</span></button>`
    : '';
  const headerHtml = `
    <div class="getpeek-header">
      <span class="getpeek-logo">
        <span class="getpeek-mark" aria-hidden="true"></span>
        <span class="getpeek-wordmark">GetPeek</span>
      </span>
      <div class="getpeek-actions">
        ${bgHtml}
        ${pinHtml}
        ${closeHtml}
      </div>
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
    :host, .getpeek-card {
      --gp-bg: #14110d;
      --gp-surface: #1c1813;
      --gp-surface-2: rgba(245, 222, 179, 0.04);
      --gp-text: #f1ece2;
      --gp-text-soft: #d6cfc1;
      --gp-muted: #948b7c;
      --gp-accent: #f5a524;
      --gp-accent-soft: rgba(245, 165, 36, 0.12);
      --gp-accent-border: rgba(245, 165, 36, 0.28);
      --gp-divider: rgba(255, 240, 220, 0.07);
      --gp-shadow: 0 12px 40px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(245, 165, 36, 0.06);
      --gp-shallow: #f5c451;
      --gp-moderate: #6aa9ff;
      --gp-deep: #4ade80;
      --gp-danger: #fca5a5;
      --gp-danger-bg: rgba(239, 68, 68, 0.1);
      --gp-danger-border: rgba(239, 68, 68, 0.22);
    }

    .getpeek-card {
      position: fixed;
      width: 380px;
      max-height: 440px;
      overflow-y: auto;
      background: var(--gp-bg);
      background-image: radial-gradient(120% 60% at 0% 0%, rgba(245, 165, 36, 0.08), transparent 60%);
      color: var(--gp-text);
      border: 1px solid var(--gp-divider);
      border-radius: 14px;
      box-shadow: var(--gp-shadow);
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      line-height: 1.55;
      padding: 14px 16px 16px;
      box-sizing: border-box;
      pointer-events: auto;
      -webkit-font-smoothing: antialiased;
    }

    .getpeek-card::-webkit-scrollbar {
      width: 6px;
    }
    .getpeek-card::-webkit-scrollbar-track {
      background: transparent;
    }
    .getpeek-card::-webkit-scrollbar-thumb {
      background: rgba(245, 165, 36, 0.25);
      border-radius: 3px;
    }
    .getpeek-card::-webkit-scrollbar-thumb:hover {
      background: rgba(245, 165, 36, 0.45);
    }

    .getpeek-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: -2px -2px 12px;
      padding: 2px 2px 10px;
      border-bottom: 1px solid var(--gp-divider);
    }

    .getpeek-logo {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .getpeek-mark {
      width: 14px;
      height: 14px;
      border-radius: 4px;
      background: linear-gradient(135deg, #fbbf4a 0%, #f0851a 100%);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18), 0 0 0 1px rgba(245, 165, 36, 0.2);
      flex-shrink: 0;
    }

    .getpeek-wordmark {
      font-size: 13px;
      font-weight: 600;
      color: var(--gp-text);
      letter-spacing: -0.01em;
    }

    .getpeek-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .getpeek-bg-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: var(--gp-accent-soft);
      border: 1px solid var(--gp-accent-border);
      color: var(--gp-accent);
      font-size: 11px;
      font-weight: 600;
      padding: 4px 9px;
      border-radius: 7px;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s, border-color 0.15s, transform 0.05s;
    }

    .getpeek-bg-btn:hover {
      background: rgba(245, 165, 36, 0.18);
      border-color: rgba(245, 165, 36, 0.45);
    }

    .getpeek-bg-btn:active {
      transform: translateY(1px);
    }

    .getpeek-icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      background: transparent;
      border: 1px solid transparent;
      color: var(--gp-muted);
      padding: 0;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }

    .getpeek-icon-btn:hover {
      background: rgba(255, 240, 220, 0.06);
      color: var(--gp-text);
    }

    .getpeek-pin-active {
      background: var(--gp-accent-soft);
      border-color: var(--gp-accent-border);
      color: var(--gp-accent);
    }

    .getpeek-pin-active:hover {
      background: rgba(245, 165, 36, 0.2);
      color: var(--gp-accent);
    }

    .getpeek-bg-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(74, 222, 128, 0.08);
      border: 1px solid rgba(74, 222, 128, 0.22);
      border-radius: 8px;
      padding: 7px 10px;
      margin-bottom: 12px;
      font-size: 11.5px;
      color: #a7f0ba;
    }

    .getpeek-bg-indicator span:first-child {
      color: #4ade80;
      font-weight: 700;
      font-size: 13px;
      line-height: 1;
    }

    .getpeek-loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      padding: 28px 0;
      color: var(--gp-muted);
    }

    .getpeek-spinner {
      width: 26px;
      height: 26px;
      border: 2.5px solid rgba(245, 165, 36, 0.18);
      border-top-color: var(--gp-accent);
      border-radius: 50%;
      animation: getpeek-spin 0.7s linear infinite;
    }

    @keyframes getpeek-spin {
      to { transform: rotate(360deg); }
    }

    .getpeek-error {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px;
      background: var(--gp-danger-bg);
      border: 1px solid var(--gp-danger-border);
      border-radius: 10px;
      color: var(--gp-danger);
    }

    .getpeek-error-icon {
      flex-shrink: 0;
      font-size: 16px;
      line-height: 1;
    }

    .getpeek-section {
      margin-bottom: 14px;
    }

    .getpeek-section:last-child {
      margin-bottom: 0;
    }

    .getpeek-section-title {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--gp-accent);
      margin: 0 0 8px 0;
    }

    .getpeek-summary {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .getpeek-summary li {
      position: relative;
      padding-left: 14px;
      margin-bottom: 6px;
      color: var(--gp-text-soft);
    }

    .getpeek-summary li::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0.6em;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--gp-accent);
      opacity: 0.7;
    }

    .getpeek-summary li:last-child {
      margin-bottom: 0;
    }

    .getpeek-recommendation-intro {
      font-size: 12px;
      color: var(--gp-muted);
      margin: 0 0 10px 0;
    }

    .getpeek-topics {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .getpeek-topic {
      background: var(--gp-surface-2);
      border: 1px solid var(--gp-divider);
      border-radius: 10px;
      padding: 10px 12px;
      transition: border-color 0.15s, background 0.15s;
    }

    .getpeek-topic:hover {
      border-color: rgba(245, 165, 36, 0.18);
      background: rgba(245, 222, 179, 0.05);
    }

    .getpeek-topic-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 4px;
    }

    .getpeek-topic-name {
      font-weight: 600;
      color: var(--gp-text);
      font-size: 12.5px;
    }

    .getpeek-depth {
      font-size: 9.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 2px 7px;
      border-radius: 999px;
      flex-shrink: 0;
    }

    .getpeek-depth-shallow {
      background: rgba(245, 196, 81, 0.14);
      color: var(--gp-shallow);
    }

    .getpeek-depth-moderate {
      background: rgba(106, 169, 255, 0.14);
      color: var(--gp-moderate);
    }

    .getpeek-depth-deep {
      background: rgba(74, 222, 128, 0.14);
      color: var(--gp-deep);
    }

    .getpeek-topic-context {
      margin: 0;
      font-size: 12px;
      color: var(--gp-muted);
      line-height: 1.5;
    }

    @media (prefers-color-scheme: light) {
      :host, .getpeek-card {
        --gp-bg: #fdfbf7;
        --gp-surface: #ffffff;
        --gp-surface-2: rgba(120, 90, 40, 0.04);
        --gp-text: #1c1813;
        --gp-text-soft: #3a342b;
        --gp-muted: #807870;
        --gp-accent: #c2710c;
        --gp-accent-soft: rgba(194, 113, 12, 0.08);
        --gp-accent-border: rgba(194, 113, 12, 0.22);
        --gp-divider: rgba(28, 24, 19, 0.08);
        --gp-shadow: 0 12px 32px rgba(28, 24, 19, 0.12), 0 0 0 1px rgba(194, 113, 12, 0.06);
        --gp-shallow: #b45309;
        --gp-moderate: #1d4ed8;
        --gp-deep: #15803d;
        --gp-danger: #b91c1c;
        --gp-danger-bg: rgba(239, 68, 68, 0.06);
        --gp-danger-border: rgba(239, 68, 68, 0.18);
      }

      .getpeek-card {
        background-image: radial-gradient(120% 60% at 0% 0%, rgba(245, 165, 36, 0.05), transparent 60%);
      }

      .getpeek-icon-btn:hover {
        background: rgba(28, 24, 19, 0.06);
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
