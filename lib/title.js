// A title the REPL keeps on a tab, to name it for whoever looks at the tab strip: kept across page loads,
// and put back when the page sets its own (a single-page app does on each route).
const { state, onShutdown } = require('./state');
const out = require('./output');
const { tabState } = require('./tabstate');
const { unquote } = require('./syntax');
const { keepAcrossPages, stopKeeping } = require('./kept');

/**
 * @typedef {import('playwright-core').Page} Page
 * @typedef {{ owner: string | null, text: string }} KeptTitle
 * @typedef {{ action: 'set' | 'off' | 'read', text?: string, maxPutBacks?: number }} TitleArgs
 */

// Past this many put-backs in a second, the page is taken to be fighting for its title, and the REPL
// stops: two sides each putting their own back would hang the tab.
const MAX_PUT_BACKS = 20;

// Runs in the page; its state is kept on the window, one per document. It compares with what
// document.title reads back, which trims and collapses whitespace, not with the text given: a title that
// never read back as given would be put back forever. pageTitle is the page's own, the last it set, for
// title off.
/** @param {TitleArgs} args */
function pageTitle({ action, text, maxPutBacks }) {
  const KEY = Symbol.for('pw-repl-title');
  const w = /** @type {any} */ (window);
  /** @type {{ want: string, shows: string, pageTitle: string, added: Element | null, observer: MutationObserver, gaveUp: boolean } | undefined} */
  let kept = w[KEY];
  if (action === 'read') return { shows: document.title, gaveUp: !!kept?.gaveUp };
  if (action === 'off') {
    if (!kept) return null;
    kept.observer.disconnect();
    delete w[KEY];
    // A document that had no title gets none back, unless the page has set one since.
    if (!kept.pageTitle && kept.added && document.querySelector('title') === kept.added) kept.added.remove();
    else if (document.title !== kept.pageTitle) document.title = kept.pageTitle;
    return document.title;
  }
  // Set again in the same document: what the page had stays, and a fresh count starts, even after it gave up.
  const old = kept;
  old?.observer.disconnect();
  const had = old ? null : document.querySelector('title');
  let windowStart = 0;
  let putBacks = 0;
  const observer = new MutationObserver(() => {
    const k = w[KEY];
    if (!k || document.title === k.shows) return;
    k.pageTitle = document.title;
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; putBacks = 0; }
    if (++putBacks > /** @type {number} */ (maxPutBacks)) { observer.disconnect(); k.gaveUp = true; return; }
    document.title = k.want;
    k.shows = document.title;
  });
  kept = w[KEY] = { want: /** @type {string} */ (text), shows: '', pageTitle: old ? old.pageTitle : document.title, added: old ? old.added : null, observer, gaveUp: false };
  if (document.title !== kept.want) document.title = kept.want;
  if (!old && !had) kept.added = document.querySelector('title');
  // The head, not the title element: a page may replace its <title> or add one.
  if (document.head) observer.observe(document.head, { subtree: true, childList: true, characterData: true });
  kept.shows = document.title;
  return kept.shows;
}

/**
 * @param {Page} p
 * @param {TitleArgs} args
 * @returns {Promise<any>}
 */
function inPage(p, args) {
  return p.evaluate(pageTitle, args);
}

/** @param {Page} p */
function titleOf(p) {
  return /** @type {KeptTitle | null} */ (tabState(p).title || null);
}

/** @param {Page} p */
async function titleOff(p) {
  if (!titleOf(p)) return null;
  delete tabState(p).title;
  stopKeeping(p, 'title');
  return (await inPage(p, { action: 'off' }).catch(() => null)) ?? await p.title().catch(() => '');
}

onShutdown(async () => {
  if (!state.browser || state.connectionLost) return;
  const pages = state.browser.contexts().flatMap(c => c.pages()).filter(p => !p.isClosed());
  await Promise.all(pages.map(p => titleOff(p).catch(() => {})));
});

const commands = {
  /** @param {string} args */
  async title(args) {
    const p = state.page;
    const line = (args || '').trim();
    const kept = titleOf(p);
    if (!line) {
      const { shows, gaveUp } = await inPage(p, { action: 'read' });
      if (!kept) { out.log(`${JSON.stringify(shows)}; title <text> sets one the REPL keeps`); return; }
      const by = kept.owner ? ` (by ${kept.owner})` : '';
      if (shows === kept.text) { out.log(`${JSON.stringify(shows)}, kept by the REPL${by}; title off puts back the page's own`); return; }
      out.log(`Keeping the title ${JSON.stringify(kept.text)}${by}, but the page shows ${JSON.stringify(shows)}${gaveUp
        ? `: the page set its own more than ${MAX_PUT_BACKS} times in a second, so the REPL stopped putting it back until the next page load`
        : ''}; title <text> sets it again, title off lets it go`);
      return;
    }
    if (line === 'off') {
      const back = await titleOff(p);
      out.log(back === null ? 'The REPL was not keeping a title in the selected tab' : `The page's own title is back: ${JSON.stringify(back)}`);
      return;
    }
    const text = unquote(line);
    /** @type {string} */
    const shows = await inPage(p, { action: 'set', text, maxPutBacks: MAX_PUT_BACKS });
    /** @type {KeptTitle} */
    const record = tabState(p).title = { owner: state.client, text: shows };
    keepAcrossPages(p, 'title', async () => { if (titleOf(p) === record) await inPage(p, { action: 'set', text, maxPutBacks: MAX_PUT_BACKS }); });
    out.log(`The tab's title is ${JSON.stringify(shows)}, kept across page loads and put back when the page sets its own; title off lets it go`);
  },
};

module.exports = { commands, titleOf, titleOff };
