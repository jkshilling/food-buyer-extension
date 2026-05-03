// Walmart adapter.
//
// Selectors are the realistic flake point. Walmart rotates DOM frequently and
// uses PerimeterX bot protection. Keep all DOM coupling in `selectors` so
// the next time something breaks, only one block needs editing.
//
// The adapter assumes it is running in the user's real, logged-in browser
// session — that's the whole reason this is a Chrome extension and not
// server-side Playwright (see README).

const SEARCH_URL = (q) => `https://www.walmart.com/search?q=${encodeURIComponent(q)}`;

const selectors = {
  searchInput: 'input[name="q"], input[aria-label="Search"], input[type="search"]',
  searchButton: 'button[aria-label="Search icon"], button[type="submit"][aria-label*="earch"]',

  // [data-testid="item-stack"] is the search-results region. Scoping to it
  // avoids picking up carousels and "related items" rows below the fold.
  // 2026-05-03: probed live, 52 matches inside the stack vs 66 unscoped.
  productCard: '[data-testid="item-stack"] [data-item-id], div[role="group"][data-item-id], div[data-item-id]',
  productTitle: 'span[data-automation-id="product-title"], span.lh-title, [data-automation-id="product-title"]',
  productPrice: '[data-automation-id="product-price"] span.mr1, [data-automation-id="product-price"] span, div[data-automation-id="product-price"], [data-automation-id*="price"]',
  productLink: 'a[link-identifier], a[href*="/ip/"]',
  productSize: '[data-automation-id="product-price"] + div, span.gray, .f7.gray',
  productImage: 'img[data-testid="productTileImage"], img[src*="i5.walmartimages.com"], img[loading="lazy"]',
  productRating: '[data-testid="reviews-rating"], [aria-label*="out of 5"], span[class*="rating"]',
  productReviewCount: '[data-testid="reviews-count"], a[aria-label*="rating"], span[class*="review-count"]',
  // querySelector doesn't support :has-text — that's Playwright syntax. We
  // probe for the data attribute here and fall back to a text-content scan
  // in detectSponsored() below.
  productSponsored: '[data-automation-id="sponsored-flag"], [data-testid="sponsored-flag"]',
  productAvailability: '[data-automation-id="fulfillment"], [data-testid="fulfillment-text"]',

  addToCartButton: 'button[data-automation-id="atc"], button[data-automation-id="add-to-cart"], button[aria-label^="Add to cart"]',
  // The +Add button on a search-results card. Probed live 2026-05-03:
  // data-automation-id="add-to-cart" is the stable hook; aria-label fallback
  // catches re-skinning. Choose-options variants use a different button so
  // this selector won't match those, which is correct — caller falls back
  // to navigateAndAdd for those SKUs.
  cardAddToCartButton: 'button[data-automation-id="add-to-cart"], button[aria-label^="Add to cart - "]',
  cartConfirm: '[data-testid="cart-preview"], [data-automation-id="cart-preview"]',

  captchaIndicator: '[data-testid="captcha"], iframe[src*="captcha"], #px-captcha, [id^="px-captcha"]'
};

function $(sel, root = document) {
  return root.querySelector(sel);
}
function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Walmart wraps sponsored placements in a tracking redirect:
//   <a link-identifier="..." href="/sp/track?bt=1&plmt=sb-search-top~..." />
// alongside the canonical product link:
//   <a href="/ip/Sara-Lee.../12345" />
//
// querySelector with comma-OR'd selectors returns whichever element comes
// first in document order, regardless of which alternative matched. On
// sponsored cards the tracking link is first, so we got that URL — which
// changes per render and never matches anything on subsequent visits.
//
// Always prefer an /ip/ link if any anchor in the card has one. Only fall
// back to a non-tracking link-identifier when there's no /ip/ option.
function findProductLink(card) {
  const ipLink = card.querySelector('a[href*="/ip/"]');
  if (ipLink) return ipLink;
  const anchors = card.querySelectorAll('a[link-identifier]');
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    if (href && !/\/sp\/track/.test(href)) return a;
  }
  return null;
}

async function waitFor(sel, { timeoutMs = 15000, root = document } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const el = root.querySelector(sel);
    if (el) return el;
    await sleep(150);
  }
  return null;
}

function isBlocked() {
  return !!document.querySelector(selectors.captchaIndicator);
}

async function openSearch(query) {
  if (!query) return;
  // Cheapest reliable path: drive the URL. Avoids brittle "find the search box,
  // type into it, click submit" dance which breaks every time Walmart shuffles
  // the header.
  const target = SEARCH_URL(query);
  if (location.href !== target) {
    location.href = target;
    // Navigation interrupts execution; the popup orchestrator will re-message
    // the (reloaded) content script after the page settles.
  }
}

// String-only fallback. Used when we have text but no element to probe.
function parsePriceFromText(text) {
  if (!text) return null;
  const cleaned = text.replace(/,/g, '');

  // Prefer the formatted $N.NN match (cents present), even if it appears
  // later in the string. Walmart's screen-reader span looks like
  //   "current price $1.97"
  // and accompanies the visible span-glue artifact "$197".
  const formatted = cleaned.match(/\$(\d+)\.(\d{2})/);
  if (formatted) {
    return parseInt(formatted[1], 10) + parseInt(formatted[2], 10) / 100;
  }

  // Bare $-prefixed integer means Walmart didn't ship the screen-reader
  // $N.NN span (or it lost out to span-glue earlier). The bare-integer
  // outcome is almost always span-glue: visible spans "$" "1" "97" join
  // to "$197". Threshold 100 catches sub-$2 grocery items.
  const dollarOnly = cleaned.match(/\$(\d+)/);
  if (dollarOnly) {
    const v = parseInt(dollarOnly[1], 10);
    return v >= 100 ? v / 100 : v;
  }

  const m = cleaned.match(/(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!isFinite(v)) return null;
  if (Number.isInteger(v) && v >= 100) return v / 100;
  return v;
}

// Element-aware extractor. Probes the four sources Walmart could put a
// reliably-formatted price in, in order of trustworthiness:
//
//   1. aria-label on the price element itself ("$1.97")
//   2. screen-reader-only inner span (visually hidden via class or
//      aria-hidden=false on a sr-only element). These contain the
//      formatted "current price $1.97" string.
//   3. <meta itemprop="price"> (schema.org markup; Walmart sometimes ships)
//   4. textContent fallback through parsePriceFromText
//
// Returns null when nothing parses, so the meal-planner doesn't store
// garbage.
function extractPrice(priceEl) {
  if (!priceEl) return null;

  // 1. aria-label on the price element. Some Walmart skins put the
  //    formatted price here as the screen-reader hint.
  const aria = priceEl.getAttribute('aria-label');
  if (aria) {
    const v = parsePriceFromText(aria);
    if (v != null) return v;
  }

  // 2. Visually-hidden sr-only span. Walmart's class names rotate between
  //    skins ("vh", "w_DBak", "f6 mb1", etc.); rather than chase them, find
  //    any descendant whose text contains "current price" or "Now $N.NN" —
  //    that's the screen-reader pattern.
  const innerSpans = priceEl.querySelectorAll('span, div');
  for (const s of innerSpans) {
    const t = (s.textContent || '').trim();
    if (!t) continue;
    if (/current price|^was\b|^now\b|^price\b/i.test(t) && /\$\d+\.\d{2}/.test(t)) {
      const v = parsePriceFromText(t);
      if (v != null) return v;
    }
  }

  // 3. Schema.org markup. Cheap to check.
  const meta = priceEl.querySelector('meta[itemprop="price"]') || document.querySelector('meta[itemprop="price"]');
  if (meta) {
    const c = parseFloat(meta.getAttribute('content'));
    if (isFinite(c) && c > 0) return c;
  }

  // 4. textContent fallback. Last resort because of the span-glue trap.
  return parsePriceFromText(priceEl.textContent || '');
}

// Pull the SKU id out of a Walmart product URL. Format is typically
// /ip/<slug>/<numeric-id>. Falls back to the data-item-id attr on the card.
function extractItemId(url, card) {
  const m = url && url.match(/\/ip\/[^/]+\/(\d+)/);
  if (m) return m[1];
  return card && card.getAttribute('data-item-id') || null;
}

function parseRating(card) {
  const el = $(selectors.productRating, card);
  if (!el) return null;
  const aria = el.getAttribute('aria-label') || '';
  const m = aria.match(/(\d+(?:\.\d+)?)\s*out of/i) || (el.textContent || '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function parseReviewCount(card) {
  const el = $(selectors.productReviewCount, card);
  if (!el) return null;
  const txt = el.textContent || el.getAttribute('aria-label') || '';
  const m = txt.replace(/,/g, '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// Sponsored detection: prefer the data-attr selector, fall back to scanning
// the card's text for the literal word "Sponsored". Walmart sometimes ships
// the marker as plain text inside a span with no useful attributes.
function detectSponsored(card) {
  if ($(selectors.productSponsored, card)) return true;
  const txt = (card.textContent || '').toLowerCase();
  return txt.includes('sponsored');
}

// Pull a size string out of the title when the dedicated productSize
// selector returns nothing. Walmart commonly puts size in the title
// after a comma ("...Cheese, 12 Slices") so we get useful catalog data
// even when the inline size element is empty.
const SIZE_RE = /(\d+(?:\.\d+)?)\s*(fl\s*oz|fluid\s*ounces?|ounces?|oz|lbs?|pounds?|grams?|kg|kilograms?|gallons?|gal|quarts?|qt|pints?|pt|liters?|litres?|ml|milliliters?|count|ct|pack|pk|slices?|pieces?)/i;

function extractSizeFromTitle(title) {
  if (!title) return null;
  const m = title.match(SIZE_RE);
  return m ? m[0].trim() : null;
}

// Per-unit price ("$9.88/lb"). Best-effort — not present on every card.
// Worth capturing because it normalizes across pack sizes for catalog
// browsing and future cross-product comparison.
function extractUnitPrice(card) {
  const txt = (card.textContent || '');
  const m = txt.match(/\$\s*\d+(?:\.\d{2})?\s*\/\s*(?:lb|oz|fl\s*oz|ct|each|ea)/i);
  return m ? m[0].replace(/\s+/g, '') : null;
}

async function getCandidates() {
  // Wait for results to render. Walmart hydrates lazily.
  await waitFor(selectors.productCard, { timeoutMs: 12000 });
  await sleep(500);

  if (isBlocked()) {
    return { blocked: true, items: [] };
  }

  const cards = $$(selectors.productCard);
  const out = [];
  const seen = new Set();
  let position = 0;

  for (const card of cards) {
    position++;
    const titleEl = $(selectors.productTitle, card);
    const priceEl = $(selectors.productPrice, card);
    const linkEl = findProductLink(card);
    const sizeEl = $(selectors.productSize, card);
    const imgEl = $(selectors.productImage, card);
    const sponsored = detectSponsored(card);
    const availabilityEl = $(selectors.productAvailability, card);

    // Title fallback chain: explicit title selector → product link's aria-label
    // (Walmart's <a link-identifier> usually carries the full product name
    // there, more stable than the inner span class) → product image alt.
    let title = titleEl ? titleEl.textContent.trim() : '';
    if (!title && linkEl) title = (linkEl.getAttribute('aria-label') || '').trim();
    if (!title && imgEl) title = (imgEl.getAttribute('alt') || '').trim();
    const href = linkEl ? linkEl.getAttribute('href') : '';
    const url = href ? (href.startsWith('http') ? href : 'https://www.walmart.com' + href) : '';
    if (!title || !url) continue;

    // De-dupe by product URL — sponsored placements often repeat the same SKU.
    const dedupeKey = url.split('?')[0];
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const inlineSize = sizeEl ? sizeEl.textContent.trim() : '';
    out.push({
      title,
      // sizeText: prefer the dedicated size element; fall back to a regex
      // pass over the title since Walmart commonly puts it there too.
      sizeText: inlineSize || extractSizeFromTitle(title),
      unitPrice: extractUnitPrice(card),
      price: extractPrice(priceEl),
      size: inlineSize,
      url,
      // Richer fields persisted to the meal-planner via /api/grocery-events.
      // None of these are critical for ranking; they exist for analytics and
      // future use (cart cost preview, substitution memory, etc.).
      walmartItemId: extractItemId(url, card),
      imageUrl: imgEl ? (imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || null) : null,
      rating: parseRating(card),
      reviewCount: parseReviewCount(card),
      sponsored,
      availability: availabilityEl ? availabilityEl.textContent.trim().slice(0, 100) : null,
      position
    });
    if (out.length >= 10) break;
  }

  return { blocked: false, items: out };
}

async function addCurrentToCart() {
  if (isBlocked()) {
    return { ok: false, reason: 'bot-protection-challenge' };
  }
  const btn = await waitFor(selectors.addToCartButton, { timeoutMs: 10000 });
  if (!btn) {
    return { ok: false, reason: 'add-to-cart-button-not-found' };
  }
  // Real user gesture: a synthetic click() from a content script is treated
  // as trusted by the page since the script runs in the page context's event
  // loop with isolated-world privileges. This is fine for non-payment actions.
  btn.click();

  // Best-effort confirmation: cart preview / toast appears. We don't pretend
  // to authoritatively verify cart state — see README tradeoffs.
  const confirmed = await waitFor(selectors.cartConfirm, { timeoutMs: 4000 });
  return { ok: true, confirmed: !!confirmed };
}

// Add directly from the search-results page by finding the card whose
// product link points at `productUrl` and clicking its +Add button. Saves
// the navigation to the product page when the SKU is a single variant.
//
// Returns one of:
//   { ok: true, viaSearchResults: true, confirmed }
//   { ok: false, reason: 'card-not-found' }   — chosen card not on page
//   { ok: false, reason: 'needs-options' }    — no +Add button (variant SKU)
//   { ok: false, reason: 'click-failed: ...' }
//
// Caller (service worker) decides whether to fall back to navigateAndAdd.
async function addCandidateByUrl(productUrl) {
  if (isBlocked()) return { ok: false, reason: 'bot-protection-challenge' };
  if (!productUrl) return { ok: false, reason: 'no-url' };

  // Strip query AND hash so URLs from getCandidates match URLs read fresh
  // off the live page even if Walmart re-decorated them with tracking
  // params.
  const normalize = (u) => String(u || '').split('?')[0].split('#')[0];
  const targetKey = normalize(productUrl);

  // Walmart sometimes deduplicates the URL slug ("/ip/My-Item/12345" vs
  // "/ip/My-Item/12345?from=search") and sometimes only the SKU id at the
  // tail is stable. We compare on full path AND on tail-id as a backup.
  const targetTail = (targetKey.match(/\/(\d+)$/) || [])[1] || null;

  const matchCard = (card) => {
    const linkEl = findProductLink(card);
    const href = linkEl ? linkEl.getAttribute('href') : '';
    if (!href) return false;
    const cardUrl = normalize(href.startsWith('http') ? href : 'https://www.walmart.com' + href);
    if (cardUrl === targetKey) return true;
    if (targetTail) {
      const cardTail = (cardUrl.match(/\/(\d+)$/) || [])[1];
      if (cardTail && cardTail === targetTail) return true;
    }
    return false;
  };

  const cards = $$(selectors.productCard);
  let matched = null;
  for (const card of cards) {
    if (matchCard(card)) { matched = card; break; }
  }
  if (!matched) return { ok: false, reason: 'card-not-found' };

  // Lazy hydration: scroll the card into view first so Walmart actually
  // renders the +Add button. Then poll briefly for it to appear.
  try {
    matched.scrollIntoView({ block: 'center', behavior: 'instant' });
  } catch (_) {}

  let btn = null;
  for (let i = 0; i < 14; i++) {
    btn = matched.querySelector(selectors.cardAddToCartButton);
    if (btn) break;
    await sleep(150);
  }
  if (!btn) {
    // Either a "Choose options" SKU (variants) or hydration failed in the
    // 2.1s polling window. Caller falls back to navigateAndAdd either way.
    return { ok: false, reason: 'needs-options' };
  }
  try {
    btn.click();
  } catch (e) {
    return { ok: false, reason: 'click-failed: ' + (e && e.message || e) };
  }
  const confirmed = await waitFor(selectors.cartConfirm, { timeoutMs: 4000 });
  return { ok: true, viaSearchResults: true, confirmed: !!confirmed };
}

export const walmart = {
  name: 'Walmart',
  hostMatches: ['walmart.com', 'www.walmart.com'],
  searchUrl: SEARCH_URL,
  selectors,
  isBlocked,
  openSearch,
  getCandidates,
  addCurrentToCart,
  addCandidateByUrl
};
