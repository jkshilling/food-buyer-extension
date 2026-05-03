// Fetch the user's favorite products from the meal planner and expose a
// matcher the SW can use to short-circuit ranking.
//
// Favorites are a hard override of ranking, not a soft bonus: if any
// candidate's URL or Walmart item ID matches a favorite, that candidate is
// the pick. Score, brand, price all bypassed.
//
// We fetch once at the start of each run and cache for the run's duration.
// The set is small (< a few dozen entries in any realistic case), won't
// change mid-run, and one HTTP call per run is cheap.

const FAVORITES_PATH = '/api/grocery/favorites';

let cache = null; // { fetchedAt, urlSet, itemIdSet }

function normalizeUrl(u) {
  return String(u || '').split('?')[0].split('#')[0];
}

export async function loadFavorites({ baseUrl, token } = {}) {
  if (!baseUrl || !token) {
    cache = { fetchedAt: Date.now(), urlSet: new Set(), itemIdSet: new Set() };
    return cache;
  }
  try {
    const resp = await fetch(baseUrl.replace(/\/+$/, '') + FAVORITES_PATH, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!resp.ok) {
      // 401, 5xx, network error — treat as no favorites for this run rather
      // than failing the whole run. The user gets the same behavior as if
      // they had no favorites set; ranking proceeds normally.
      cache = { fetchedAt: Date.now(), urlSet: new Set(), itemIdSet: new Set(), error: 'http ' + resp.status };
      return cache;
    }
    const body = await resp.json();
    const list = Array.isArray(body && body.favorites) ? body.favorites : [];
    const urlSet = new Set();
    const itemIdSet = new Set();
    for (const f of list) {
      if (f.product_url) urlSet.add(normalizeUrl(f.product_url));
      if (f.walmart_item_id) itemIdSet.add(String(f.walmart_item_id));
    }
    cache = { fetchedAt: Date.now(), urlSet, itemIdSet, count: list.length };
    return cache;
  } catch (e) {
    cache = { fetchedAt: Date.now(), urlSet: new Set(), itemIdSet: new Set(), error: String(e && e.message || e) };
    return cache;
  }
}

// Find the first candidate that matches a favorite. Match by either
// URL (canonical /ip/ form, query params stripped) or walmartItemId.
// Returns null if no candidate matches.
export function findFavorite(candidates) {
  if (!cache) return null;
  if (!cache.urlSet.size && !cache.itemIdSet.size) return null;
  for (const c of candidates) {
    if (c.url && cache.urlSet.has(normalizeUrl(c.url))) return c;
    if (c.walmartItemId && cache.itemIdSet.has(String(c.walmartItemId))) return c;
  }
  return null;
}

export function favoritesCount() {
  return cache ? (cache.urlSet.size + cache.itemIdSet.size) : 0;
}

export function clearCache() {
  cache = null;
}
