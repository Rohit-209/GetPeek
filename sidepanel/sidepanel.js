const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const clearBtn = document.getElementById('clearBtn');

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function depthClass(depth) {
  if (depth === 'deep' || depth === 'moderate' || depth === 'shallow') {
    return `sp-depth-${depth}`;
  }
  return 'sp-depth-shallow';
}

function renderEntry(entry) {
  const card = document.createElement('div');
  card.className = 'sp-card';
  card.dataset.videoId = entry.videoId;

  const watchUrl = `https://www.youtube.com/watch?v=${entry.videoId}`;
  const thumbUrl = `https://i.ytimg.com/vi/${entry.videoId}/hqdefault.jpg`;
  const title = entry.title || 'YouTube video';

  let bodyHtml = '';
  if (entry.status === 'loading') {
    bodyHtml = `<div class="sp-status sp-status-loading">Generating summary…</div>`;
  } else if (entry.status === 'error') {
    bodyHtml = `<div class="sp-error-text">${escapeHtml(entry.error || 'Failed to generate summary.')}</div>`;
  } else if (entry.data) {
    const summaryHtml = (entry.data.summary || [])
      .map((p) => `<li>${escapeHtml(p)}</li>`)
      .join('');
    const topicsHtml = (entry.data.topics || [])
      .map((t) => {
        const label = (t.depth || '').charAt(0).toUpperCase() + (t.depth || '').slice(1);
        return `
          <div class="sp-topic">
            <div class="sp-topic-head">
              <span class="sp-topic-name">${escapeHtml(t.name)}</span>
              <span class="sp-depth ${depthClass(t.depth)}">${escapeHtml(label)}</span>
            </div>
            <p class="sp-topic-ctx">${escapeHtml(t.context)}</p>
          </div>
        `;
      })
      .join('');
    bodyHtml = `
      <div>
        <h3 class="sp-section-title">Summary</h3>
        <ul class="sp-summary">${summaryHtml}</ul>
      </div>
      <div>
        <h3 class="sp-section-title">Topics & Depth</h3>
        <div class="sp-topics">${topicsHtml}</div>
      </div>
    `;
  }

  card.innerHTML = `
    <div class="sp-card-head">
      <img class="sp-thumb" src="${escapeHtml(thumbUrl)}" alt="" />
      <div class="sp-meta">
        <a class="sp-vtitle" href="${escapeHtml(watchUrl)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>
        <div class="sp-status">${escapeHtml(timeAgo(entry.completedAt || entry.startedAt))}</div>
      </div>
    </div>
    ${bodyHtml}
  `;
  return card;
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function render(history) {
  listEl.querySelectorAll('.sp-card').forEach((n) => n.remove());
  if (!history || history.length === 0) {
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';
  const sorted = [...history].sort(
    (a, b) => (b.completedAt || b.startedAt || 0) - (a.completedAt || a.startedAt || 0)
  );
  for (const entry of sorted) {
    listEl.appendChild(renderEntry(entry));
  }
}

async function loadAndRender() {
  const { history } = await chrome.storage.local.get('history');
  render(history || []);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'HISTORY_UPDATED') {
    render(msg.history || []);
  }
});

clearBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ history: [] });
  chrome.runtime.sendMessage({ type: 'RESET_BADGE' }).catch(() => {});
  render([]);
});

chrome.runtime.sendMessage({ type: 'RESET_BADGE' }).catch(() => {});
loadAndRender();
