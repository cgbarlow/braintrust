/**
 * One place for the version, because it travels further than package.json:
 * the MCP server announces it, and every outbound request identifies itself
 * with it. See docs/research/source-terms-and-consent.md §7 — "documented, not
 * disguised" only means something if the string is real.
 */
export const VERSION = '0.1.0';
