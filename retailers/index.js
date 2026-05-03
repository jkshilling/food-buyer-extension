// Adapter registry. To add a new retailer: drop a file in this directory that
// exports an object matching the adapter interface (see walmart.js for the
// canonical example), then import + register it here.

import { walmart } from './walmart.js';
import { target } from './target.js';
import { kroger } from './kroger.js';

const adapters = [walmart, target, kroger];

export const registry = {
  all() {
    return adapters.slice();
  },
  forHost(hostname) {
    if (!hostname) return null;
    const h = hostname.toLowerCase();
    return adapters.find((a) => a.hostMatches.some((m) => m.toLowerCase() === h)) || null;
  },
  byName(name) {
    return adapters.find((a) => a.name.toLowerCase() === String(name).toLowerCase()) || null;
  }
};
