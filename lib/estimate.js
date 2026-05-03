// Cart cost preview. Asks the meal planner for the user's likely product
// per shopping-list item (cascading through favorites → confirmed mappings
// → algorithmic mappings → recent searches) and returns the sum of last-
// seen prices.
//
// Best-effort: if sync isn't configured or the request fails, returns a
// null estimate so the popup just hides the line. Never throws.

const ESTIMATE_PATH = '/api/grocery/price-estimate';

export async function fetchEstimate({ baseUrl, token }, items) {
  if (!baseUrl || !token) return null;
  if (!Array.isArray(items) || items.length === 0) return null;
  try {
    const resp = await fetch(baseUrl.replace(/\/+$/, '') + ESTIMATE_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ items: items.map((it) => ({ name: it.name })) })
    });
    if (!resp.ok) return { error: 'http ' + resp.status };
    const body = await resp.json();
    if (!body || body.ok === false) return { error: (body && body.error) || 'bad response' };
    return body;
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}
