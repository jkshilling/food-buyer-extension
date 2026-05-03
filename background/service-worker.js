// Service worker: state, badge updates, message routing, AND the per-item
// run loop. Orchestration lives here (not in the popup) because Chrome
// dismisses popup windows the moment they lose focus, which would kill any
// run-in-progress the moment the user clicked over to the retailer tab to
// watch what was happening.
//
// Storage shape:
//   shoppingList: { planId, sourceUrl, capturedAt, items: [{ name, quantity, unit, brand }] }
//   runState: {
//     status: 'idle' | 'running' | 'done' | 'stopped' | 'error',
//     retailer, tabId, startedAt, finishedAt?, currentIndex, total,
//     currentItem?, statusLine?,
//     results: [{ name, status: 'pending'|'ok'|'review'|'fail', reason?, candidates?, chosen? }]
//   }

import { rankCandidates, classify, searchQueryFor } from '../lib/ranking.js';
import { enqueueEvent, flushNow, bufferSize } from '../lib/sync.js';

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

// ---------- badge ----------

async function setBadgeFromList(list) {
  const count = list && Array.isArray(list.items) ? list.items.length : 0;
  if (count > 0) {
    await chrome.action.setBadgeText({ text: String(count) });
    await chrome.action.setBadgeBackgroundColor({ color: '#1f7a3a' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const { shoppingList } = await chrome.storage.local.get('shoppingList');
  await setBadgeFromList(shoppingList);
});

chrome.runtime.onStartup.addListener(async () => {
  const { shoppingList } = await chrome.storage.local.get('shoppingList');
  await setBadgeFromList(shoppingList);
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.shoppingList) {
    await setBadgeFromList(changes.shoppingList.newValue);
  }
});

// ---------- run state ----------
//
// Held in module-level memory AND persisted to storage on every change so
// the popup can render live progress via storage.onChanged. If the SW is
// evicted mid-run, the persisted snapshot lets the popup show the last
// known state (and the run halts — that's the price of the SW lifecycle).

let runState = null;
let stopRequested = false;

async function persistRunState() {
  await chrome.storage.local.set({ runState });
}

async function setRunStatusLine(line) {
  if (!runState) return;
  runState.statusLine = line;
  await persistRunState();
}

async function setResultAt(idx, result) {
  if (!runState) return;
  runState.results[idx] = result;
  await persistRunState();
}

// ---------- low-level helpers ----------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) { finish(false); return; }
      if (tab && tab.status === 'complete') {
        // Content script needs a beat to re-inject after navigation.
        setTimeout(() => finish(true), 700);
      }
    });
  });
}

// ---------- run loop ----------

async function navigateAndAdd(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitForTabComplete(tabId);
  await sleep(900);
  const blockedResp = await tabSend(tabId, { type: 'CHECK_BLOCKED' });
  if (blockedResp.ok && blockedResp.blocked) {
    return { ok: false, reason: 'bot-protection challenge on product page' };
  }
  const resp = await tabSend(tabId, { type: 'ADD_CURRENT_TO_CART' });
  if (!resp.ok) return { ok: false, reason: resp.error };
  return resp.result || { ok: false, reason: 'no result' };
}

// Map our internal candidate shape to the wire shape the meal planner
// expects. Stripping _score (computed locally, not interesting to persist).
function toWireResult(c) {
  return {
    url: c.url,
    walmartItemId: c.walmartItemId || null,
    title: c.title,
    brand: c.brand || null,
    sizeText: c.size || null,
    price: typeof c.price === 'number' ? c.price : null,
    imageUrl: c.imageUrl || null,
    rating: c.rating || null,
    reviewCount: c.reviewCount || null,
    availability: c.availability || null,
    sponsored: !!c.sponsored,
    position: c.position || null
  };
}

async function recordSearchEvent({ retailer, query, candidates, chosen, pickSource, shoppingItemId }) {
  try {
    await enqueueEvent({
      retailer,
      query,
      shoppingItemId: shoppingItemId || null,
      pickSource,                // 'auto' | 'override' | 'failed'
      pickedUrl: chosen ? chosen.url : null,
      results: (candidates || []).map(toWireResult),
      searchedAt: new Date().toISOString()
    });
  } catch (e) {
    // Sync is best-effort. A failed enqueue must not break the run.
    console.warn('[food-buyer] enqueueEvent failed:', e);
  }
}

async function runOne(tabId, item, retailerName) {
  const query = searchQueryFor(item);

  await tabSend(tabId, { type: 'OPEN_SEARCH', query });
  await waitForTabComplete(tabId);
  await sleep(900);

  const blockedResp = await tabSend(tabId, { type: 'CHECK_BLOCKED' });
  if (blockedResp.ok && blockedResp.blocked) {
    await recordSearchEvent({ retailer: retailerName, query, candidates: [], chosen: null, pickSource: 'failed' });
    return { status: 'fail', reason: 'bot-protection challenge — solve it in the tab and retry' };
  }

  const candResp = await tabSend(tabId, { type: 'GET_CANDIDATES' });
  if (!candResp.ok) {
    await recordSearchEvent({ retailer: retailerName, query, candidates: [], chosen: null, pickSource: 'failed' });
    return { status: 'fail', reason: 'getCandidates: ' + candResp.error };
  }
  const candidatesRaw = (candResp.candidates && candResp.candidates.items) || [];
  if (!candidatesRaw.length) {
    await recordSearchEvent({ retailer: retailerName, query, candidates: [], chosen: null, pickSource: 'failed' });
    return { status: 'fail', reason: 'no search results' };
  }

  const ranked = rankCandidates(item, candidatesRaw);
  const top = ranked[0];
  const klass = classify(top._score);

  if (klass === 'review') {
    // Don't record a pick yet — user may override. The override path records
    // its own event with pickSource='override'.
    await recordSearchEvent({ retailer: retailerName, query, candidates: candidatesRaw, chosen: null, pickSource: 'failed' });
    return {
      status: 'review',
      reason: `low-confidence match (${top._score.toFixed(2)}) — pick one`,
      candidates: ranked.slice(0, 8),
      chosen: top
    };
  }
  if (klass === 'fail') {
    await recordSearchEvent({ retailer: retailerName, query, candidates: candidatesRaw, chosen: null, pickSource: 'failed' });
    return {
      status: 'fail',
      reason: `no good match (top score ${top._score.toFixed(2)})`,
      candidates: ranked.slice(0, 8),
      chosen: top
    };
  }

  const addResult = await navigateAndAdd(tabId, top.url);
  if (!addResult.ok) {
    await recordSearchEvent({ retailer: retailerName, query, candidates: candidatesRaw, chosen: null, pickSource: 'failed' });
    return {
      status: 'fail',
      reason: addResult.reason || 'addCurrentToCart failed',
      candidates: ranked.slice(0, 8),
      chosen: top
    };
  }
  await recordSearchEvent({ retailer: retailerName, query, candidates: candidatesRaw, chosen: top, pickSource: 'auto' });
  return {
    status: 'ok',
    candidates: ranked.slice(0, 8),
    chosen: top
  };
}

async function startRun({ tabId, retailerName }) {
  if (runState && runState.status === 'running') {
    return { ok: false, error: 'run already in progress' };
  }
  const { shoppingList } = await chrome.storage.local.get('shoppingList');
  if (!shoppingList || !shoppingList.items || !shoppingList.items.length) {
    return { ok: false, error: 'no shopping list' };
  }
  // Re-verify the tab is still on the right retailer.
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch (_) {
    return { ok: false, error: 'tab no longer open' };
  }
  const liveRetailer = tab && tab.url ? hostnameToRetailer(new URL(tab.url).hostname) : null;
  if (!liveRetailer) {
    return { ok: false, error: 'active tab is not a supported retailer' };
  }

  stopRequested = false;
  runState = {
    status: 'running',
    retailer: liveRetailer,
    tabId,
    startedAt: Date.now(),
    currentIndex: 0,
    total: shoppingList.items.length,
    currentItem: null,
    statusLine: 'Starting…',
    results: shoppingList.items.map((it) => ({ name: it.name, status: 'pending' }))
  };
  await persistRunState();

  // Fire-and-forget the loop. Caller doesn't wait.
  (async () => {
    try {
      for (let i = 0; i < shoppingList.items.length; i++) {
        if (stopRequested) break;
        const item = shoppingList.items[i];
        runState.currentIndex = i;
        runState.currentItem = item.name;
        await setRunStatusLine(`Processing: ${item.name}`);
        let outcome;
        try {
          outcome = await runOne(tabId, item, liveRetailer);
        } catch (e) {
          outcome = { status: 'fail', reason: String(e && e.message || e) };
        }
        await setResultAt(i, { name: item.name, ...outcome });
      }
      runState.status = stopRequested ? 'stopped' : 'done';
      runState.finishedAt = Date.now();
      runState.statusLine = stopRequested ? 'Stopped.' : 'Done. Review cart manually before checkout.';
      await persistRunState();
      // Best-effort flush of buffered events to the meal planner. If this
      // fails (no token, server down) the buffer waits for the next run.
      try {
        const r = await flushNow();
        if (!r.ok && r.skipped !== 'sync not configured') {
          runState.statusLine += ' (sync: ' + (r.error || 'failed') + ')';
          await persistRunState();
        }
      } catch (_) { /* swallow */ }
    } catch (e) {
      runState.status = 'error';
      runState.finishedAt = Date.now();
      runState.statusLine = 'Error: ' + String(e && e.message || e);
      await persistRunState();
    }
  })();

  return { ok: true };
}

async function applyOverride({ resultIndex, candidateIndex }) {
  if (!runState || !runState.results) return { ok: false, error: 'no run to override' };
  const result = runState.results[resultIndex];
  if (!result || !result.candidates) return { ok: false, error: 'no candidates for that row' };
  const chosen = result.candidates[candidateIndex];
  if (!chosen) return { ok: false, error: 'no such candidate' };
  await setRunStatusLine(`Adding override: ${chosen.title}`);
  const addResult = await navigateAndAdd(runState.tabId, chosen.url);
  const updated = addResult.ok
    ? { ...result, status: 'ok', chosen, reason: undefined }
    : { ...result, status: 'fail', chosen, reason: addResult.reason };
  await setResultAt(resultIndex, updated);
  // Record the override as its own search event so user_confirmed bumps in
  // ingredient_products on the meal-planner side. The meal-planner flips
  // user_confirmed=1 when pickSource is 'override'.
  await recordSearchEvent({
    retailer: runState.retailer,
    query: result.name,
    candidates: result.candidates,
    chosen,
    pickSource: addResult.ok ? 'override' : 'failed'
  });
  await setRunStatusLine(addResult.ok ? 'Override added.' : 'Override failed: ' + addResult.reason);
  return { ok: true };
}

// ---------- message router ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'SHOPPING_LIST_CAPTURED': {
          await chrome.storage.local.set({ shoppingList: msg.payload });
          await setBadgeFromList(msg.payload);
          sendResponse({ ok: true });
          break;
        }
        case 'GET_SHOPPING_LIST': {
          const { shoppingList } = await chrome.storage.local.get('shoppingList');
          sendResponse({ ok: true, shoppingList: shoppingList || null });
          break;
        }
        case 'CLEAR_SHOPPING_LIST': {
          await chrome.storage.local.remove('shoppingList');
          await setBadgeFromList(null);
          sendResponse({ ok: true });
          break;
        }
        case 'GET_ACTIVE_RETAILER': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          let retailer = null;
          let tabId = null;
          if (tab && tab.url) {
            try {
              retailer = hostnameToRetailer(new URL(tab.url).hostname);
              tabId = tab.id;
            } catch (_) {}
          }
          sendResponse({ ok: true, retailer, tabId });
          break;
        }
        case 'START_RUN': {
          const r = await startRun({ tabId: msg.tabId, retailerName: msg.retailer });
          sendResponse(r);
          break;
        }
        case 'STOP_RUN': {
          stopRequested = true;
          sendResponse({ ok: true });
          break;
        }
        case 'GET_RUN_STATE': {
          const { runState: persisted } = await chrome.storage.local.get('runState');
          sendResponse({ ok: true, runState: persisted || null });
          break;
        }
        case 'CLEAR_RUN_STATE': {
          runState = null;
          stopRequested = false;
          await chrome.storage.local.remove('runState');
          sendResponse({ ok: true });
          break;
        }
        case 'RUN_OVERRIDE': {
          const r = await applyOverride({
            resultIndex: msg.resultIndex,
            candidateIndex: msg.candidateIndex
          });
          sendResponse(r);
          break;
        }
        case 'SYNC_FLUSH': {
          const r = await flushNow();
          sendResponse({ ok: true, result: r });
          break;
        }
        case 'SYNC_STATUS': {
          const [{ syncSettings }, size, { syncLastResult }] = await Promise.all([
            chrome.storage.local.get('syncSettings'),
            bufferSize(),
            chrome.storage.local.get('syncLastResult')
          ]);
          sendResponse({
            ok: true,
            configured: !!(syncSettings && syncSettings.baseUrl && syncSettings.token),
            baseUrl: syncSettings ? syncSettings.baseUrl : null,
            tokenSet: !!(syncSettings && syncSettings.token),
            buffered: size,
            last: syncLastResult || null
          });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true;
});
