// Popup is now a thin UI shell. The per-item run loop lives in the service
// worker (see background/service-worker.js) so closing the popup — which
// happens the moment it loses focus, e.g. when the user clicks over to the
// Walmart tab to watch — does not abort the run.
//
// All state is read from chrome.storage.local and live-updated via
// chrome.storage.onChanged. The popup sends START_RUN / STOP_RUN /
// RUN_OVERRIDE messages to the service worker; everything else is plain
// reads.

import { fetchEstimate } from '../lib/estimate.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  status: $('#status-line'),
  itemCount: $('#item-count'),
  sourceLine: $('#source-line'),
  estimateLine: $('#estimate-line'),
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
  run: null,         // persisted runState shape from service worker
  estimate: null     // { summary, estimates } from /api/grocery/price-estimate
};

// Debounce token for the estimate fetch — popup can re-render fast and we
// don't want to hammer the meal planner.
let _estimateInflight = null;

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
  renderEstimate();
  els.runBtn.disabled = !(count > 0 && state.retailer && !isRunning());
  els.stopBtn.disabled = !isRunning();
}

function renderEstimate() {
  const e = state.estimate;
  if (!e || !e.summary || e.summary.totalCount === 0) {
    els.estimateLine.classList.add('hidden');
    els.estimateLine.textContent = '';
    els.estimateLine.classList.remove('over-budget');
    return;
  }
  const s = e.summary;
  els.estimateLine.classList.remove('hidden');

  const amount = `~$${s.total.toFixed(2)}`;
  const detailBits = [];
  if (s.pricedCount < s.totalCount) {
    detailBits.push(`${s.pricedCount}/${s.totalCount} priced`);
  } else {
    detailBits.push('based on last seen prices');
  }
  if (s.weeklyBudget != null) {
    const over = s.total > s.weeklyBudget;
    if (over) {
      detailBits.push(`over $${s.weeklyBudget.toFixed(0)} budget`);
      els.estimateLine.classList.add('over-budget');
    } else {
      detailBits.push(`of $${s.weeklyBudget.toFixed(0)} budget`);
      els.estimateLine.classList.remove('over-budget');
    }
  } else {
    els.estimateLine.classList.remove('over-budget');
  }

  els.estimateLine.innerHTML = '';
  const left = document.createElement('span');
  const amountSpan = document.createElement('span');
  amountSpan.className = 'est-amount';
  amountSpan.textContent = amount;
  left.appendChild(document.createTextNode('Estimated cart total: '));
  left.appendChild(amountSpan);

  const right = document.createElement('span');
  right.className = 'est-detail';
  right.textContent = detailBits.join(' · ');

  els.estimateLine.appendChild(left);
  els.estimateLine.appendChild(right);
}

async function refreshEstimate() {
  if (!state.list || !state.list.items || state.list.items.length === 0) {
    state.estimate = null;
    renderEstimate();
    return;
  }
  // Use the popup's stored sync settings — same path the SW uses for sync.
  const { syncSettings } = await chrome.storage.local.get('syncSettings');
  if (!syncSettings || !syncSettings.baseUrl || !syncSettings.token) {
    state.estimate = null;
    renderEstimate();
    return;
  }
  // De-dupe in-flight requests keyed on the list contents so an init storm
  // doesn't fire multiple parallel fetches.
  const key = JSON.stringify(state.list.items.map((it) => it.name));
  if (_estimateInflight === key) return;
  _estimateInflight = key;
  try {
    const r = await fetchEstimate(syncSettings, state.list.items);
    if (r && r.ok) {
      state.estimate = r;
    } else {
      state.estimate = null;
    }
    renderEstimate();
  } finally {
    _estimateInflight = null;
  }
}

function renderRetailer() {
  if (state.retailer) {
    els.retailerName.textContent = state.retailer.name;
    els.retailerHint.textContent = '';
  } else {
    els.retailerName.textContent = 'none detected';
    els.retailerHint.textContent = 'No supported retailer tab open in any window. Open walmart.com.';
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
    // For non-ok rows, always show the reason. For ok rows, surface it when
    // it tells the user something useful: that the slower fallback path was
    // taken, OR that a favorite override was applied.
    if (r.reason) {
      const isFallbackInfo = r.status === 'ok' && /fell back|product page/i.test(r.reason);
      const isFavoriteInfo = r.status === 'ok' && /^favorite/i.test(r.reason);
      if (r.status !== 'ok' || isFallbackInfo || isFavoriteInfo) parts.push(r.reason);
    }
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
  // Estimate is independent of the soft re-extract below — fire it now from
  // the data we already have so the line shows up fast.
  refreshEstimate();

  // Best-effort: ping any open meal-planner shopping tab to re-extract NOW
  // (no tab reload). The content script's own auto-update covers edits made
  // while the tab is open; this catches edits made on another device or when
  // the tab was reopened after being closed.
  try {
    const tabs = await chrome.tabs.query({ url: 'https://meals.alaskatargeting.com/plan/*/shopping*' });
    if (tabs.length) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'EXTRACT_NOW' }, () => { void chrome.runtime.lastError; });
    }
  } catch (_) {}
}

async function refreshRetailer() {
  // Preference order:
  //   1. Active tab in the current window (if it's a retailer)
  //   2. Most recently active retailer tab in any open window
  // The "any window" fallback covers the common case where Jordan has a
  // Walmart tab open but isn't currently looking at it when clicking the
  // toolbar icon.
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let pick = null;
  if (activeTab && activeTab.url) {
    try {
      const r = hostnameToRetailer(new URL(activeTab.url).hostname);
      if (r) pick = { name: r, tabId: activeTab.id };
    } catch (_) {}
  }
  if (!pick) {
    // Walmart-only for now since the other adapters are stubs. Update the
    // host-permissions in manifest.json if adding more retailers; the URL
    // patterns here have to stay in sync.
    const tabs = await chrome.tabs.query({
      url: ['https://www.walmart.com/*', 'https://walmart.com/*']
    });
    if (tabs.length) {
      // Prefer the most recently accessed one.
      tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      pick = { name: 'walmart', tabId: tabs[0].id };
    }
  }
  state.retailer = pick;
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
  // Hard refresh: full tab reload. Use only when the soft re-extract
  // (refreshList → EXTRACT_NOW) isn't enough — e.g. the page is in a
  // weird state. The popup auto-runs the soft path on every open.
  const tabs = await chrome.tabs.query({ url: 'https://meals.alaskatargeting.com/plan/*/shopping*' });
  if (tabs.length) {
    await chrome.tabs.reload(tabs[0].id);
    setStatus('Hard-reloaded meal-planner tab.');
  } else {
    setStatus('No meal-planner shopping tab open — open one to refresh.');
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

document.querySelector('#clear-results-btn').addEventListener('click', async () => {
  await send({ type: 'CLEAR_RUN_STATE' });
  setStatus('Results cleared.');
});

// Live updates while popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.shoppingList) {
    state.list = changes.shoppingList.newValue || null;
    renderList();
    refreshEstimate();
  }
  if (changes.runState) {
    state.run = changes.runState.newValue || null;
    renderRun();
    renderList();
  }
  if (changes.syncSettings) {
    // Token or base URL just changed — try the estimate again now that we
    // (might) have working credentials.
    refreshEstimate();
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
  peekBtn: document.querySelector('#sync-peek-btn'),
  clearBtn: document.querySelector('#sync-clear-btn'),
  status: document.querySelector('#sync-status'),
  bufferList: document.querySelector('#sync-buffer-list')
};

// The meal planner is a single deployment for this user; no other base URL
// is realistic. Default the field to it so first-time setup is just "paste
// token, click Save."
const DEFAULT_BASE_URL = 'https://meals.alaskatargeting.com';

async function refreshSyncStatus() {
  const { syncSettings } = await chrome.storage.local.get('syncSettings');
  // Always pre-fill both fields with the saved values. The input is type=
  // "password" so the token still renders as dots, but the actual value is
  // there for editing without re-pasting. Persists across popup opens.
  syncEls.baseUrl.value = (syncSettings && syncSettings.baseUrl) || DEFAULT_BASE_URL;
  syncEls.token.value = (syncSettings && syncSettings.token) || '';

  const hasToken = !!(syncSettings && syncSettings.token);
  if (hasToken) {
    const masked = syncSettings.token.slice(0, 4) + '…' + syncSettings.token.slice(-4);
    syncEls.tokenState.textContent = `✓ Token saved (${masked}).`;
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
  const token = syncEls.token.value.trim();
  if (!baseUrl || !token) {
    syncEls.status.textContent = 'Need both a base URL and a token.';
    return;
  }
  await chrome.storage.local.set({ syncSettings: { baseUrl: baseUrl.replace(/\/+$/, ''), token } });
  syncEls.status.textContent = 'Saved.';
  // Don't clear the token field — keep what was just saved visible (rendered
  // as dots since the input is type="password") so the user knows it
  // persists and can be edited without re-pasting.
  refreshSyncStatus();
});

syncEls.flushBtn.addEventListener('click', async () => {
  syncEls.flushBtn.disabled = true;
  syncEls.status.textContent = 'Flushing…';
  const r = await send({ type: 'SYNC_FLUSH' });
  syncEls.flushBtn.disabled = false;
  refreshSyncStatus();
});

syncEls.clearBtn.addEventListener('click', async () => {
  if (!confirm('Drop all events waiting to sync? Anything already sent to the meal planner stays. This cannot be undone.')) return;
  syncEls.clearBtn.disabled = true;
  await send({ type: 'SYNC_CLEAR_BUFFER' });
  syncEls.clearBtn.disabled = false;
  syncEls.bufferList.classList.add('hidden');
  refreshSyncStatus();
});

syncEls.peekBtn.addEventListener('click', async () => {
  if (!syncEls.bufferList.classList.contains('hidden')) {
    syncEls.bufferList.classList.add('hidden');
    syncEls.peekBtn.textContent = 'View unsent';
    return;
  }
  const r = await send({ type: 'SYNC_BUFFER_PEEK' });
  syncEls.bufferList.innerHTML = '';
  const summary = (r && r.summary) || [];
  if (!summary.length) {
    const li = document.createElement('li');
    li.className = 'meta';
    li.textContent = 'Buffer is empty.';
    syncEls.bufferList.appendChild(li);
  } else {
    summary.forEach((e) => {
      const li = document.createElement('li');
      const q = document.createElement('div');
      q.className = 'bq';
      q.textContent = `${e.retailer || '?'} — "${e.query || ''}"`;
      const m = document.createElement('div');
      m.className = 'meta';
      const bits = [];
      bits.push(`${e.resultCount} result${e.resultCount === 1 ? '' : 's'}`);
      bits.push(e.pickSource);
      if (e.pickedTitle) bits.push(`picked: ${e.pickedTitle}`);
      if (e.searchedAt) bits.push(new Date(e.searchedAt).toLocaleTimeString());
      m.textContent = bits.join(' · ');
      li.appendChild(q);
      li.appendChild(m);
      syncEls.bufferList.appendChild(li);
    });
  }
  syncEls.bufferList.classList.remove('hidden');
  syncEls.peekBtn.textContent = 'Hide unsent';
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
