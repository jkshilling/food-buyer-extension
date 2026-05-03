// Shared matching/ranking. Used by both the service worker (during the run
// loop) and the popup (if we ever want to preview a match without running).
// Pure functions, no chrome.* calls — safe to import from any extension
// context.

const STOPWORDS = new Set(['of', 'the', 'a', 'an', 'and', 'or', 'with', 'for', 'in', 'on']);

export function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

export function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function score(item, candidate) {
  const itemTokens = tokenize(item.name);
  const candTokens = tokenize(candidate.title);
  const nameSim = jaccard(itemTokens, candTokens);

  let brandBonus = 0;
  if (item.brand) {
    const brandTokens = tokenize(item.brand);
    const candText = candTokens.join(' ');
    if (brandTokens.every((b) => candText.includes(b))) brandBonus = 0.2;
  }

  let sizeBonus = 0;
  if (item.quantity || item.unit) {
    const sizeText = ((candidate.size || '') + ' ' + candidate.title).toLowerCase();
    if (item.quantity && sizeText.includes(String(item.quantity).toLowerCase())) sizeBonus += 0.05;
    if (item.unit && sizeText.includes(String(item.unit).toLowerCase())) sizeBonus += 0.05;
  }

  return Math.min(1, nameSim + brandBonus + sizeBonus);
}

export function rankCandidates(item, candidates) {
  const scored = candidates.map((c) => ({ ...c, _score: score(item, c) }));
  scored.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    const ap = a.price == null ? Infinity : a.price;
    const bp = b.price == null ? Infinity : b.price;
    return ap - bp;
  });
  return scored;
}

export function classify(scoreVal) {
  if (scoreVal >= 0.5) return 'ok';
  if (scoreVal >= 0.25) return 'review';
  return 'fail';
}

export function searchQueryFor(item) {
  // brand + name searches better than name + quantity/unit.
  return [item.brand, item.name].filter(Boolean).join(' ').trim();
}
