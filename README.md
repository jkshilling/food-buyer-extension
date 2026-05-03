# food-buyer-extension

A Chrome extension that reads a shopping list from a deployed meal-planning
web app and adds the items to your grocery cart on supported retailer sites.
Walmart works in the MVP. Target and Kroger are stub adapters that satisfy
the interface but throw "not implemented yet" for the active methods.

**Stops before checkout.** Hard rule. The extension never clicks checkout,
never enters payment, and never automates anything past "item is in the
cart." You review the cart and check out manually.

## Why a Chrome extension instead of server-side automation

A previous attempt drove Walmart with server-side Playwright. It hit
Walmart's PerimeterX bot protection within seconds — captcha walls and IP
blocks against datacenter IPs, even with a real user agent. Residential
proxies are expensive, brittle, and ethically grey for this use case.

A Chrome extension runs inside your real browser:

- residential IP, real session cookies, real device fingerprint
- no proxy, no captcha-evasion games, no detection arms race
- you stay logged in normally; the extension just clicks things you would have clicked

This is the same architectural choice Honey, Capital One Shopping, Karma, and
similar tools make for the same reason. It is the correct shape of the
problem.

## What it does

1. **Reads the shopping list from the meal planner.** When you visit a
   `https://meals.alaskatargeting.com/plan/<N>/shopping` page, a content
   script extracts every approved row (name, quantity, unit, brand) and
   stores it locally. The toolbar badge updates with the item count.

2. **Detects supported retailer tabs.** When the active tab is on a
   supported retailer (currently Walmart), the popup enables the
   "Add all to cart" button.

3. **Drives the cart.** For each item, it:
   - searches the retailer with `brand + name`
   - reads the candidate product cards
   - ranks them by name similarity, brand match, size hints, with price as a
     tiebreaker
   - if the top match is high-confidence: navigates to the product page and
     clicks Add to Cart in your real session
   - if low-confidence: marks the row "review" and lets you pick from a
     dropdown of candidates
   - if no usable match: marks the row "fail" with a reason

4. **Stops at the cart.** No checkout automation.

## Repo layout

```
food-buyer-extension/
├── manifest.json              # Manifest V3
├── background/
│   └── service-worker.js      # state, badge updates, message routing
├── content-scripts/
│   ├── meal-planner.js        # injected into meals.alaskatargeting.com
│   └── retailer.js            # injected into retailer sites; dispatches
│                              # to the right adapter via dynamic import
├── retailers/
│   ├── index.js               # adapter registry + hostname dispatch
│   ├── walmart.js             # MVP: fully functional
│   ├── target.js              # stub matching the interface
│   └── kroger.js              # stub matching the interface
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js               # orchestrator: per-item search → rank → add
├── icons/
│   ├── icon-16.png            # placeholder solid-green PNGs
│   ├── icon-48.png
│   └── icon-128.png
├── README.md
└── .gitignore
```

## Install (developer / side-load)

The MVP is not on the Chrome Web Store. To install:

1. Clone this repo:
   ```
   git clone https://github.com/jkshilling/food-buyer-extension.git
   ```
2. Open Chrome and go to `chrome://extensions`.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the `food-buyer-extension` directory.
5. Pin the extension to your toolbar so the popup is one click away.

Side-loaded extensions don't auto-update — `git pull` and click "Reload" on
the extensions page after pulling fixes.

## Usage

1. Open the meal planner shopping page:
   `https://meals.alaskatargeting.com/plan/<N>/shopping`
   The toolbar badge should update with the approved-item count.
2. Open `walmart.com` in another tab and log in normally.
3. Click the extension icon while the Walmart tab is active.
4. Verify the item count and detected retailer in the popup.
5. Click **Add all to cart**.
6. Watch the per-item progress. Anything marked "review" waits for you to
   pick a candidate from the dropdown. Anything marked "fail" needs manual
   handling.
7. When the run is done, switch to the Walmart tab, review the cart, and
   check out manually.

## Per-retailer adapter interface

Every retailer module exports the same shape so adding a new retailer is a
drop-in operation. See `retailers/walmart.js` for the canonical example.

```js
export const someRetailer = {
  name: 'SomeRetailer',
  hostMatches: ['someretailer.com', 'www.someretailer.com'],
  searchUrl: (q) => `https://www.someretailer.com/search?q=${encodeURIComponent(q)}`,
  selectors: { /* one place for every CSS selector — see below */ },
  isBlocked() { /* return true if a captcha/bot challenge is on screen */ },
  async openSearch(query) { /* navigate to search results */ },
  async getCandidates() {
    /* read product cards from the results page; return
       { blocked, items: [{ title, price, size, url }] } */
  },
  async addCurrentToCart() {
    /* click Add to Cart on the current product page; return
       { ok: true, confirmed } or { ok: false, reason } */
  }
};
```

To add a new retailer:

1. Create `retailers/<name>.js` exporting that object.
2. Register it in `retailers/index.js` (one import + one array entry).
3. Add the host to `host_permissions` and the `content_scripts` matches in
   `manifest.json`.
4. Add the host to `web_accessible_resources` matches in `manifest.json`.
5. Reload the extension.

## Honest tradeoffs

These are real, structural limitations — not bugs to be fixed later.

- **Retailer DOM rotates frequently.** Every selector in `retailers/*.js` is
  an assumption about today's markup. They will break. Keep them in one
  block per retailer so the next break is one edit, not a hunt.
- **Match quality varies.** Grocery search is fuzzy: "milk" might return
  whole milk, oat milk, condensed milk, or chocolate syrup. The manual
  override dropdown is the safety valve. Treat it as primary UX, not a
  backup.
- **Cart state is best-effort.** The extension watches for the cart-preview
  toast as a success signal, but cannot authoritatively verify that a SKU
  ended up in the cart across all retailer flows. If something looks off,
  trust the cart page over the popup's results.
- **Side-loaded extensions don't auto-update.** Web Store publishing solves
  that but adds review latency and surface area. Not in MVP scope.
- **Bot protection still wins sometimes.** Even from a real browser,
  Walmart occasionally serves captchas. The adapter detects the challenge
  and reports it; you solve it manually and re-run.

## Path to Chrome Web Store (out of MVP scope)

When ready:

1. Create a developer account ($5 one-time fee) at
   https://chrome.google.com/webstore/devconsole.
2. Zip the extension directory (exclude `.git`, `notes/`, etc.).
3. Fill out the listing: description, screenshots (1280x800 or 640x400),
   category, privacy policy URL.
4. Justify each requested permission (we ask for `storage`, `activeTab`,
   `scripting`, plus host permissions per retailer + the meal planner).
5. Submit for review. First-time reviews can take days.

For now, side-loading via Developer Mode is fine for personal use.

## What's NOT in scope

- Functional Target / Kroger / other adapters (stubs only)
- Login automation of any kind — log in to the retailer normally
- Any server-side anything: no backend, no proxy, no API of our own
- Telemetry / analytics
- Chrome Web Store publishing (documented above; not executed)
- Settings UI beyond the manual-override dropdown
- Any modification to `meal-planner-cart` — read-only consumer of its
  existing public HTML

## License

No license file yet. Treat as personal-use until one is added.
