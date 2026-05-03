// Popup orchestrator.
//
// Responsibilities:
//   - Show shopping list + detected retailer
//   - Drive the per-item search → rank → add-to-cart loop
//   - Surface per-item status and a manual override dropdown for low-
//     confidence matches
//
// Cross-tab coordination:
//   - The popup talks to the retailer's content script via chrome.tabs.sendMessage
//   - Search and product navigations reload the content script. We wait for
//     chrome.tabs.onUpdated 'complete' before the next message.

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
  retailer: null, // { name: 'walmart', tabId }
  results: [],    // [{ name, status, reason?, candidates?, chosen? }]
  running: false,
  stopRequested: false
};

// ---------- helpers ----------

function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(resp || { ok: false, error: 'no response' });
    });
  });
}

function tabSend(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(resp || { ok: false, error: 'no response' });
    });
  });
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(t);
      resolve(ok);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    const t = setTimeout(() => finish(false), timeoutMs);
    // Also check current status — page may already be 'complete'.
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === 'complete') {
        // Give the page a beat to re-inject the content script.
        setTimeout(() => finish(true), 600);
      }
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- matching / ranking ----------

const STOPWORDS = new Set(['of', 'the', 'a', 'an', 'and', 'or', 'with', 'for', 'in', 'on']);

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function score(item, candidate) {
  const itemTokens = tokenize(item.name);
  const candTokens = tokenize(candidate.title);
  const nameSim = jaccard(itemTokens, candTokens);

  // Brand bonus: if user specified a brand and it appears in the title.
  let brandBonus = 0;
  if (item.brand) {
    const brandTokens = tokenize(item.brand);
    const candText = candTokens.join(' ');
    if (brandTokens.every((b) => candText.includes(b))) brandBonus = 0.2;
  }

  // Size hint: if user specified a unit/quantity and it appears in title
  // or candidate.size, small bonus.
  let sizeBonus = 0;
  if (item.quantity || item.unit) {
    const sizeText = ((candidate.size || '') + ' ' + candidate.title).toLowerCase();
    if (item.quantity && sizeText.includes(String(item.quantity).toLowerCase())) sizeBonus += 0.05;
    if (item.unit && sizeText.includes(String(item.unit).toLowerCase())) sizeBonus += 0.05;
  }

  return Math.min(1, nameSim + brandBonus + sizeBonus);
}

function rankCandidates(item, candidates) {
  const scored = candidates.map((c) => ({ ...c, _score: score(item, c) }));
  scored.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    // Tiebreaker: cheaper first.
    const ap = a.price == null ? Infinity : a.price;
    const bp = b.price == null ? Infinity : b.price;
    return ap - bp;
  });
  return scored;
}

function classify(scoreVal) {
  if (scoreVal >= 0.5) return 'ok';
  if (scoreVal >= 0.25) return 'review';
  return 'fail';
}

// ---------- rendering ----------

function setStatus(msg) {
  els.status.textContent = msg;
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
  els.runBtn.disabled = !(count > 0 && state.retailer && !state.running);
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

function renderResults() {
  if (!state.results.length) {
    els.resultsSection.classList.add('hidden');
    return;
  }
  els.resultsSection.classList.remove('hidden');
  els.resultsList.innerHTML = '';
  state.results.forEach((r, idx) => {
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
    if (r.chosen) {
      meta.textContent = `→ ${r.chosen.title}` + (r.chosen.price != null ? ` ($${r.chosen.price.toFixed(2)})` : '');
    } else if (r.reason) {
      meta.textContent = r.reason;
    }
    li.appendChild(meta);

    // Manual override: any item with candidates may have its choice swapped.
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
      btn.addEventListener('click', () => addOverride(idx, parseInt(sel.value, 10)));
      wrap.appendChild(sel);
      wrap.appendChild(btn);
      li.appendChild(wrap);
    }

    els.resultsList.appendChild(li);
  });
}

function setProgress(done, total, elapsedMs) {
  els.progressSection.classList.remove('hidden');
  els.progressText.textContent = `${done} / ${total}`;
  const pct = total ? Math.round((done / total) * 100) : 0;
  els.progressFill.style.width = pct + '%';
  if (elapsedMs != null) {
    els.progressElapsed.textContent = `${(elapsedMs / 1000).toFixed(1)}s`;
  }
}

// ---------- run loop ----------

async function runOne(tabId, item, retailerName) {
  // 1) Search.
  await tabSend(tabId, { type: 'OPEN_SEARCH', query: searchQueryFor(item) });
  // openSearch sets location.href, which reloads the content script.
  await waitForTabComplete(tabId);
  // Small grace period for adapter to load + lazy results to render.
  await sleep(800);

  // 2) Bot-protection check.
  const blockedResp = await tabSend(tabId, { type: 'CHECK_BLOCKED' });
  if (blockedResp.ok && blockedResp.blocked) {
    return { status: 'fail', reason: 'bot-protection challenge — solve it in the tab and retry' };
  }

  // 3) Candidates.
  const candResp = await tabSend(tabId, { type: 'GET_CANDIDATES' });
  if (!candResp.ok) {
    return { status: 'fail', reason: 'getCandidates: ' + candResp.error };
  }
  const candidatesRaw = (candResp.candidates && candResp.candidates.items) || [];
  if (!candidatesRaw.length) {
    return { status: 'fail', reason: 'no search results' };
  }
  const ranked = rankCandidates(item, candidatesRaw);
  const top = ranked[0];
  const klass = classify(top._score);

  if (klass === 'review') {
    // Surface candidates so the user can pick. Do not auto-add.
    return {
      status: 'review',
      reason: `low-confidence match (${top._score.toFixed(2)}) — pick one`,
      candidates: ranked.slice(0, 8),
      chosen: top
    };
  }
  if (klass === 'fail') {
    return {
      status: 'fail',
      reason: `no good match (top score ${top._score.toFixed(2)})`,
      candidates: ranked.slice(0, 8),
      chosen: top
    };
  }

  // 4) Navigate to product page and add.
  const addResult = await navigateAndAdd(tabId, top.url);
  if (!addResult.ok) {
    return {
      status: 'fail',
      reason: addResult.reason || 'addCurrentToCart failed',
      candidates: ranked.slice(0, 8),
      chosen: top
    };
  }
  return {
    status: 'ok',
    candidates: ranked.slice(0, 8),
    chosen: top
  };
}

async function navigateAndAdd(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitForTabComplete(tabId);
  await sleep(800);
  const blockedResp = await tabSend(tabId, { type: 'CHECK_BLOCKED' });
  if (blockedResp.ok && blockedResp.blocked) {
    return { ok: false, reason: 'bot-protection challenge on product page' };
  }
  const resp = await tabSend(tabId, { type: 'ADD_CURRENT_TO_CART' });
  if (!resp.ok) return { ok: false, reason: resp.error };
  return resp.result || { ok: false, reason: 'no result' };
}

function searchQueryFor(item) {
  // Walmart's search ranks better with brand + name than with quantity/unit.
  const parts = [item.brand, item.name].filter(Boolean);
  return parts.join(' ').trim();
}

async function runAll() {
  if (!state.list || !state.retailer || state.running) return;
  state.running = true;
  state.stopRequested = false;
  state.results = state.list.items.map((it) => ({
    name: it.name, status: 'pending'
  }));
  els.runBtn.disabled = true;
  els.stopBtn.disabled = false;
  renderResults();

  const startedAt = Date.now();
  setProgress(0, state.list.items.length, 0);

  for (let i = 0; i < state.list.items.length; i++) {
    if (state.stopRequested) break;
    const item = state.list.items[i];
    setStatus(`Processing: ${item.name}`);
    let outcome;
    try {
      outcome = await runOne(state.retailer.tabId, item, state.retailer.name);
    } catch (e) {
      outcome = { status: 'fail', reason: String(e && e.message || e) };
    }
    state.results[i] = { name: item.name, ...outcome };
    setProgress(i + 1, state.list.items.length, Date.now() - startedAt);
    renderResults();
  }

  await send('SAVE_LAST_RUN', { payload: {
    retailer: state.retailer.name,
    startedAt,
    finishedAt: Date.now(),
    results: state.results
  }});

  state.running = false;
  els.stopBtn.disabled = true;
  renderList();
  setStatus(state.stopRequested ? 'Stopped.' : 'Done. Review cart manually before checkout.');
}

async function addOverride(resultIdx, candidateIdx) {
  const result = state.results[resultIdx];
  if (!result || !result.candidates) return;
  const chosen = result.candidates[candidateIdx];
  if (!chosen || !state.retailer) return;
  setStatus(`Adding override: ${chosen.title}`);
  const addResult = await navigateAndAdd(state.retailer.tabId, chosen.url);
  if (addResult.ok) {
    state.results[resultIdx] = { ...result, status: 'ok', chosen, reason: undefined };
    setStatus('Override added.');
  } else {
    state.results[resultIdx] = { ...result, status: 'fail', chosen, reason: addResult.reason };
    setStatus('Override failed: ' + addResult.reason);
  }
  renderResults();
}

// ---------- init ----------

async function refreshList() {
  const r = await send('GET_SHOPPING_LIST');
  state.list = (r.ok && r.shoppingList) || null;
  renderList();
}

async function refreshRetailer() {
  const r = await send('GET_ACTIVE_RETAILER');
  if (r.ok && r.retailer && r.tabId) {
    state.retailer = { name: r.retailer, tabId: r.tabId };
  } else {
    state.retailer = null;
  }
  renderRetailer();
}

els.refreshBtn.addEventListener('click', async () => {
  // Ask any meal-planner tab to re-extract by reloading it.
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
  setTimeout(async () => {
    state.retailer = { name: 'walmart', tabId: tab.id };
    renderRetailer();
  }, 500);
});

els.runBtn.addEventListener('click', () => { runAll(); });
els.stopBtn.addEventListener('click', () => {
  state.stopRequested = true;
  setStatus('Stop requested — finishing current item.');
});

// React to storage changes (e.g. content script captured a new list).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.shoppingList) {
    state.list = changes.shoppingList.newValue || null;
    renderList();
  }
});

(async function init() {
  setStatus('Ready.');
  await Promise.all([refreshList(), refreshRetailer()]);
})();
