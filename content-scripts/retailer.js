// Injected on every supported retailer site. Content scripts can't use static
// ES imports, so we dynamically import the adapter registry (which is a real
// module and can use static imports internally). Adapters live under
// retailers/ and must be web_accessible_resources in manifest.json.
//
// This file is the only message endpoint on retailer pages. The popup talks
// to it via chrome.tabs.sendMessage.

(async function () {
  'use strict';

  let registry = null;
  let adapter = null;

  try {
    const mod = await import(chrome.runtime.getURL('retailers/index.js'));
    registry = mod.registry;
    adapter = registry.forHost(location.hostname);
  } catch (e) {
    console.error('[food-buyer] failed to load retailer registry:', e);
  }

  function reply(sendResponse, payload) {
    try { sendResponse(payload); } catch (e) { /* channel closed */ }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (!adapter) {
        reply(sendResponse, { ok: false, error: 'no adapter for ' + location.hostname });
        return;
      }
      try {
        switch (msg && msg.type) {
          case 'PING_RETAILER':
            reply(sendResponse, { ok: true, retailer: adapter.name });
            return;

          case 'CHECK_BLOCKED': {
            const blocked = adapter.isBlocked ? !!(await adapter.isBlocked()) : false;
            reply(sendResponse, { ok: true, blocked });
            return;
          }

          case 'OPEN_SEARCH': {
            await adapter.openSearch(msg.query);
            reply(sendResponse, { ok: true });
            return;
          }

          case 'GET_CANDIDATES': {
            const candidates = await adapter.getCandidates();
            reply(sendResponse, { ok: true, candidates });
            return;
          }

          case 'ADD_CURRENT_TO_CART': {
            const result = await adapter.addCurrentToCart();
            reply(sendResponse, { ok: true, result });
            return;
          }

          case 'ADD_CANDIDATE_BY_URL': {
            if (!adapter.addCandidateByUrl) {
              reply(sendResponse, { ok: false, error: 'adapter does not support results-page add' });
              return;
            }
            const result = await adapter.addCandidateByUrl(msg.url);
            reply(sendResponse, { ok: true, result });
            return;
          }

          case 'NAVIGATE_TO': {
            // Adapter may want to drive the page (e.g. open a product URL).
            location.href = msg.url;
            reply(sendResponse, { ok: true });
            return;
          }

          default:
            reply(sendResponse, { ok: false, error: 'unknown message type' });
        }
      } catch (e) {
        reply(sendResponse, { ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  });
})();
