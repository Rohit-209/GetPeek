/**
 * GetPeek — Options Page
 */

const apiKeyInput = document.getElementById('apiKey');
const toggleKeyBtn = document.getElementById('toggleKey');
const modelSelect = document.getElementById('model');
const panelModeSelect = document.getElementById('panelMode');
const saveBtn = document.getElementById('saveBtn');
const openPanelBtn = document.getElementById('openPanelBtn');
const saveStatus = document.getElementById('saveStatus');
const clearCacheBtn = document.getElementById('clearCacheBtn');
const cacheStatus = document.getElementById('cacheStatus');
const requestCount = document.getElementById('requestCount');
const cacheCount = document.getElementById('cacheCount');
const quotaBar = document.getElementById('quotaBar');
const quotaText = document.getElementById('quotaText');

const DAILY_LIMIT = 1500;

// Load saved settings
async function loadSettings() {
  const result = await chrome.storage.local.get(['settings', 'stats']);
  const settings = result.settings || {};
  const stats = result.stats || { requestsToday: 0, lastResetDate: '' };

  if (settings.geminiApiKey) {
    apiKeyInput.value = settings.geminiApiKey;
  }
  if (settings.model) {
    modelSelect.value = settings.model;
  }
  panelModeSelect.value = settings.panelMode || 'sidepanel';

  // Reset counter if new day
  const today = new Date().toISOString().slice(0, 10);
  const todayRequests = stats.lastResetDate === today ? stats.requestsToday : 0;

  requestCount.textContent = todayRequests;
  const pct = Math.min((todayRequests / DAILY_LIMIT) * 100, 100);
  quotaBar.style.width = `${pct}%`;
  quotaBar.className = 'progress-fill' + (pct >= 80 ? ' warning' : '');
  quotaText.textContent = `${todayRequests.toLocaleString()} / ${DAILY_LIMIT.toLocaleString()} daily requests used`;

  // Count cached items
  const all = await chrome.storage.local.get(null);
  const cached = Object.keys(all).filter(k => k.startsWith('cache_')).length;
  cacheCount.textContent = cached;
}

// Toggle API key visibility
toggleKeyBtn.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  toggleKeyBtn.textContent = isPassword ? '🙈' : '👁';
});

// Save settings
saveBtn.addEventListener('click', async () => {
  const settings = {
    geminiApiKey: apiKeyInput.value.trim(),
    model: modelSelect.value,
    panelMode: panelModeSelect.value
  };

  await chrome.storage.local.set({ settings });

  saveStatus.textContent = 'Saved!';
  saveStatus.className = 'status success';
  setTimeout(() => {
    saveStatus.textContent = '';
    saveStatus.className = 'status';
  }, 2000);
});

// Open panel from options (Arc workaround)
openPanelBtn.addEventListener('click', async () => {
  const mode = panelModeSelect.value;
  if (mode === 'tab') {
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html') });
    return;
  }
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL('sidepanel/sidepanel.html'),
      type: 'popup',
      width: 440,
      height: 720,
      focused: true
    });
  } catch (err) {
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html') });
  }
});

// Clear cache
clearCacheBtn.addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
  cacheStatus.textContent = `Cleared ${response.cleared} cached summaries.`;
  cacheStatus.className = 'status success';
  cacheCount.textContent = '0';
  setTimeout(() => {
    cacheStatus.textContent = '';
    cacheStatus.className = 'status';
  }, 3000);
});

// Initialize
loadSettings();
