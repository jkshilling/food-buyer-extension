// Target adapter — STUB.
// Conforms to the adapter interface so the registry + retailer dispatch work,
// but the active methods throw. Implement when prioritized.

const NOT_IMPL = 'Target adapter is not implemented yet.';

export const target = {
  name: 'Target',
  hostMatches: ['target.com', 'www.target.com'],
  searchUrl: (q) => `https://www.target.com/s?searchTerm=${encodeURIComponent(q)}`,
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
