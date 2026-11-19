// Settings kept on a tab: what the REPL puts on a page (the cursor, a toast) that a new
// document drops. Each is applied again on every new document of its tab, until it is let go. A per-tab
// setting that must outlast its document goes through here.
const { tabState } = require('./tabstate');

/** @typedef {import('playwright-core').Page} Page */

/**
 * @param {Page} p
 * @param {string} name one setting per name; keeping it again replaces its apply
 * @param {() => Promise<unknown>} apply
 */
function keepAcrossPages(p, name, apply) {
  if (!tabState(p).kept) {
    tabState(p).kept = new Map();
    p.on('domcontentloaded', () => { for (const again of tabState(p).kept.values()) again().catch(() => {}); });
  }
  tabState(p).kept.set(name, apply);
}

/**
 * @param {Page} p
 * @param {string} name
 */
function stopKeeping(p, name) {
  tabState(p).kept?.delete(name);
}

module.exports = { keepAcrossPages, stopKeeping };
