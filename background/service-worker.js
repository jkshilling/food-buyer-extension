// Service worker: state, badge updates, message routing.
//
// Storage shape:
//   shoppingList: { planId, sourceUrl, capturedAt, items: [{ name, quantity, unit, brand }] }
//   lastRun:      { retailer, startedAt, finishedAt, results: [{ name, status, reason?, candidates?, chosen? }] }

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

// Message router. Content scripts post here; popup also posts here.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'SHOPPING_LIST_CAPTURED': {
          const list = msg.payload;
          await chrome.storage.local.set({ shoppingList: list });
          await setBadgeFromList(list);
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
              const u = new URL(tab.url);
              retailer = hostnameToRetailer(u.hostname);
              tabId = tab.id;
            } catch (e) {}
          }
          sendResponse({ ok: true, retailer, tabId });
          break;
        }
        case 'SAVE_LAST_RUN': {
          await chrome.storage.local.set({ lastRun: msg.payload });
          sendResponse({ ok: true });
          break;
        }
        case 'GET_LAST_RUN': {
          const { lastRun } = await chrome.storage.local.get('lastRun');
          sendResponse({ ok: true, lastRun: lastRun || null });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // keep the message channel open for async sendResponse
});
