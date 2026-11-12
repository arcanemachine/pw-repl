// Tabs: listing, selecting, opening and closing them, and navigating the selected one.
const { state } = require('./state');
const out = require('./output');
const { hints, parseDuration, durationText } = require('./util');
const { tabState } = require('./tabstate');
const { keepDrawing, detachSession } = require('./cdp');
const { ensureDialogHandler } = require('./dialogs');
const { notLoaded, stayedPut } = require('./requestlog');
const { viewportText } = require('./emulation');
const { recordingOf, endedByTabClose } = require('./record');

/** @typedef {import('playwright-core').Page} Page */

// A navigation that does not load is said as wait load says it, from its request, rather than as
// Playwright's net:: error and call log.
/** @param {() => Promise<import('playwright-core').Response | null>} go */
async function navigating(go) {
  const started = Date.now();
  try {
    return await go();
  } catch (error) {
    if (!/net::ERR_/.test(error.message)) throw error;
    const find = () => /** @type {any[]} */ (tabState(state.page).log || []).filter(e => e.navigation && e.t >= started && e.failed && e.status !== 'pending').pop();
    for (let waited = 0; !find() && waited < 1000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
    const navigation = find();
    if (!navigation) throw error;
    // Chrome commits its error page just after the request fails: waited for, so info right after reads it.
    // Capped at 1s, for a failure with no error page; a tab already on one matches at once, which info
    // still reads right, from the log.
    if (!stayedPut(navigation) && !/ERR_ABORTED/.test(`${navigation.status} ${navigation.failed}`)) {
      for (let waited = 0; !state.page.url().startsWith('chrome-error://') && waited < 1000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(notLoaded(navigation));
  }
}

const LOAD_TIMEOUT = 15000;

// --timeout=<time> before the URL, as eval takes it: how long the page has to load.
/**
 * @param {string} args
 * @param {string} usage
 */
function loadTimeout(args, usage) {
  const timed = /^--timeout(?:=|\s+)(\S+)(?:\s+|$)/.exec(args);
  if (!timed && !/^--timeout(?=[=\s]|$)/.test(args)) return { timeout: LOAD_TIMEOUT, rest: args };
  const timeout = parseDuration(timed?.[1]);
  if (!timeout) throw usageError(`Usage: ${usage}, a time in ms or with s: --timeout=60s`);
  return { timeout, rest: args.slice(/** @type {RegExpExecArray} */ (timed)[0].length) };
}

// Named, for a usage error: its --timeout would read as a timeout to the runner, and nothing was done.
/** @param {string} message */
function usageError(message) {
  /** @type {PwError} */
  const error = new Error(message);
  error.uncertain = false;
  return error;
}

// A slow page goes on loading after the command gives up, so it is said plainly, with the way to wait it out.
/**
 * @param {() => Promise<import('playwright-core').Response | null>} go
 * @param {number} timeout
 * @param {string} command
 */
async function loading(go, timeout, command) {
  try {
    return await navigating(go);
  } catch (error) {
    if (!/Timeout \d+ms exceeded/.test(error.message)) throw error;
    /** @type {PwError} */
    const late = new Error(`The page did not finish loading within ${durationText(timeout)} and may still be loading: wait load <time> waits for it, or ${command} --timeout=<time> waits longer (past 20s, give send -t too, or it gives up first).`);
    late.uncertain = true;
    throw late;
  }
}

// A page restored from the back/forward cache never fires its load events
// again, so back and forward wait only for the navigation, then briefly for
// the document to be parsed, which a restored one already is.
/**
 * @param {() => Promise<import('playwright-core').Response | null>} go
 * @param {string} direction
 */
async function historyStep(go, direction) {
  const before = state.page.url();
  const response = await navigating(go);
  if (response === null && state.page.url() === before) throw new Error(`No page to go ${direction} to`);
  await state.page.waitForFunction(() => document.readyState !== 'loading', null, { timeout: 3000 }).catch(() => {});
}

// The tab the REPL opened for its start URL, which tab marks: in a kept profile it sits among restored tabs.
/** @param {Page} p */
function markStartTab(p) {
  tabState(p).start = true;
}

// A tab of the REPL's own: closing it can go back to the tab before. It opens
// in the background, so it does not take the front of the window from the
// user using the browser; Playwright's newPage would bring it to the front.
const OPEN_TIMEOUT = 10000;
const FRONT_READ_TIMEOUT = 500;

// True while tab new opens a tab: watch on --next-tab waits for one someone
// else opens, not one a client of the REPL opens for itself.
let opening = false;

function isOpening() {
  return opening;
}

/** @param {{ newWindow?: boolean, inWindow?: { id: number, n: number, pages: Page[] } }} [where] */
async function openTab(where = {}) {
  opening = true;
  try {
    const opened = where.inWindow ? await openInWindow(where.inWindow) : await openOwnTab(!!where.newWindow);
    tabState(opened).opened = true;
    tabState(opened).owner = state.client;
    await keepDrawing(opened);
    return opened;
  } finally { opening = false; }
}

/** @param {boolean} newWindow */
async function openOwnTab(newWindow) {
  const ctx = /** @type {import('playwright-core').Browser} */ (state.browser).contexts()[0];
  /** @type {import('playwright-core').Page | null} */
  let opened = null;
  const session = await /** @type {import('playwright-core').Browser} */ (state.browser).newBrowserCDPSession().catch(() => null);
  if (session) {
    try {
      const { targetId } = await session.send('Target.createTarget', newWindow ? { url: 'about:blank', newWindow: true, background: true } : { url: 'about:blank', background: true });
      opened = await pageForTarget(ctx, targetId);
    } catch (error) {
      if (newWindow) throw error;
    } finally {
      await session.detach().catch(() => {});
    }
  }
  if (newWindow && !opened) throw new Error('The browser did not open a window');
  // A browser that cannot open one in the background (e.g. some headless ones) opens it as usual.
  if (!opened) opened = await ctx.newPage();
  return opened;
}

// How long a tab in the window has to open one, before the next is tried: one with a dialog open, or
// frozen, never answers. Once one has run window.open, how long its tab has to appear.
const OPENER_TIMEOUT = 3000;
const POPUP_TIMEOUT = 5000;

// CDP opens a tab in the window Chrome picks, and cannot move one: a tab opened by a page goes in that
// page's window, so a tab already there opens it. In an isolated world, which the page's own scripts
// (a replaced window.open) cannot reach; as if clicked, which the popup blocker lets through; noopener,
// so the new tab has no hold on the page. Tabs a client opened go first: the opener is left marked as
// having had a click (navigator.userActivation), which lets a page do more, such as ask before it closes.
/** @param {{ id: number, n: number, pages: Page[] }} target */
async function openInWindow({ id, n, pages }) {
  const ownedFirst = [...pages.filter(p => tabState(p).owner === state.client && 'opened' in tabState(p)), ...pages.filter(p => 'opened' in tabState(p)), ...pages];
  for (const opener of new Set(ownedFirst)) {
    if (opener.isClosed()) continue;
    const session = await opener.context().newCDPSession(opener).catch(() => null);
    if (!session) continue;
    /** @type {Page | null} */
    let opened = null;
    let ran = false;
    try {
      // Listened for before window.open runs, so a quick tab is not missed.
      const popup = opener.waitForEvent('popup', { timeout: OPENER_TIMEOUT + POPUP_TIMEOUT }).catch(() => null);
      const open = (async () => {
        const { frameTree } = await session.send('Page.getFrameTree');
        const { executionContextId } = await session.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'pw-repl-window' });
        await session.send('Runtime.evaluate', { expression: 'void window.open("about:blank", "_blank", "noopener")', contextId: executionContextId, userGesture: true });
        ran = true;
      })().catch(() => {});
      await Promise.race([open, new Promise(resolve => setTimeout(resolve, OPENER_TIMEOUT))]);
      // One that ran it just as its time ran out may have opened it already: taken, not left behind.
      opened = await Promise.race([popup, new Promise(resolve => setTimeout(resolve, ran ? POPUP_TIMEOUT : 0, null))]);
    } finally {
      // Detaching waits on a tab with a dialog open, until it is answered.
      await Promise.race([detachSession(opener, session), new Promise(resolve => setTimeout(resolve, OPENER_TIMEOUT))]);
    }
    // One that ran it may still open a tab: another tab trying too could make two.
    if (ran && !opened) throw new Error(`A tab in Window ${n} was asked to open one, and none appeared within ${durationText(POPUP_TIMEOUT)}. Run tab before trying again: it may have opened late.`);
    if (!opened) continue;
    const [landed] = await windowIdsOf([opened]);
    if (landed === id) return opened;
    await opened.close().catch(() => {});
    throw new Error(`The tab opened in another window than Window ${n}, and was closed.`);
  }
  throw new Error(`No tab in Window ${n} could open one (a dialog open, or a frozen tab, keeps a tab from it). Nothing was opened.`);
}

// A page's CDP target id, asked for once per page.
/**
 * @param {import('playwright-core').BrowserContext} ctx
 * @param {Page} p
 */
async function targetIdOf(ctx, p) {
  if (!('targetId' in tabState(p))) {
    const cdp = await ctx.newCDPSession(p).catch(() => null);
    if (!cdp) return null;
    const info = await cdp.send('Target.getTargetInfo').catch(() => null);
    await detachSession(p, cdp);
    if (!info) return null;
    tabState(p).targetId = info.targetInfo.targetId;
  }
  return tabState(p).targetId;
}

/**
 * @param {import('playwright-core').BrowserContext} ctx
 * @param {string} targetId
 */
async function pageForTarget(ctx, targetId) {
  const deadline = Date.now() + OPEN_TIMEOUT;
  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      if ('opened' in tabState(p)) continue;
      if (await targetIdOf(ctx, p) === targetId) return p;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

// Whether a tab is the one in front in its window, as the tab itself says: 'visible', 'visible,
// focused' (its window has the keyboard, and not in the address bar), or null. Not for a tab a client
// uses, which is told it is in front so that it draws (lib/cdp.js); nor for one that does not answer
// at once (a dialog open, a frozen tab). Each window has one in front, an incognito one too.
/** @param {Page} p */
async function inFront(p) {
  if (tabState(p).focusEmulated) return null;
  const read = p.evaluate(() => [document.visibilityState, document.hasFocus()]).catch(() => null);
  const seen = await Promise.race([read, new Promise(resolve => setTimeout(resolve, FRONT_READ_TIMEOUT, null))]);
  if (!seen || seen[0] !== 'visible') return null;
  return seen[1] ? 'visible, focused' : 'visible';
}

// Windows, numbered 1, 2, ... in the order the REPL first sees them, for every client alike. Chrome's
// window ids are long, so numbers live as long as the REPL; labels go by the id (below).
/** @type {Map<number, number>} */
const windowNumbers = new Map();

// Labels, by Chrome's window id, which stays the same while Chrome runs. Saved in a file per launch of
// Chrome (its browser id, new each launch), so a REPL started again, or another on the same browser,
// sees them. In memory only when the browser does not say its id.
/** @type {Map<number, string>} */
const memoryLabels = new Map();
const LABELS_KEPT_FOR = 30 * 24 * 3600 * 1000;
/** @type {Promise<string | null> | null} */
let browserIdRead = null;

/** @returns {Promise<string | null>} */
function browserId() {
  if (!browserIdRead) {
    browserIdRead = (async () => {
      const url = state.cdpUrl || '';
      const inUrl = /\/devtools\/browser\/([\w-]+)/.exec(url);
      if (inUrl) return inUrl[1];
      if (!/^https?:/.test(url)) return null;
      const version = await fetch(`${url.replace(/\/$/, '')}/json/version`, { signal: AbortSignal.timeout(2000) }).then(r => r.json()).catch(() => null);
      const found = /\/devtools\/browser\/([\w-]+)/.exec(version?.webSocketDebuggerUrl || '');
      return found ? found[1] : null;
    })();
  }
  return browserIdRead;
}

// A folder of this user's alone: on a shared /tmp, another user could plant a file or a link at a fixed name.
function labelsFolder() {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(require('os').tmpdir(), `pw-repl-${process.getuid?.() ?? 'user'}`, 'window-labels');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const d of [path.dirname(dir), dir]) {
    const st = fs.lstatSync(d);
    if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077)) return null;
  }
  return dir;
}

/** @returns {Promise<string | null>} */
async function labelsFile() {
  const id = await browserId();
  if (!id) return null;
  try {
    const dir = labelsFolder();
    return dir ? require('path').join(dir, `${id}.json`) : null;
  } catch { return null; }
}

/** @returns {Promise<Map<number, string>>} */
async function readLabels() {
  const file = await labelsFile();
  if (!file) return memoryLabels;
  const fs = require('fs');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const now = new Date();
    fs.utimesSync(file, now, now);
    return new Map(Object.entries(saved).map(([id, label]) => [Number(id), String(label)]));
  } catch { return new Map(); }
}

/** @param {Map<number, string>} labels */
async function writeLabels(labels) {
  const file = await labelsFile();
  if (!file) return;
  const fs = require('fs');
  const path = require('path');
  if (labels.size) {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(labels)), { mode: 0o600 });
    fs.renameSync(temp, file);
  } else {
    fs.rmSync(file, { force: true });
  }
  // Another launch's labels go once unused for a while: a second Chrome on another port keeps its own.
  const dir = path.dirname(file);
  for (const name of fs.readdirSync(dir)) {
    const other = path.join(dir, name);
    try { if (Date.now() - fs.statSync(other).mtimeMs > LABELS_KEPT_FOR) fs.unlinkSync(other); } catch {}
  }
}

// The window each tab is in, by Chrome's window id, or null where Chrome does not say. Asked on every
// listing, not kept: a tab dragged out to a window of its own moves.
/** @param {Page[]} pages */
async function windowIdsOf(pages) {
  const session = await /** @type {import('playwright-core').Browser} */ (state.browser).newBrowserCDPSession().catch(() => null);
  if (!session) return pages.map(() => null);
  try {
    return await Promise.all(pages.map(async p => {
      const targetId = await targetIdOf(p.context(), p);
      if (!targetId) return null;
      const found = await session.send('Browser.getWindowForTarget', { targetId }).catch(() => null);
      return found ? /** @type {number} */ (found.windowId) : null;
    }));
  } finally {
    await session.detach().catch(() => {});
  }
}

// Every tab's window, by number, with each number's window id and label.
/** @param {Page[]} pages */
async function windowsOf(pages) {
  const [ids, labels] = await Promise.all([windowIdsOf(pages), readLabels()]);
  // Numbered in tab order, not in the order Chrome answers, so that the first window listed is Window 1.
  for (const id of ids) if (id !== null && !windowNumbers.has(id)) windowNumbers.set(id, windowNumbers.size + 1);
  /** @type {Map<number, { id: number, label: string | undefined }>} */
  const byNumber = new Map();
  for (const id of ids) if (id !== null) byNumber.set(/** @type {number} */ (windowNumbers.get(id)), { id, label: labels.get(id) });
  return { windows: ids.map(id => id === null ? null : /** @type {number} */ (windowNumbers.get(id))), byNumber, labels };
}

// Each window's tabs by index, in window order with unknown last. Grouped only with two windows or more:
// one window and a tab whose window Chrome did not say (one closing as it is asked) is still one window.
/** @param {(number | null)[]} windows */
function windowGroups(windows) {
  const numbers = [...new Set(windows)].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  const groups = numbers.map(n => ({ n, tabs: windows.flatMap((w, i) => w === n ? [i] : []) }));
  return { grouped: numbers.filter(n => n !== null).length > 1, groups };
}

/**
 * @param {number | null} n
 * @param {Map<number, { id: number, label: string | undefined }>} byNumber
 */
function windowName(n, byNumber) {
  if (n === null) return 'Window unknown';
  const label = byNumber.get(n)?.label;
  return `Window ${n}${label ? `, ${label}` : ''}`;
}

// A window named by its number or its label, among those open now.
/**
 * @param {string} word
 * @param {Map<number, { id: number, label: string | undefined }>} byNumber
 */
function findWindow(word, byNumber) {
  if (/^\d+$/.test(word)) {
    const found = byNumber.get(Number(word));
    if (!found) throw new Error(`No window ${word} is open now. Run window to list them.`);
    return { n: Number(word), ...found };
  }
  for (const [n, found] of byNumber) if (found.label === word) return { n, ...found };
  throw new Error(`No open window is labeled ${word}. Run window to list them.`);
}

// A label names one window, by itself, in --window and window close: one word, not a number, not taken.
/**
 * @param {string} label
 * @param {number | null} id the window it is for, if it has one yet
 * @param {Map<number, string>} labels
 * @param {Map<number, { id: number, label: string | undefined }>} byNumber
 */
function checkLabel(label, id, labels, byNumber) {
  if (/\s/.test(label)) throw usageError(`A window label is one word: ${JSON.stringify(label)} has spaces.`);
  if (/["']/.test(label)) throw usageError(`A window label is one word, with no quotes: ${label}`);
  if (/^\d+$/.test(label)) throw usageError(`A window label is not a number: ${label} would read as window ${label}.`);
  if (label === 'off') throw usageError('off takes a label off: it cannot be one.');
  for (const [n, found] of byNumber) {
    if (found.label === label && found.id !== id) throw usageError(`Window ${n} is labeled ${label} already: window label ${n} off frees it.`);
  }
  // A window closed since keeps its label in the file; a new one takes it.
  for (const [other, taken] of labels) if (taken === label && other !== id) labels.delete(other);
}

// Every tab, URL first, with * on the selected one. The numbers are what tab <index> uses. With several
// windows the tabs are grouped under each, in browser-wide order, so that an index means the same tab
// here as in modes.
async function listTabs() {
  const all = /** @type {import('playwright-core').Browser} */ (state.browser).contexts().flatMap(c => c.pages());
  if (state.page && !all.includes(state.page)) state.page = null;
  state.tabListing = all.slice();
  if (!all.length) { out.log('No tabs. Use tab new.'); return; }
  const [fronts, { windows, byNumber }] = await Promise.all([Promise.all(all.map(inFront)), windowsOf(all)]);
  const { grouped, groups } = windowGroups(windows);
  let first = true;
  for (const group of grouped ? groups : [{ n: undefined, tabs: all.map((p, i) => i) }]) {
    if (!first) out.log('');
    if (group.n !== undefined) out.log(`${windowName(group.n, byNumber)}:`);
    for (const [k, i] of group.tabs.entries()) {
      const p = all[i];
      let title;
      try { title = await p.title(); } catch { title = '[title unavailable]'; }
      const marker = p === state.page ? '*' : ' ';
      // URL first on its own line: it is what distinguishes otherwise
      // identically titled tabs, and titles wrap less badly when indented.
      if (k) out.log('');
      const notes = [fronts[i], 'start' in tabState(p) && 'the start URL', tabState(p).owner && `opened by ${tabState(p).owner}`].filter(Boolean);
      out.log(`${marker} [${i}] ${p.url()}${notes.length ? `  (${notes.join(', ')})` : ''}`);
      out.log(`        ${JSON.stringify(title)}`);
    }
    first = false;
  }
}

// --window <n|label> (or =), before the URL and any --timeout.
/** @param {string} args */
function windowOption(args) {
  const given = /^--window(?:=|\s+)(\S+)(?:\s+|$)/.exec(args);
  if (!given) {
    if (/^--window(?=[=\s]|$)/.test(args)) throw usageError('Usage: tab new --window <n|label> [url]');
    return { window: undefined, rest: args };
  }
  return { window: given[1], rest: args.slice(given[0].length) };
}

// A tab just opened and selected: loaded with the URL given, if one is.
/**
 * @param {string} url the rest of the line, with goto's --timeout
 * @param {string} done what is said with no URL
 */
async function opened(url, done) {
  if (!url) { out.log(done); return; }
  try { await commands.goto(url); }
  catch (error) { error.message += '\nThe new tab stays open and selected; tab close closes it.'; throw error; }
}

/** @param {Page} p */
async function windowNameOf(p) {
  const all = /** @type {import('playwright-core').Browser} */ (state.browser).contexts().flatMap(c => c.pages());
  const { windows, byNumber } = await windowsOf(all);
  return windowName(windows[all.indexOf(p)] ?? null, byNumber);
}

const commands = {
  /** @param {string} args */
  async tab(args) {
    const trimmed = (args || '').trim();
    if (!trimmed) {
      await listTabs();
      if (!state.page) out.log('\nNo tab is selected.');
      out.log(hints([
        ['tab <index|url-part>', 'select a tab'],
        ['tab new [url]', 'open a tab of your own and select it'],
        ['tab close [url-part]', 'close the selected tab, or the one whose URL contains url-part'],
      ]));
      return;
    }
    const usage = 'Usage: tab [<index> | <url-part> | new [--window <n|label>] [url] | close [<url-part>]]';
    const parts = trimmed.split(/\s+/);
    // trimmed is not empty, so it has a first word.
    const subcommand = /** @type {string} */ (parts.shift());
    const all = /** @type {import('playwright-core').Browser} */ (state.browser).contexts().flatMap(c => c.pages());
    // Matching on the URL, not an index, so a stale listing cannot point at someone else's tab.
    // Remembers where the REPL was, so closing a tab can go back there, but
    // only to a tab this REPL opened: the previous one may be someone else's.
    // Its focus is on before anything acts in it: a click in a tab that is not yet told it is focused
    // can leave it drawing a frame a second (lib/cdp.js).
    const select = async (/** @type {Page} */ p) => {
      if (p !== state.page) state.previousPage = state.page;
      state.page = p;
      ensureDialogHandler(p);
      await keepDrawing(p);
    };
    // Opened by this client, with tab new: the prompt's and nameless senders' are theirs together.
    const mine = (/** @type {Page} */ p) => 'opened' in tabState(p) && tabState(p).owner === state.client;
    const byUrl = (/** @type {string} */ part, closing = false) => {
      const matches = all.filter(p => p.url().includes(part));
      if (matches.length === 1) return matches[0];
      if (!matches.length) throw new Error(`No tab URL contains "${part}"`);
      throw new Error(`${matches.length} tabs match "${part}"; use a longer part, or tab <index> from tab's listing${closing ? ', then tab close' : ''}:\n${matches.map(p => `  ${p.url()}${mine(p) ? '  (opened by you)' : ''}`).join('\n')}`);
    };
    if (/^\d+$/.test(subcommand)) {
      if (parts.length) throw new Error(usage);
      const target = state.tabListing[Number(subcommand)];
      if (target && all.includes(target)) { await select(target); return commands.info(); }
      // Not read as part of a URL instead: that could land in someone else's tab without a word.
      if (target) throw new Error(`Tab [${subcommand}] has closed since the latest listing. Run tab to list them again.`);
      // A number that is not a tab in the listing may be part of a URL (a port).
      const containing = all.filter(p => p.url().includes(subcommand)).length;
      if (!containing) throw new Error(`No tab [${subcommand}] in the latest listing, and no tab URL contains ${subcommand}. Run tab to list them.`);
      if (containing > 1) {
        const listing = state.tabListing.length ? 'the latest listing' : 'a listing yet: each client has its own, from tab';
        throw new Error(`No tab [${subcommand}] in ${listing}. As part of a URL, ${subcommand} is in ${containing} tabs. Run tab, then tab <index>.`);
      }
    }
    if (subcommand === 'new') {
      const { window, rest } = windowOption(parts.join(' '));
      /** @type {{ id: number, n: number, pages: Page[] } | undefined} */
      let inWindow;
      if (window !== undefined) {
        const { windows, byNumber } = await windowsOf(all);
        const found = findWindow(window, byNumber);
        inWindow = { id: found.id, n: found.n, pages: all.filter((p, i) => windows[i] === found.n) };
      }
      await select(await openTab({ inWindow }));
      await opened(rest, inWindow ? `New tab created in ${await windowNameOf(state.page)} and selected` : 'New tab created and selected');
      return listTabs();
    }
    if (subcommand === 'close') {
      const part = parts.join(' ');
      const matches = part ? all.filter(p => p.url().includes(part)) : [];
      // Of several, the one tab you opened is the one to close: the others may be someone else's.
      const yours = matches.length > 1 && matches.filter(mine).length === 1 ? matches.find(mine) : null;
      const target = yours || (part ? byUrl(part, true) : state.page);
      if (!target || target.isClosed() || !all.includes(target)) throw new Error('Selected tab is unavailable. Run tab again.');
      if (all.length <= 1) throw new Error('Refusing to close the last tab');
      const url = target.url();
      const wasSelected = target === state.page;
      const recording = recordingOf(target);
      await target.close();
      if (wasSelected) {
        const back = state.previousPage;
        state.page = back && !back.isClosed() && 'opened' in tabState(back) ? back : null;
        state.previousPage = null;
      }
      out.log(`Closed ${url}${yours ? `, the one you opened; ${matches.length - 1} other ${matches.length === 2 ? 'tab matches' : 'tabs match'} "${part}"` : ''}${wasSelected && !state.page ? '; no tab is selected now' : ''}`);
      if (recording) out.log(await endedByTabClose(recording));
      return listTabs();
    }
    await select(byUrl(trimmed));
    return commands.info();
  },

  /** @param {string} args */
  async window(args) {
    const usage = 'Usage: window [new [--label <name>] [url] | close <n|label> | label <n> <name|off>]';
    const all = /** @type {import('playwright-core').Browser} */ (state.browser).contexts().flatMap(c => c.pages());
    const trimmed = (args || '').trim();
    const [subcommand = ''] = trimmed.split(/\s+/, 1);
    const rest = trimmed.slice(subcommand.length).trim();
    if (subcommand === 'new') {
      const labeled = /^--label(?:=|\s+)(\S+)(?:\s+|$)/.exec(rest);
      if (!labeled && /^--label(?=[=\s]|$)/.test(rest)) throw usageError('Usage: window new [--label <name>] [url]');
      const label = labeled?.[1];
      const before = label ? await windowsOf(all) : null;
      if (label && before) checkLabel(label, null, before.labels, before.byNumber);
      const p = await openTab({ newWindow: true });
      if (p !== state.page) state.previousPage = state.page;
      state.page = p;
      ensureDialogHandler(p);
      if (label && before) {
        const [id] = await windowIdsOf([p]);
        if (id !== null) {
          before.labels.set(id, label);
          await writeLabels(before.labels);
        }
      }
      await opened(labeled ? rest.slice(labeled[0].length) : rest, `New window opened, ${await windowNameOf(p)}; its tab is selected`);
      return listTabs();
    }
    const { windows, byNumber, labels } = await windowsOf(all);
    if (!trimmed) {
      state.tabListing = all.slice();
      if (!all.length) { out.log('No tabs. Use tab new.'); return; }
      for (const { n, tabs } of windowGroups(windows).groups) {
        out.log(`${windowName(n, byNumber)}: ${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}, ${tabs.map(i => `[${i}]`).join(' ')}`);
      }
      out.log(hints([
        ['window new [--label <name>] [url]', 'open a window, with a tab of your own, and select it'],
        ['tab new --window <n|label>', 'open a tab of your own in a window'],
        ['window close <n|label>', 'close a window whose tabs you opened'],
        ['window label <n> <name>', 'label a window, in the listings of every client'],
        ['tab', 'list the tabs, under their windows'],
      ]));
      return;
    }
    if (subcommand === 'close') {
      if (!rest || /\s/.test(rest)) throw usageError('Usage: window close <n|label>');
      const found = findWindow(rest, byNumber);
      const inside = all.filter((p, i) => windows[i] === found.n);
      // Another's tab may be in use: theirs, the user's, or another client's.
      const others = inside.filter(p => !('opened' in tabState(p)) || tabState(p).owner !== state.client);
      if (others.length) {
        throw new Error(`${windowName(found.n, byNumber)} has tabs you did not open, so it is left open:\n${others.map(p => `  ${p.url()}  (${'opened' in tabState(p) ? `opened by ${tabState(p).owner ?? 'the prompt or an unnamed sender'}` : 'not opened with tab new or window new'})`).join('\n')}\nThose are not yours to close: whoever opened each one closes it, with tab close <url-part>. Once they are gone, window close closes the window, and your tabs in it.`);
      }
      if (inside.length === all.length) throw new Error('Refusing to close the last window');
      let selectedClosed = false;
      /** @type {string[]} */
      const ended = [];
      for (const p of inside) {
        if (p === state.page) selectedClosed = true;
        const recording = recordingOf(p);
        await p.close();
        if (recording) ended.push(await endedByTabClose(recording));
      }
      if (selectedClosed) {
        const back = state.previousPage;
        state.page = back && !back.isClosed() && 'opened' in tabState(back) ? back : null;
        state.previousPage = null;
      }
      if (labels.delete(found.id)) await writeLabels(labels);
      out.log(`Closed ${windowName(found.n, byNumber)}, with ${inside.length} ${inside.length === 1 ? 'tab' : 'tabs'}${selectedClosed && !state.page ? '; no tab is selected now' : ''}`);
      for (const line of ended) out.log(line);
      return listTabs();
    }
    const labeling = /^label\s+(\d+)(?:\s+([\s\S]+))?$/.exec(trimmed);
    if (!labeling || !labeling[2]) throw usageError(usage);
    const n = Number(labeling[1]);
    const found = byNumber.get(n);
    if (!found) throw new Error(`No window ${n} is open now. Run window to list them.`);
    const name = labeling[2].trim();
    if (name === 'off') {
      labels.delete(found.id);
      await writeLabels(labels);
      out.log(`Window ${n} has no label now`);
      return;
    }
    checkLabel(name, found.id, labels, byNumber);
    labels.set(found.id, name);
    await writeLabels(labels);
    out.log(`Window ${n} is labeled ${name}`);
  },

  /** @param {string} args */
  async goto(args) {
    const usage = 'goto [--timeout=<time>] <url>';
    const { timeout, rest } = loadTimeout((args || '').trim(), usage);
    if (!rest) throw usageError(`Usage: ${usage}`);
    let url = rest;
    // As a browser's address bar does: a local dev server is almost always plain http.
    const local = /^(?:localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)(?:[:/?#]|$)/i.test(url);
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(url) && !/^(about|data|file|javascript):/i.test(url)) url = `${local ? 'http' : 'https'}://${url}`;
    await loading(() => state.page.goto(url, { waitUntil: 'domcontentloaded', timeout }), timeout, 'goto');
    out.log(`${state.page.url()} — ${await state.page.title()}`);
  },

  async back() {
    await historyStep(() => state.page.goBack({ waitUntil: 'commit', timeout: 10000 }), 'back');
    out.log(`Back to: ${state.page.url()}`);
  },

  async forward() {
    await historyStep(() => state.page.goForward({ waitUntil: 'commit', timeout: 10000 }), 'forward');
    out.log(`Forward to: ${state.page.url()}`);
  },

  /** @param {string} args */
  async reload(args) {
    const usage = 'reload [--timeout=<time>]';
    const { timeout, rest } = loadTimeout((args || '').trim(), usage);
    if (rest) throw usageError(`Usage: ${usage}`);
    await loading(() => state.page.reload({ waitUntil: 'domcontentloaded', timeout }), timeout, 'reload');
    out.log(`Reloaded: ${state.page.url()}`);
  },

  async info() {
    out.log(`  URL:   ${state.page.url()}`);
    // Chrome's error page has a URL of its own; the one that failed is in the request log.
    if (state.page.url().startsWith('chrome-error://')) {
      const failed = /** @type {any[]} */ (tabState(state.page).log || []).filter(e => e.navigation && e.failed && !stayedPut(e)).pop();
      if (failed) out.log(`  Error: Chrome's error page, for #${failed.id} ${failed.url} ${failed.status}`);
    }
    out.log(`  Title: ${await state.page.title()}`);
    out.log(`  Viewport: ${await viewportText()}`);
  },
};

module.exports = { commands, markStartTab, isOpening, openTab, listTabs, targetIdOf, windowGroups };
