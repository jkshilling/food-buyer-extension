// Sync module: batches grocery events in chrome.storage.local and flushes
// them to the meal planner's POST /api/grocery-events.
//
// Design:
//   - SW calls enqueueEvent(event) after each per-item search.
//   - We hold a buffer in storage so events survive SW eviction.
//   - flushNow() sends the whole buffer in one POST. On success, clears it.
//     On failure, keeps the buffer for the next attempt (next item, next
//     run, or whenever flushNow is called).
//   - Configuration (base URL + token) lives in chrome.storage.local under
//     `syncSettings`. If unset, sync is a no-op (returns early). The popup
//     has a Settings tab where the user pastes both.

const STORAGE_KEY_BUFFER = 'syncBuffer';
const STORAGE_KEY_SETTINGS = 'syncSettings';
const STORAGE_KEY_SESSION = 'syncSessionId';
const STORAGE_KEY_LAST = 'syncLastResult';
// Per-event rejection log. The server returns errors[] when some events in
// the batch failed to ingest (typically: a search that found nothing usable
// to anchor a product upsert to). We pair each error with the original
// event so the popup can show the user "X was rejected because Y."
const STORAGE_KEY_REJECTED = 'syncLastRejected';

const MAX_BATCH = 100;
const MAX_BUFFER = 500; // hard cap so a long failure window can't blow storage
const MAX_REJECTED = 100; // cap stored rejection log so it can't grow unbounded

async function getSettings() {
  const { syncSettings } = await chrome.storage.local.get(STORAGE_KEY_SETTINGS);
  return syncSettings || null;
}

export async function setSettings({ baseUrl, token }) {
  const settings = {
    baseUrl: (baseUrl || '').trim().replace(/\/+$/, ''),
    token: (token || '').trim()
  };
  await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: settings });
  return settings;
}

async function getSessionId() {
  const { [STORAGE_KEY_SESSION]: existing } = await chrome.storage.local.get(STORAGE_KEY_SESSION);
  if (existing) return existing;
  // crypto.randomUUID is available in MV3 service workers.
  const id = (self.crypto && self.crypto.randomUUID)
    ? self.crypto.randomUUID()
    : ('s_' + Math.random().toString(36).slice(2) + Date.now().toString(36));
  await chrome.storage.local.set({ [STORAGE_KEY_SESSION]: id });
  return id;
}

export async function enqueueEvent(event) {
  if (!event) return;
  const { [STORAGE_KEY_BUFFER]: buf } = await chrome.storage.local.get(STORAGE_KEY_BUFFER);
  const next = Array.isArray(buf) ? buf.slice() : [];
  next.push(event);
  // Drop oldest if we're past the cap (better than failing to record new
  // events; the dropped ones are old anyway).
  if (next.length > MAX_BUFFER) next.splice(0, next.length - MAX_BUFFER);
  await chrome.storage.local.set({ [STORAGE_KEY_BUFFER]: next });
}

export async function bufferSize() {
  const { [STORAGE_KEY_BUFFER]: buf } = await chrome.storage.local.get(STORAGE_KEY_BUFFER);
  return Array.isArray(buf) ? buf.length : 0;
}

export async function flushNow() {
  const settings = await getSettings();
  if (!settings || !settings.baseUrl || !settings.token) {
    return { ok: false, skipped: 'sync not configured', sent: 0 };
  }

  const { [STORAGE_KEY_BUFFER]: buf } = await chrome.storage.local.get(STORAGE_KEY_BUFFER);
  if (!Array.isArray(buf) || !buf.length) {
    return { ok: true, sent: 0 };
  }

  const batch = buf.slice(0, MAX_BATCH);
  const remaining = buf.slice(batch.length);
  const sessionId = await getSessionId();

  const url = settings.baseUrl + '/api/grocery-events';
  let resp, body;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + settings.token
      },
      body: JSON.stringify({ clientSessionId: sessionId, events: batch })
    });
    try { body = await resp.json(); } catch (_) { body = null; }
  } catch (e) {
    const result = { ok: false, error: String(e && e.message || e), sent: 0, attempted: batch.length };
    await chrome.storage.local.set({ [STORAGE_KEY_LAST]: { ...result, at: Date.now() } });
    return result;
  }

  if (!resp.ok || !body || body.ok === false) {
    const result = {
      ok: false,
      status: resp.status,
      error: (body && body.error) || ('http ' + resp.status),
      sent: 0,
      attempted: batch.length
    };
    // 401 = bad token. Don't keep retrying with the same buffer; surface
    // the error and let the user fix the token.
    await chrome.storage.local.set({ [STORAGE_KEY_LAST]: { ...result, at: Date.now() } });
    return result;
  }

  // Success: drop the sent batch from the buffer.
  await chrome.storage.local.set({ [STORAGE_KEY_BUFFER]: remaining });
  const result = { ok: true, sent: batch.length, ingested: body.ingested || null };
  // If the server reported per-event errors, persist them paired with the
  // original event so "View errors" in the popup can show the user what
  // got rejected and why. Replaces the previous record (we only show the
  // most recent flush's rejections — older ones are ancient by then).
  if (Array.isArray(body.errors) && body.errors.length) {
    const rejected = body.errors.slice(0, MAX_REJECTED).map((err) => ({
      error: err.error || 'unknown',
      event: batch[err.index] || null,
      at: Date.now()
    }));
    await chrome.storage.local.set({ [STORAGE_KEY_REJECTED]: rejected });
    result.rejected = rejected.length;
  } else {
    // Successful flush with no rejections — clear any old rejection log so
    // "View errors" doesn't surface stale data from a previous run.
    await chrome.storage.local.remove(STORAGE_KEY_REJECTED);
  }
  await chrome.storage.local.set({ [STORAGE_KEY_LAST]: { ...result, at: Date.now() } });

  // If there's more buffered, recurse — but cap recursion by yielding.
  if (remaining.length) {
    setTimeout(() => { flushNow(); }, 50);
  }
  return result;
}
