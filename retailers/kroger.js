// Kroger adapter — STUB.
// Conforms to the adapter interface so the registry + retailer dispatch work,
// but the active methods throw. Implement when prioritized.

const NOT_IMPL = 'Kroger adapter is not implemented yet.';

export const kroger = {
  name: 'Kroger',
  hostMatches: ['kroger.com', 'www.kroger.com'],
  searchUrl: (q) => `https://www.kroger.com/search?query=${encodeURIComponent(q)}`,
  selectors: {
    searchInput: null,
    searchButton: null,
    productCard: null,
    productTitle: null,
    productPrice: null,
    productLink: null,
    addToCartButton: null,
    captchaIndicator: null
  },
  isBlocked() { return false; },
  async openSearch() { throw new Error(NOT_IMPL); },
  async getCandidates() { throw new Error(NOT_IMPL); },
  async addCurrentToCart() { throw new Error(NOT_IMPL); }
};
