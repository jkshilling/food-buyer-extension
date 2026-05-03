// Runs on https://meals.alaskatargeting.com/plan/<N>/shopping
// Extracts approved shopping items from the table and persists them via the
// service worker. We re-extract whenever the table mutates (rows added, items
// approved/unapproved, quantities edited) so the badge stays in sync.

(function () {
  'use strict';

  function parsePlanId(pathname) {
    const m = pathname.match(/\/plan\/(\d+)\/shopping/);
    return m ? m[1] : null;
  }

  function extract() {
    const rows = document.querySelectorAll('table.grid-table tbody tr');
    const items = [];
    rows.forEach((row) => {
      const approved = row.querySelector('input[type="checkbox"][name="approved"]');
      // Only include rows the user has approved.
      if (!approved || !approved.checked) return;

      const name = row.querySelector('input[name="name"]');
      const qty = row.querySelector('input[name="quantity"]');
      const unit = row.querySelector('input[name="unit"]');
      const brand = row.querySelector('input[name="brand"]');

      const nameVal = name && name.value ? name.value.trim() : '';
      if (!nameVal) return;

      items.push({
        name: nameVal,
        quantity: qty && qty.value ? qty.value.trim() : '',
        unit: unit && unit.value ? unit.value.trim() : '',
        brand: brand && brand.value ? brand.value.trim() : ''
      });
    });
    return items;
  }

  function send(items) {
    const payload = {
      planId: parsePlanId(location.pathname),
      sourceUrl: location.href,
      capturedAt: new Date().toISOString(),
      items
    };
    chrome.runtime.sendMessage({ type: 'SHOPPING_LIST_CAPTURED', payload }, () => {
      // Swallow lastError — popup may be closed, service worker may be reloading.
      void chrome.runtime.lastError;
    });
  }

  // Debounced re-extract so checkbox/input toggling doesn't spam the service worker.
  let timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      send(extract());
    }, 250);
  }

  // Initial capture.
  schedule();

  // Allow the popup to ask for a fresh re-extract on open without doing a
  // full chrome.tabs.reload (which is slow and resets scroll/inputs).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'EXTRACT_NOW') {
      const items = extract();
      send(items);
      try { sendResponse({ ok: true, count: items.length }); } catch (_) {}
      return true;
    }
  });

  // Watch for any mutation inside the shopping table — row adds, edits, toggles.
  const table = document.querySelector('table.grid-table');
  if (table) {
    const obs = new MutationObserver(schedule);
    obs.observe(table, { subtree: true, childList: true, attributes: true });
    table.addEventListener('input', schedule, true);
    table.addEventListener('change', schedule, true);
  }
})();
