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

  addToCartButton: 'button[data-automation-id="atc"], button[aria-label^="Add to cart"]',
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

// Walmart price parsing is annoying: the visible card now ships the price as
// separate spans like "$" "5" "28" which .textContent joins to "$528". A
// naive digit grab returns 528 (off by 100). The reliable signal is the
// screen-reader span Walmart includes: "current price $5.28". Parse that
// first; fall back to digit-grab with a sanity check.
function parsePrice(text) {
  if (!text) return null;
  const cleaned = text.replace(/,/g, '');
  // Anchor on a $ sign so we get the structured price, not a stray "20" from
  // the size text Walmart sometimes folds into the price block.
  const dollar = cleaned.match(/\$(\d+)(?:\.(\d{2}))?/);
  if (dollar) {
    const whole = parseInt(dollar[1], 10);
    const cents = dollar[2] ? parseInt(dollar[2], 10) : 0;
    return whole + cents / 100;
  }
  // No dollar sign anywhere — grab digits but treat suspiciously large
  // grocery-page numbers as joined-cents and divide by 100.
  const m = cleaned.match(/(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!isFinite(v)) return null;
  if (Number.isInteger(v) && v > 500) return v / 100;
  return v;
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
    const linkEl = $(selectors.productLink, card);
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

    out.push({
      title,
      price: parsePrice(priceEl ? priceEl.textContent : ''),
      size: sizeEl ? sizeEl.textContent.trim() : '',
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

export const walmart = {
  name: 'Walmart',
  hostMatches: ['walmart.com', 'www.walmart.com'],
  searchUrl: SEARCH_URL,
  selectors,
  isBlocked,
  openSearch,
  getCandidates,
  addCurrentToCart
};
