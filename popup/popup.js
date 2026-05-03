// Popup is now a thin UI shell. The per-item run loop lives in the service
// worker (see background/service-worker.js) so closing the popup — which
// happens the moment it loses focus, e.g. when the user clicks over to the
// Walmart tab to watch — does not abort the run.
//
// All state is read from chrome.storage.local and live-updated via
// chrome.storage.onChanged. The popup sends START_RUN / STOP_RUN /
// RUN_OVERRIDE messages to the service worker; everything else is plain
// reads.

const $ = (sel) => document.querySelector(sel);

const els = {
  status: $('#status-line'),
  itemCount: $('#item-count'),
  sourceLine: $('#source-line'),
  refreshBtn: $('#refresh-btn'),
  retailerName: $('#retailer-name'),
  retailerHint: $('#retailer-hint'),
  openWalmartBtn: $('#open-walmart-btn'),
  runBtn: $('#run-btn'),
  stopBtn: $('#stop-btn'),
  progressSection: $('#progress-section'),
  progressText: $('#progress-text'),
  progressFill: $('#progress-bar-fill'),
  progressElapsed: $('#progress-elapsed'),
  resultsSection: $('#results-section'),
  resultsList: $('#results-list')
};

const state = {
  list: null,
  retailer: null,    // { name, tabId }
  run: null          // persisted runState shape from service worker
};

const RETAILER_HOSTS = {
  walmart: ['walmart.com', 'www.walmart.com'],
  target: ['target.com', 'www.target.com'],
  kroger: ['kroger.com', 'www.kroger.com']
};

function hostnameToRetailer(hostname) {
  if (!hostname) return null;
  for (const [name, hosts] of Object.entries(RETAILER_HOSTS)) {
    if (hosts.includes(hostname)) return name;
  }
  return null;
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(resp || { ok: false, error: 'no response' });
    });
  });
}

// ---------- rendering ----------

function setStatus(msg) { els.status.textContent = msg; }

function isRunning() {
  return !!(state.run && state.run.status === 'running');
}

function renderList() {
  const count = state.list && state.list.items ? state.list.items.length : 0;
  els.itemCount.textContent = String(count);
  if (state.list && state.list.sourceUrl) {
    const ageMins = Math.round((Date.now() - new Date(state.list.capturedAt).getTime()) / 60000);
    els.sourceLine.textContent = `from plan ${state.list.planId} • captured ${ageMins} min ago`;
  } else {
    els.sourceLine.textContent = 'No list yet — visit your meal-planner shopping page.';
  }
  els.runBtn.disabled = !(count > 0 && state.retailer && !isRunning());
  els.stopBtn.disabled = !isRunning();
}

function renderRetailer() {
  if (state.retailer) {
    els.retailerName.textContent = state.retailer.name;
    els.retailerHint.textContent = '';
  } else {
    els.retailerName.textContent = 'none detected';
    els.retailerHint.textContent = 'Open a supported retailer tab (currently: Walmart).';
  }
  renderList();
}

function renderRun() {
  if (!state.run || !state.run.results || !state.run.results.length) {
    els.progressSection.classList.add('hidden');
    els.resultsSection.classList.add('hidden');
    return;
  }
  const total = state.run.total || state.run.results.length;
  const done = state.run.results.filter((r) => r.status !== 'pending').length;
  els.progressSection.classList.remove('hidden');
  els.progressText.textContent = `${done} / ${total}`;
  const pct = total ? Math.round((done / total) * 100) : 0;
  els.progressFill.style.width = pct + '%';
  if (state.run.startedAt) {
    const end = state.run.finishedAt || Date.now();
    els.progressElapsed.textContent = `${((end - state.run.startedAt) / 1000).toFixed(1)}s`;
  }
  if (state.run.statusLine) setStatus(state.run.statusLine);

  els.resultsSection.classList.remove('hidden');
  els.resultsList.innerHTML = '';
  state.run.results.forEach((r, idx) => {
    const li = document.createElement('li');
    li.className = 'result';

    const header = document.createElement('div');
    header.className = 'result-header';

    const name = document.createElement('div');
    name.className = 'result-name';
    name.textContent = r.name;

    const status = document.createElement('span');
    status.className = 'result-status status-' + r.status;
    status.textContent = r.status;

    header.appendChild(name);
    header.appendChild(status);
    li.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'result-meta';
    const parts = [];
    if (r.chosen) {
      parts.push(`→ ${r.chosen.title}` + (r.chosen.price != null ? ` ($${r.chosen.price.toFixed(2)})` : ''));
    }
    // Always surface the reason for fail/review — the chosen line alone hid
    // it before, so users saw a red FAIL with no explanation.
    if (r.reason && r.status !== 'ok') parts.push(r.reason);
    meta.textContent = parts.join(' — ');
    li.appendChild(meta);

    if (r.candidates && r.candidates.length > 1) {
      const wrap = document.createElement('div');
      wrap.className = 'result-override';
      const sel = document.createElement('select');
      r.candidates.forEach((c, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = `${c.title}${c.price != null ? ' — $' + c.price.toFixed(2) : ''}`;
        if (r.chosen && c.url === r.chosen.url) opt.selected = true;
        sel.appendChild(opt);
      });
      const btn = document.createElement('button');
      btn.textContent = 'Use this';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        await send({ type: 'RUN_OVERRIDE', resultIndex: idx, candidateIndex: parseInt(sel.value, 10) });
        btn.disabled = false;
      });
      wrap.appendChild(sel);
      wrap.appendChild(btn);
      li.appendChild(wrap);
    }

    els.resultsList.appendChild(li);
  });
}

// ---------- init / refresh ----------
//
// All three reads are zero-roundtrip: chrome.storage.local and chrome.tabs
// .query are available to the popup directly, no service worker wake-up.

async function refreshList() {
  const { shoppingList } = await chrome.storage.local.get('shoppingList');
  state.list = shoppingList || null;
  renderList();
}

async function refreshRetailer() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let retailer = null;
  let tabId = null;
  if (tab && tab.url) {
    try {
      retailer = hostnameToRetailer(new URL(tab.url).hostname);
      tabId = tab.id;
    } catch (_) {}
  }
  state.retailer = retailer && tabId ? { name: retailer, tabId } : null;
  renderRetailer();
}

async function refreshRun() {
  const { runState } = await chrome.storage.local.get('runState');
  state.run = runState || null;
  renderRun();
  renderList(); // run state affects run/stop button enablement
}

// ---------- handlers ----------

els.refreshBtn.addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: 'https://meals.alaskatargeting.com/plan/*/shopping*' });
  if (tabs.length) {
    await chrome.tabs.reload(tabs[0].id);
    setStatus('Reloaded meal-planner tab.');
  } else {
    setStatus('No meal-planner shopping tab open.');
  }
  setTimeout(refreshList, 1500);
});

els.openWalmartBtn.addEventListener('click', async () => {
  const tab = await chrome.tabs.create({ url: 'https://www.walmart.com/' });
  setTimeout(() => {
    state.retailer = { name: 'walmart', tabId: tab.id };
    renderRetailer();
  }, 500);
});

els.runBtn.addEventListener('click', async () => {
  if (!state.retailer || !state.list) return;
  setStatus('Starting run…');
  // Clear any prior run so the UI doesn't show stale results during the
  // first message round-trip.
  await send({ type: 'CLEAR_RUN_STATE' });
  const r = await send({
    type: 'START_RUN',
    tabId: state.retailer.tabId,
    retailer: state.retailer.name
  });
  if (!r.ok) {
    setStatus('Could not start: ' + (r.error || 'unknown'));
  }
  // No need to await results — popup may close, service worker carries on.
  // When the popup is reopened, refreshRun() picks up wherever the SW is.
});

els.stopBtn.addEventListener('click', async () => {
  await send({ type: 'STOP_RUN' });
  setStatus('Stop requested — finishing current item.');
});

// Live updates while popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.shoppingList) {
    state.list = changes.shoppingList.newValue || null;
    renderList();
  }
  if (changes.runState) {
    state.run = changes.runState.newValue || null;
    renderRun();
    renderList();
  }
});

// ---------- settings tab ----------

function activateTab(name) {
  document.querySelectorAll('.tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.classList.toggle('active', p.id === 'tab-' + name);
  });
  if (name === 'settings') refreshSyncStatus();
}

document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => activateTab(b.dataset.tab));
});

const syncEls = {
  baseUrl: document.querySelector('#sync-base-url'),
  token: document.querySelector('#sync-token'),
  tokenState: document.querySelector('#sync-token-state'),
  saveBtn: document.querySelector('#sync-save-btn'),
  flushBtn: document.querySelector('#sync-flush-btn'),
  status: document.querySelector('#sync-status')
};

// The meal planner is a single deployment for this user; no other base URL
// is realistic. Default the field to it so first-time setup is just "paste
// token, click Save."
const DEFAULT_BASE_URL = 'https://meals.alaskatargeting.com';

async function refreshSyncStatus() {
  const { syncSettings } = await chrome.storage.local.get('syncSettings');
  // Always pre-fill the base URL: saved value if present, default otherwise.
  syncEls.baseUrl.value = (syncSettings && syncSettings.baseUrl) || DEFAULT_BASE_URL;
  syncEls.token.value = '';
  // Make the saved-vs-empty distinction explicit on a separate line so it's
  // visible even when the input is blank.
  const hasToken = !!(syncSettings && syncSettings.token);
  if (hasToken) {
    const masked = syncSettings.token.slice(0, 4) + '…' + syncSettings.token.slice(-4);
    syncEls.tokenState.textContent = `✓ Token saved (${masked}). Leave blank to keep, or paste a new one to replace.`;
    syncEls.tokenState.style.color = '#1f7a3a';
  } else {
    syncEls.tokenState.textContent = 'No token set yet.';
    syncEls.tokenState.style.color = '#b3261e';
  }
  const r = await send({ type: 'SYNC_STATUS' });
  if (!r.ok) { syncEls.status.textContent = 'status check failed'; return; }
  const lines = [];
  lines.push(r.configured ? 'Configured.' : 'Not configured.');
  if (r.buffered) lines.push(r.buffered + ' event(s) waiting to send.');
  if (r.last) {
    const ago = Math.round((Date.now() - r.last.at) / 1000);
    if (r.last.ok) {
      lines.push(`Last flush ${ago}s ago: sent ${r.last.sent}` + (r.last.ingested ? ` (ingested ${r.last.ingested.searches} searches)` : ''));
    } else {
      lines.push(`Last flush ${ago}s ago: ${r.last.error || 'failed'}`);
    }
  }
  syncEls.status.textContent = lines.join(' ');
}

syncEls.saveBtn.addEventListener('click', async () => {
  const baseUrl = syncEls.baseUrl.value.trim();
  // Only update token if user typed one — keep existing otherwise.
  const typed = syncEls.token.value.trim();
  const { syncSettings: existing } = await chrome.storage.local.get('syncSettings');
  const token = typed || (existing && existing.token) || '';
  if (!baseUrl || !token) {
    syncEls.status.textContent = 'Need both a base URL and a token.';
    return;
  }
  await chrome.storage.local.set({ syncSettings: { baseUrl: baseUrl.replace(/\/+$/, ''), token } });
  syncEls.status.textContent = 'Saved.';
  syncEls.token.value = '';
  refreshSyncStatus();
});

syncEls.flushBtn.addEventListener('click', async () => {
  syncEls.flushBtn.disabled = true;
  syncEls.status.textContent = 'Flushing…';
  const r = await send({ type: 'SYNC_FLUSH' });
  syncEls.flushBtn.disabled = false;
  refreshSyncStatus();
});

(function init() {
  setStatus('Ready.');
  // Paint the empty shell synchronously, then upgrade as data lands.
  renderList();
  renderRetailer();
  renderRun();
  refreshList();
  refreshRetailer();
  refreshRun();
})();
