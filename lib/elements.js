// Elements and the mouse: finding the match to act on, and the commands that click, type and choose.
const path = require('path');
const fs = require('fs');
const { state, onShutdown } = require('./state');
const out = require('./output');
const { takeOptions } = require('./cli-names');
const { unquote, unescapeDouble, toSelector, keyName, splitSelector, REF } = require('./syntax');
const { numbers, hints, BUSY_PAGE } = require('./util');
const { tabState } = require('./tabstate');
const { cursorOf, aiming, aimAt, glideTo, showClick, showSelect } = require('./cursor');
const { recordingOf, stepTarget, pauseToShow } = require('./record');
const { settled, outsideViewport, IN_VIEW } = require('./emulation');

/**
 * @typedef {import('playwright-core').Page} Page
 * @typedef {{ name: string, value?: string }[]} Found
 * @typedef {'left' | 'right' | 'middle'} Button
 * @typedef {{ button?: Button, modifiers?: string[], clickCount?: number, force?: boolean, timeout?: number }} ClickOptions
 * A Page's method with a selector, or a handle's without one: on is either, as sel says.
 * @typedef {(on: any, sel: string | null, o: ClickOptions) => Promise<unknown>} Act
 */

// Run in the page on an element: whether it has focus (through shadow roots, or delegated into its own),
// and the name of what has it, or null when nothing does.
/** @param {Element | null} target */
function focusOn(target) {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { on: false, name: null };
  const field = /** @type {HTMLInputElement} */ (el);
  const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : field.name ? `[name=${field.name}]` : ''}`;
  return { on: el === target || !!target?.shadowRoot?.delegatesFocus && target.shadowRoot.contains(el), name };
}

/** @param {string | null} name */
function focusedNow(name) {
  return name ? `focus is on ${name}` : 'nothing on the page has focus';
}

// The type a page sees for a file it is given, from its extension.
/** @type {Record<string, string>} */
const MIME_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html',
  xml: 'application/xml', zip: 'application/zip', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
  wav: 'audio/wav', doc: 'application/msword', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** @param {string} file */
function mimeType(file) {
  return MIME_TYPES[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
}

// Commands that take only a selector take the whole line, spaces and all.
/**
 * @param {string} args
 * @param {string} usage
 */
function soleSelector(args, usage) {
  const text = unquote((args || '').trim());
  if (!text) throw new Error(`Usage: ${usage}`);
  return toSelector(text);
}

const MODIFIERS = ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'];

// click <selector> [button] [--modifiers=<keys>], as playwright-cli's click
// takes them. The button is read only after a ref or a quoted selector, so
// click text=Turn right is still one selector; --button=right, as Playwright's option, after any.
// click takes --click-count too; dblclick is click's count of 2.
/**
 * @param {string} args
 * @param {string} usage
 */
function clickArgs(args, usage, counts = false) {
  // Found outside quotes only, so a quoted selector keeps whatever is in it.
  const { found, rest: text } = takeOptions((args || '').trim(), { modifiers: 'value', button: 'value', 'click-count': 'value', force: 'flag' });
  if (!counts && found.some(o => o.name === 'click-count')) throw new Error('dblclick is a click count of 2; for another count, click --click-count=<n>');
  const clickCount = clickCountOf(found, usage);
  const modifiers = found.filter(o => o.name === 'modifiers').flatMap(o => (o.value || '').split(',').filter(Boolean).map(keyName));
  const unknown = modifiers.find(m => !MODIFIERS.includes(m));
  if (unknown) throw new Error(`Not a modifier: ${unknown}; they are ${MODIFIERS.join(', ')}`);
  const parsed = splitSelector(text);
  const positional = parsed && /^(?:left|right|middle)$/.test(parsed.rest || '') && (REF.test(parsed.word) || /^["']/.test(text)) ? parsed.rest : null;
  const button = chooseButton(found, positional, usage);
  const selector = positional ? /** @type {NonNullable<typeof parsed>} */ (parsed).selector : soleSelector(text, usage);
  const force = found.some(o => o.name === 'force');
  /** @type {ClickOptions} */
  const options = { ...(button ? { button } : {}), ...(modifiers.length ? { modifiers } : {}), ...(clickCount > 1 ? { clickCount } : {}), ...(force ? { force } : {}) };
  // The selector as written, then the kind of click, so an option never reads as part of the selector.
  const kind = [
    ...(button && button !== 'left' ? [`${button} button`] : []),
    ...(clickCount > 1 ? [`${clickCount} times`] : []),
    ...(modifiers.length ? [`with ${modifiers.join('+')}`] : []),
    ...(force ? ['forced'] : []),
  ];
  return { selector, shown: [positional ? /** @type {NonNullable<typeof parsed>} */ (parsed).word : unquote(text), ...kind].join(', '), options };
}

// --click-count=<n>, as Playwright's clickCount: 3 selects a line or a field's text. Past 3 a browser
// does nothing more.
/**
 * @param {Found} found
 * @param {string} usage
 */
function clickCountOf(found, usage) {
  const given = found.filter(o => o.name === 'click-count');
  if (!given.length) return 1;
  if (given.length > 1 || !/^[1-3]$/.test(given[0].value || '')) throw new Error(`Usage: ${usage}; --click-count is 1, 2 or 3, once (2 is a double-click, 3 a triple-click)`);
  return Number(given[0].value);
}

// A trailing --submit, as playwright-cli's fill and type take: Enter afterwards.
/** @param {string} args */
function submitFlag(args) {
  if (/(?:^|\s)--submit\s/.test((args || '').trim())) throw new Error('--submit goes at the end of the line');
  const match = /^([\s\S]*?)\s+--submit$/.exec((args || '').trim());
  return match ? { args: match[1], submit: true } : { args, submit: false };
}

/**
 * @param {string} args
 * @param {string} usage
 * @param {string} example
 */
function selectorAndValue(args, usage, example) {
  const parsed = splitSelector(args);
  if (!parsed || parsed.rest === undefined) {
    throw new Error(`Usage: ${usage}, e.g. ${example}; quote a selector with spaces: "text=Your name"`);
  }
  return { selector: parsed.selector, value: unquote(parsed.rest), shown: parsed.word };
}

// An element that never appeared is said plainly, not as Playwright's call
// log, and so is one that timed out: its call log (dozens of lines of retries) goes
// to the REPL's pane and log only. A ref that no longer matches usually means the page
// changed since the snapshot it came from. It says the command's whole budget: Playwright's own
// timeout is what was left of it for the last call, after a glide say, and can read 4999ms for 5000.
/**
 * @template T
 * @param {string} selector
 * @param {() => Promise<T>} action
 * @returns {Promise<T>}
 */
async function onElement(selector, action, budget = 5000) {
  try {
    return await action();
  } catch (error) {
    const message = String(error.message || '').replace(/\x1b\[[0-9;]*m/g, '');
    if (/strict mode violation/.test(message)) throw error;
    const ref = selector.startsWith('aria-ref=') ? selector.slice(9) : null;
    const staleRef = ref ? `\n${ref} is a snapshot ref; if the page changed since that snapshot, take a new one.` : '';
    const timeout = /Timeout (\d+)ms exceeded/.exec(message);
    if (timeout && /waiting for locator/.test(message) && !/resolved to/.test(message)) {
      throw new Error(`No element matches ${ref || selector} (waited ${budget / 1000}s)${staleRef}`);
    }
    if (!timeout) { error.message += staleRef; throw error; }
    console.error(`Playwright's call log:\n${message}`);
    // Found, so the ref is not stale: no hint.
    const summary = /** @type {PwError} */ (new Error(`Timed out after ${budget / 1000}s on ${ref || selector}: ${lastBlocker(message)} (its call log is in the REPL's pane or log)`));
    // Unknown only once input was sent, in any retry. Playwright's checks (visible, enabled, stable, and
    // an element covering the point) come before it logs "performing <x> action" and sends it.
    summary.uncertain = /performing \w+ action/.test(message);
    throw summary;
  }
}

// What last stopped the action, from Playwright's call log: the element that took the click,
// or the check the element kept failing.
/** @param {string} log */
function lastBlocker(log) {
  const lines = log.split('\n').map(line => line.trim().replace(/^-\s*/, ''));
  // Its last step was the action itself: it was sent, and the page stopped answering, as when the click
  // sets off a long task. A profile started now would miss that task: Chrome traces only what begins
  // after it starts.
  const sent = /^performing (\w+) action$/.exec(lines.filter(Boolean).pop() || '');
  if (sent) return `the ${sent[1]} was sent, and may have landed, but the page stopped answering after it, likely busy with what it set off. A profile shows that only if it is on before the action: profile on, then the action again, if repeating it is safe`;
  const line = lines.reverse().find(l => /intercepts pointer events|element is not |element is outside|not attached|detached/.test(l));
  if (!line) return `it never became ready to act on; ${BUSY_PAGE}`;
  return line.length > 240 ? `${line.slice(0, 240)}…` : line;
}

// Where a match stands for a click: hidden elements are left out before this. Tested in
// its own frame, at its centre, and only when that is in view: scrolling each one to test
// it would move a page someone may be looking at.
/** @param {Element} el */
function hitTest(el) {
  if (window !== window.top) return { kind: 'unchecked' };
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { kind: 'unchecked' };
  let top = document.elementFromPoint(x, y);
  while (top?.shadowRoot) {
    const inner = top.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === top) break;
    top = inner;
  }
  for (let n = /** @type {Node} */ (top); n; n = n.parentNode || /** @type {ShadowRoot} */ (n).host) if (n === el) return { kind: 'hit' };
  const name = (/** @type {Element} */ e) => {
    const classes = typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
    return `<${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${classes.map(c => `.${c}`).join('')}>`;
  };
  return { kind: 'covered', by: top ? name(top) : 'nothing (off the page)' };
}

// Playwright acts on the first match and retries it until it times out, even when that one is
// hidden or under an overlay and a later one could be used. With several matches, this picks
// the first visible one that is not covered (or not checkable here, which Playwright then
// checks as it acts), waiting for one as Playwright waits; with none it fails before acting,
// saying why. The chosen element's handle is what is acted on, so the list changing
// meanwhile cannot shift the choice. Null: a ref or a single match, left to Playwright.
/**
 * @param {string} selector
 * @param {number} timeout
 */
async function chooseMatch(selector, timeout) {
  if (selector.startsWith('aria-ref=')) return null;
  const locator = state.page.locator(selector);
  if (await locator.count() <= 1) return null;
  const deadline = Date.now() + timeout;
  /** @type {{ count: number, handles: import('playwright-core').ElementHandle[], results: any[] }} */
  let seen = { count: 0, handles: [], results: [] };
  for (;;) {
    const count = await locator.count();
    if (count <= 1 && !seen.handles.length) return null;
    const handles = await locator.filter({ visible: true }).elementHandles();
    const results = await Promise.all(handles.map(h => h.evaluate(hitTest).catch(() => ({ kind: 'gone' }))));
    // In page order: a later match in view must not win over an earlier one Playwright can scroll to.
    const index = results.findIndex(r => r.kind === 'hit' || r.kind === 'unchecked');
    if (index !== -1) {
      await Promise.all(seen.handles.concat(handles.filter((_, i) => i !== index)).map(h => h.dispose().catch(() => {})));
      const all = await locator.elementHandles();
      const position = (await Promise.all(all.map(h => h.evaluate((a, b) => a === b, handles[index])))).indexOf(true);
      await Promise.all(all.map(h => h.dispose().catch(() => {})));
      return { handle: handles[index], position: position + 1, count };
    }
    await Promise.all(seen.handles.map(h => h.dispose().catch(() => {})));
    seen = { count, handles, results };
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const listed = await Promise.all(seen.handles.slice(0, 5).map(async (h, i) => {
    const text = await h.evaluate((/** @type {HTMLElement} */ el) => `<${el.tagName.toLowerCase()}> ${(el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)}`).catch(() => '(gone)');
    const r = seen.results[i];
    return `  ${text}: ${r.kind === 'covered' ? `covered by ${r.by}` : 'gone from the page'}`;
  }));
  await Promise.all(seen.handles.map(h => h.dispose().catch(() => {})));
  const hidden = seen.count - seen.handles.length;
  const error = /** @type {PwError} */ (new Error([
    `None of the ${seen.count} matches for ${selector} could be acted on after ${timeout / 1000}s, so nothing was done:`,
    ...listed,
    ...(seen.handles.length > 5 ? [`  and ${seen.handles.length - 5} more like these`] : []),
    ...(hidden ? [`  ${hidden} hidden`] : []),
    'A more specific selector, or a ref from snapshot, picks one; covered ones may be under a dialog or overlay.',
  ].join('\n')));
  error.uncertain = false;
  throw error;
}

// The button, from a word (click e5 right) or --button=right, as Playwright's option is named; not both.
/**
 * @param {Found} found
 * @param {string | null | undefined} positional
 * @param {string} usage
 * @returns {Button | null}
 */
function chooseButton(found, positional, usage) {
  const named = found.filter(o => o.name === 'button');
  if (named.length > 1 || (named.length && !/^(?:left|right|middle)$/.test(named[0].value || ''))) throw new Error(`Usage: ${usage}; --button is left, right or middle, once`);
  if (positional && named.length) throw new Error(`Usage: ${usage}; the button goes once, as a word or as --button, not both`);
  return /** @type {Button | null} */ (positional || named[0]?.value || null);
}

// A mouse command's words, its button (a last word, or --button) and its options. Any other --option is
// refused before a mouse event is sent.
/**
 * @param {string} line
 * @param {string} usage
 * @param {Record<string, 'value' | 'flag' | 'rest'>} [spec]
 */
function mouseArgs(line, usage, spec = {}) {
  const { found, rest } = takeOptions((line || '').trim(), { button: 'value', ...spec });
  const words = rest.split(/\s+/).filter(Boolean);
  const unknown = words.find(w => w.startsWith('--'));
  if (unknown) throw new Error(`Usage: ${usage}; ${unknown.split('=')[0]} is not one of its options`);
  const last = /^[a-z]+$/.test(words[words.length - 1] || '') ? words.pop() : null;
  if (last && !/^(?:left|right|middle)$/.test(last)) throw new Error(`Usage: ${usage}`);
  return { words, found, button: chooseButton(found, last, usage) || 'left' };
}

/**
 * @param {string} args
 * @param {string} name
 */
function mouseButton(args, name) {
  const usage = `${name} [left|right|middle]`;
  const { words, button } = mouseArgs(args, usage);
  if (words.length) throw new Error(`Usage: ${usage}`);
  return button;
}

// click, dblclick and hover: on the match chooseMatch picks, or as Playwright does.
// A page that renders the chosen element again (as React lists do) replaces it before it is
// acted on; it is chosen again then, as Playwright finds a locator's element again.
/**
 * @param {string} selector
 * @param {Act} act
 * @param {ClickOptions} [options]
 */
async function pointerAction(selector, act, options = {}, clicks = 0) {
  try {
    return await choosingPointerAction(selector, act, options, clicks);
  } catch (error) {
    // Playwright counts aria-disabled as disabled, though a page may keep such an element clickable.
    if (clicks && !options.force && /: element is not enabled \(/.test(error.message)) {
      error.message += '\nIt may be aria-disabled, which counts as disabled; --force clicks it anyway (help click).';
    }
    throw error;
  }
}

/**
 * @param {string} selector
 * @param {Act} act
 * @param {ClickOptions} options
 * @param {number} clicks
 */
async function choosingPointerAction(selector, act, options, clicks) {
  const TIMEOUT = 5000;
  const deadline = Date.now() + TIMEOUT;
  const left = () => Math.max(1000, deadline - Date.now());
  for (;;) {
    const chosen = await onElement(selector, () => chooseMatch(selector, left()));
    if (!chosen) {
      // Only counted so far, so the whole time is Playwright's, as it was before; the cursor's glide, if it
      // is on, waits for the element as part of it.
      const glided = Date.now();
      const point = await onElement(selector, () => aimAt(state.page, state.page.locator(selector).first(), TIMEOUT));
      await onElement(selector, () => act(state.page, selector, { ...options, timeout: Math.max(1000, TIMEOUT - (Date.now() - glided)) }));
      await landed(point, clicks);
      return '';
    }
    try {
      // The first of several is named, as it may not be the one meant (a heading with a button's text);
      // before acting, since a click may take the page away.
      const what = chosen.position === 1
        ? await chosen.handle.evaluate((/** @type {HTMLElement} */ el) => `<${el.tagName.toLowerCase()}> ${(el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)}`).catch(() => null)
        : null;
      const point = await aimAt(state.page, chosen.handle, left());
      await onElement(selector, () => act(chosen.handle, null, { ...options, timeout: left() }));
      await landed(point, clicks);
      if (chosen.position !== 1) return ` (match ${chosen.position} of ${chosen.count}; the ones before it are hidden or covered)`;
      return ` (the first of ${chosen.count} matches${what ? `: ${what}` : ''})`;
    } catch (error) {
      if (!/not attached/i.test(error.message) || Date.now() >= deadline) throw error;
    } finally {
      await chosen.handle.dispose().catch(() => {});
    }
  }
}

// Playwright scrolls an element into view before acting on it, in every box that clips it, those with
// overflow: hidden too. A user cannot scroll those, and a page that pans with a transform never scrolls
// them back, so its view stays shifted. That is said, not undone: a carousel scrolls its own hidden
// track, and means the click to show the slide. Read around the action, fail-silent, and never long:
// the page may be busy, or gone, after it.
const SCROLL_READ_MS = 500;

/**
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T | null>}
 */
function briefly(promise) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(() => resolve(null), SCROLL_READ_MS); });
  return Promise.race([promise.catch(() => null), late]).finally(() => clearTimeout(timer));
}

// The scroll offsets, before the action, of the overflow: hidden boxes around the matches, and of the page
// when it hides its own overflow; null when there is nothing to watch.
/** @param {string[]} selectors */
async function hiddenScrollsBefore(selectors) {
  const page = state.page;
  return briefly((async () => {
    const handles = (await Promise.all(selectors.map(s => page.locator(s).elementHandles()))).flat();
    if (!handles.length) return null;
    try {
      return await page.evaluateHandle((/** @type {Element[]} */ els) => {
        const hidden = (/** @type {Element} */ e) => /hidden/.test(`${getComputedStyle(e).overflowX} ${getComputedStyle(e).overflowY}`);
        /** @type {Set<Element>} */
        const boxes = new Set();
        const root = document.scrollingElement;
        if (root && (hidden(document.documentElement) || (document.body && hidden(document.body)))) boxes.add(root);
        for (const el of els) {
          for (let n = el.parentNode; n; n = n instanceof ShadowRoot ? n.host : n.parentNode) {
            if (n instanceof Element && n !== document.documentElement && n !== document.body && hidden(n)) boxes.add(n);
          }
        }
        return [...boxes].map(box => ({ box, left: box.scrollLeft, top: box.scrollTop }));
      }, /** @type {any} */ (handles));
    } finally {
      await Promise.all(handles.map(h => h.dispose().catch(() => {})));
    }
  })());
}

// A line for each of those boxes the action scrolled, or ''.
/** @param {import('playwright-core').JSHandle | null} before */
async function hiddenScrollsNote(before) {
  if (!before) return '';
  const moved = await briefly(before.evaluate((/** @type {{ box: Element, left: number, top: number }[]} */ boxes) => boxes
    // Back at 0, 0 is where the page keeps a box it never scrolls: that undoes a shift, not makes one.
    .filter(b => b.box.isConnected && (b.box.scrollLeft !== b.left || b.box.scrollTop !== b.top) && (b.box.scrollLeft || b.box.scrollTop))
    .map(({ box, left, top }) => {
      const dx = Math.round(box.scrollLeft - left);
      const dy = Math.round(box.scrollTop - top);
      if (box === document.scrollingElement) return `the page by ${dx}, ${dy}`;
      const classes = typeof box.className === 'string' ? box.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
      return `<${box.tagName.toLowerCase()}${box.id ? `#${box.id}` : ''}${classes.map(c => `.${c}`).join('')}> by ${dx}, ${dy}`;
    })));
  await before.dispose().catch(() => {});
  if (!moved?.length) return '';
  return `Note: to reach it, Playwright scrolled ${moved.join(' and ')}, though it has overflow: hidden, which a user cannot scroll; the page may not expect it, and its view stays shifted (help click --all).`;
}

// Runs an action on elements, its output included, and adds that note: after the output, or to the
// error, as a failed action may have scrolled too.
/**
 * @template T
 * @param {string[]} selectors
 * @param {() => Promise<T>} action
 * @returns {Promise<T>}
 */
async function notingHiddenScrolls(selectors, action) {
  const before = await hiddenScrollsBefore(selectors);
  let result;
  try {
    result = await action();
  } catch (error) {
    const note = await hiddenScrollsNote(before);
    if (note && error instanceof Error) error.message += `\n${note}`;
    throw error;
  }
  const note = await hiddenScrollsNote(before);
  if (note) out.log(note);
  return result;
}

// After a pointer action: Playwright's mouse is where it acted, at the centre the cursor glided to,
// or somewhere the REPL does not know without the cursor. A click shows where it landed.
/**
 * @param {{ x: number, y: number } | null} point
 * @param {number} clicks
 */
async function landed(point, clicks) {
  tabState(state.page).mouseAt = point;
  if (clicks) await showClick(state.page, clicks);
}

// Finds the element a command without a pointer acts on (fill, select...), for the cursor to glide
// to, as someone would go to it first, and for a recording's steps; the mouse itself stays where it is. What is left of the command's
// 5s is its timeout, so the glide does not make it wait longer for an element that never comes.
/** @param {string} selector */
async function aimFor(selector) {
  if (!aiming(state.page)) return 5000;
  const started = Date.now();
  await onElement(selector, () => aimAt(state.page, state.page.locator(selector).first(), 5000));
  return Math.max(1000, 5000 - (Date.now() - started));
}

// While the tab records, a wheel turn goes in small steps, eased, over 400ms to 1s by its length, so the
// video scrolls rather than jumps; the same distance in all.
/**
 * @param {number} dx
 * @param {number} dy
 */
async function smoothWheel(dx, dy) {
  const ms = Math.min(1000, Math.max(400, Math.hypot(dx, dy) * 0.8));
  const steps = Math.max(1, Math.round(ms / 25));
  const ease = (/** @type {number} */ t) => t * t * (3 - 2 * t);
  let sentX = 0;
  let sentY = 0;
  for (let i = 1; i <= steps; i += 1) {
    const x = Math.round(dx * ease(i / steps));
    const y = Math.round(dy * ease(i / steps));
    if (x !== sentX || y !== sentY) await state.page.mouse.wheel(x - sentX, y - sentY);
    sentX = x;
    sentY = y;
    await new Promise(resolve => setTimeout(resolve, ms / steps));
  }
}

// While the tab records, text is typed at a pace a viewer can follow, steady rather than human-like.
// Otherwise at once, as before.
function typingPace() {
  return recordingOf(state.page) ? 60 : 0;
}

// check, uncheck and upload's button click it at its centre, where aimFor put the cursor.
async function clickedHere() {
  const cursor = cursorOf(state.page);
  if (!cursor) return;
  tabState(state.page).mouseAt = { x: cursor.x, y: cursor.y };
  await showClick(state.page);
}

// The mouse commands act where the mouse is: the cursor goes back there first, if it went elsewhere.
async function glideToMouse() {
  const at = tabState(state.page).mouseAt;
  if (!at) return;
  stepTarget(state.page, null, at);
  await glideTo(state.page, at.x, at.y);
}

// Highlights: Playwright's own overlay, as playwright-cli's highlight draws it. Each is a mode of its
// tab, so modes shows it and modes off hides it, and none is left on the page when the REPL stops.
/** @param {Page} p */
function highlightsOf(p) {
  if (!tabState(p).highlights) {
    tabState(p).highlights = new Map();
    // A new document drops the overlay; a page that routes on the client keeps it.
    p.on('domcontentloaded', () => tabState(p).highlights?.clear());
  }
  return tabState(p).highlights;
}

// Hides a tab's highlights, or only the running client's (mine).
/** @param {Page} p */
async function hideHighlights(p, mine = false) {
  const highlights = tabState(p).highlights;
  if (!highlights?.size) return 0;
  const hidden = [...highlights].filter(([, h]) => !mine || (h.owner ?? null) === (state.client ?? null));
  if (hidden.length === highlights.size) await p.hideHighlight();
  else for (const [selector, h] of hidden) await (h.drawn || p.locator(selector)).hideHighlight();
  for (const [selector] of hidden) highlights.delete(selector);
  return hidden.length;
}

onShutdown(async () => {
  if (!state.browser || state.connectionLost) return;
  const pages = state.browser.contexts().flatMap(c => c.pages()).filter(p => !p.isClosed());
  await Promise.all(pages.map(p => hideHighlights(p).catch(() => {})));
});

// Playwright's highlight labels each box with its locator, which covers what is below it, and has
// no option not to; highlights are drawn without it unless highlight --labels on. Its overlay is an
// x-pw-glass element with a closed shadow root, which only CDP reaches: a stylesheet adopted there
// hides the labels, under any CSP, and stays as Playwright redraws them. Playwright removes the
// overlay with its last highlight, and the sheet with it, so it is applied again after each one.
const LABELS_OFF = 'x-pw-tooltip:not([data-pw-repl])';
// The clients told that the labels could not be hidden, each once.
const labelsWarned = new Set();

// Adds or removes the sheet in the main document's overlay, and says whether it worked: false when
// there is an overlay but its labels are not hidden. Null when there is no overlay.
/**
 * @param {Page} p
 * @param {boolean} hide
 */
async function applyLabels(p, hide) {
  const session = await p.context().newCDPSession(p);
  try {
    const { root } = await session.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'x-pw-glass' });
    if (!nodeId) return null;
    const { node } = await session.send('DOM.describeNode', { nodeId, pierce: true });
    const shadow = node.shadowRoots?.[0];
    if (!shadow) return false;
    const { object } = await session.send('DOM.resolveNode', { backendNodeId: shadow.backendNodeId });
    /**
     * @param {Function} fn
     * @param {unknown[]} args
     */
    const call = (fn, args) => session.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: fn.toString(), arguments: args.map(value => ({ value })), returnByValue: true });
    await call(/**
     * @this {ShadowRoot}
     * @param {string} rule
     * @param {boolean} hidden
     */ function (rule, hidden) {
      const sheets = [...this.adoptedStyleSheets].filter(s => ![...s.cssRules].some(r => /** @type {CSSStyleRule} */ (r).selectorText === rule));
      if (hidden) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(`${rule} { display: none !important; }`);
        sheets.push(sheet);
      }
      this.adoptedStyleSheets = sheets;
    }, [LABELS_OFF, hide]);
    if (!hide) return true;
    // Playwright draws its labels on a later frame.
    await settled(p);
    const { result } = await call(/**
     * @this {ShadowRoot}
     * @param {string} rule
     */ function (rule) {
      const ours = [...this.adoptedStyleSheets].some(s => [...s.cssRules].some(r => /** @type {CSSStyleRule} */ (r).selectorText === rule));
      return ours && [...this.querySelectorAll('x-pw-tooltip')].every(t => getComputedStyle(t).display === 'none');
    }, [LABELS_OFF]);
    return result.value === true;
  } finally {
    await session.detach().catch(() => {});
  }
}

// Hides the tab's labels unless they are on; says so once if that failed, and the highlight is drawn
// with its label as Playwright draws it. A CDP call that fails, as one does when the tab navigates or
// closes, says nothing of Playwright's overlay: only the check finding the labels shown does.
/** @param {Page} p */
async function keepLabels(p) {
  if (tabState(p).labelsOn) return;
  const worked = await applyLabels(p, true).catch(() => null);
  const client = state.client ?? null;
  if (worked !== false || labelsWarned.has(client)) return;
  labelsWarned.add(client);
  out.log(`highlight: could not hide the labels; Playwright's highlight has changed (playwright-core ${require('playwright-core/package.json').version}). The boxes are drawn with their labels.`);
}

/**
 * @param {Page} p
 * @param {boolean} on
 */
async function setLabels(p, on) {
  if (on) tabState(p).labelsOn = { owner: state.client }; else delete tabState(p).labelsOn;
  if (on) await applyLabels(p, false); else await keepLabels(p);
}

// A date or time input takes keys part by part, in the order it shows them (10/02/2026 in en-US), so
// its ISO form, typed, comes out empty or mangled; fill sets it from that.
/** @type {Record<string, [RegExp, string]>} */
const DATE_INPUTS = {
  date: [/^\d{4,}-\d\d-\d\d$/, '2026-10-02'],
  time: [/^\d\d:\d\d(:\d\d(\.\d+)?)?$/, '14:30'],
  'datetime-local': [/^\d{4,}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)?$/, '2026-10-02T14:30'],
  month: [/^\d{4,}-\d\d$/, '2026-10'],
  week: [/^\d{4,}-W\d\d$/, '2026-W40'],
};
/**
 * @param {string} kind
 * @param {string} text
 * @param {string} what
 * @param {string} selector
 */
function refuseIsoDate(kind, text, what, selector) {
  if (DATE_INPUTS[kind]?.[0].test(text)) throw new Error(`${what} is a ${kind} input: typed, ${text} comes out mangled, since it takes keys part by part in the order it shows them. fill ${selector} ${text} sets it`);
}
/**
 * @param {string} kind
 * @param {string | undefined} value
 * @param {string} what
 * @param {string} selector
 */
function dateInputHolds(kind, value, what, selector) {
  if (!DATE_INPUTS[kind]) return '';
  if (!value) throw new Error(`${what}, a ${kind} input, is still empty: it takes keys part by part, in the order it shows them. fill sets it from its ISO form: fill ${selector} ${DATE_INPUTS[kind][1]}`);
  return `, a ${kind} input, which now holds ${value}`;
}

// drag <x1> <y1> <x2> <y2>: for what has no element to drag by, such as a canvas or a map's pan. Moved in
// steps, as a page that tracks the pointer needs moves between the two points, not one jump.
const DRAG_STEPS = 10;

/**
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 */
async function dragBetween(x1, y1, x2, y2) {
  await refuseOutside(x1, y1, 'dragged');
  stepTarget(state.page, null, { x: x1, y: y1 });
  await glideTo(state.page, x1, y1);
  await state.page.mouse.move(x1, y1);
  await state.page.mouse.down();
  tabState(state.page).mouseAt = { x: x1, y: y1 };
  // Pressed from here on: a failure would leave the button down, which the page would take as a drag still going.
  try {
    await showClick(state.page);
    await glideTo(state.page, x2, y2);
    await state.page.mouse.move(x2, y2, { steps: DRAG_STEPS });
  } catch (error) {
    await state.page.mouse.up().catch(() => {});
    throw error;
  }
  await state.page.mouse.up();
  tabState(state.page).mouseAt = { x: x2, y: y2 };
  out.log(`Dragged from ${x1}, ${y1} to ${x2}, ${y2}${await outsideNote(x2, y2)}`);
}

// mouse's actions.
// Playwright's mouse starts at the top left.
const mouseAt = () => tabState(state.page).mouseAt || { x: 0, y: 0 };

// A press outside the viewport reaches nothing, so it is refused rather than reported done.
/**
 * @param {number} x
 * @param {number} y
 * @param {string} nothing
 */
async function refuseOutside(x, y, nothing) {
  const outside = await outsideViewport(x, y);
  if (outside) throw new Error(`${x}, ${y} is outside the viewport (${outside}); nothing was ${nothing}. ${IN_VIEW}`);
}

// mouse down and wheel act where the mouse is.
/** @param {string} nothing */
async function refuseMouseOutside(nothing) {
  const { x, y } = mouseAt();
  const outside = await outsideViewport(x, y);
  if (outside) throw new Error(`The mouse is at ${x}, ${y}, outside the viewport (${outside}); nothing was ${nothing}. mouse move to a point inside it first, or scroll what you want into view`);
}

// A move or a release may go outside it, as a drag the page holds on to can.
/**
 * @param {number} x
 * @param {number} y
 */
async function outsideNote(x, y) {
  const outside = await outsideViewport(x, y);
  return outside ? ` (outside the viewport, ${outside})` : '';
}

/** @type {Record<string, (line: string) => Promise<void>>} */
const MOUSE = {
  // At a point, in CSS pixels from the top left of the tab's viewport, as playwright-cli's are.
  async move(args) {
    const [x, y, extra] = numbers(args, 'mouse move <x> <y>');
    if (y === undefined || extra !== undefined) throw new Error('Usage: mouse move <x> <y>, in CSS pixels from the top left of the viewport');
    stepTarget(state.page, null, { x, y });
    await glideTo(state.page, x, y);
    await state.page.mouse.move(x, y);
    tabState(state.page).mouseAt = { x, y };
    out.log(`Moved the mouse to ${x}, ${y}${await outsideNote(x, y)}`);
  },

  // A click at a point, as Playwright's mouse.click: for what has no selector, such as a marker drawn on a canvas.
  async click(line) {
    const usage = 'mouse click <x> <y> [left|right|middle] [--button=<button>] [--click-count=<n>] [--delay=<ms>]';
    const { words, found, button } = mouseArgs(line, usage, { 'click-count': 'value', delay: 'value' });
    const clickCount = clickCountOf(found, usage);
    const delay = found.find(o => o.name === 'delay');
    if (delay && !/^\d+$/.test(delay.value || '')) throw new Error(`Usage: ${usage}, the ms between press and release, e.g. mouse click 400 300 --delay=500`);
    const held = delay ? Number(delay.value) : 0;
    const [x, y, extra] = numbers(words.join(' '), usage);
    if (y === undefined || extra !== undefined) throw new Error(`Usage: ${usage}, in CSS pixels from the top left of the viewport`);
    await refuseOutside(x, y, 'clicked');
    stepTarget(state.page, null, { x, y });
    await glideTo(state.page, x, y);
    await state.page.mouse.move(x, y);
    tabState(state.page).mouseAt = { x, y };
    // Each press counts up, as Playwright's mouse.click does it. The ring shows at the first press, as
    // mouse down's does, while a --delay holds the button.
    for (let count = 1; count <= clickCount; count += 1) {
      await state.page.mouse.down({ button, clickCount: count });
      if (count === 1) await showClick(state.page, clickCount);
      if (held) await new Promise(resolve => setTimeout(resolve, held));
      await state.page.mouse.up({ button, clickCount: count });
    }
    out.log(`Clicked the ${button} button at ${x}, ${y}${clickCount > 1 ? ` ${clickCount} times` : ''}`);
  },

  // Two mouse clicks are two single clicks (each event's detail is 1), so no dblclick fires: this is one.
  async dblclick(line) {
    const usage = 'mouse dblclick <x> <y> [left|right|middle] [--button=<button>]';
    const { words, button } = mouseArgs(line, usage);
    const [x, y, extra] = numbers(words.join(' '), usage);
    if (y === undefined || extra !== undefined) throw new Error(`Usage: ${usage}, in CSS pixels from the top left of the viewport`);
    await refuseOutside(x, y, 'clicked');
    stepTarget(state.page, null, { x, y });
    await glideTo(state.page, x, y);
    await state.page.mouse.dblclick(x, y, { button });
    tabState(state.page).mouseAt = { x, y };
    await showClick(state.page, 2);
    out.log(`Double-clicked the ${button} button at ${x}, ${y}`);
  },

  async down(args) {
    const button = mouseButton(args, 'mouse down');
    await refuseMouseOutside('pressed');
    await glideToMouse();
    await state.page.mouse.down({ button });
    await showClick(state.page);
    out.log(`Pressed the ${button} button`);
  },

  async up(args) {
    const button = mouseButton(args, 'mouse up');
    await glideToMouse();
    await state.page.mouse.up({ button });
    out.log(`Released the ${button} button${await outsideNote(mouseAt().x, mouseAt().y)}`);
  },

  // Wheel events where the mouse is (mouse move puts it there): a map zooms around that point.
  async wheel(args) {
    const [dx, dy, extra] = numbers(args, 'mouse wheel <dx> <dy>');
    if (dy === undefined || extra !== undefined) throw new Error('Usage: mouse wheel <dx> <dy>, e.g. mouse wheel 0 300 scrolls down (negative dy up)');
    await refuseMouseOutside('scrolled');
    await glideToMouse();
    if (recordingOf(state.page)) await smoothWheel(dx, dy);
    else await state.page.mouse.wheel(dx, dy);
    out.log(`Turned the wheel by ${dx}, ${dy}`);
  },
};

const commands = {
  /** @param {string} args */
  async click(args) {
    const { selector, shown, options } = clickArgs(args, 'click <selector> [left|right|middle] [--button=<button>] [--click-count=<n>] [--modifiers=<key>[,<key>]] [--force]', true);
    await notingHiddenScrolls([selector], async () => {
      const which = await pointerAction(selector, (on, sel, o) => (sel ? on.click(sel, o) : on.click(o)), options, options.clickCount || 1);
      out.log(`Clicked: ${shown}${which}`);
    });
  },

  /** @param {string} args */
  async dblclick(args) {
    const { selector, shown, options } = clickArgs(args, 'dblclick <selector> [left|right|middle] [--button=<button>] [--modifiers=<key>[,<key>]] [--force]');
    await notingHiddenScrolls([selector], async () => {
      const which = await pointerAction(selector, (on, sel, o) => (sel ? on.dblclick(sel, o) : on.dblclick(o)), options, 2);
      out.log(`Double-clicked: ${shown}${which}`);
    });
  },

  // drag <from> <to>, as playwright-cli's drag: Playwright's locator.dragTo, in its steps (hover the
  // source, press, hover the target, release), so the cursor can glide to each in turn. Chromium turns
  // the moves into an HTML5 drag when the source is draggable.
  /** @param {string} args */
  async drag(args) {
    const usage = 'Usage: drag <from> <to>, each a selector or a ref, quoted if it has spaces: drag e5 e9, drag "text=Item 1" "#list li"; or drag <x1> <y1> <x2> <y2>, points in the viewport';
    const words = (args || '').trim().split(/\s+/);
    if (words.length === 4 && words.every(w => /^-?\d+(?:\.\d+)?$/.test(w))) return dragBetween(.../** @type {[number, number, number, number]} */ (words.map(Number)));
    // Not null past the usage check: a null from leaves to null too.
    const from = /** @type {NonNullable<ReturnType<typeof splitSelector>>} */ (splitSelector(args));
    const to = from?.rest !== undefined ? splitSelector(from.rest) : null;
    if (!to || to.rest !== undefined) throw new Error(usage);
    await notingHiddenScrolls([from.selector, to.selector], async () => {
      const TIMEOUT = 5000;
      const deadline = Date.now() + TIMEOUT;
      const left = () => Math.max(1000, deadline - Date.now());
      const source = state.page.locator(from.selector).first();
      const target = state.page.locator(to.selector).first();
      await onElement(from.selector, () => aimAt(state.page, source, left()));
      await onElement(from.selector, () => source.hover({ timeout: left() }));
      await state.page.mouse.down();
      // Pressed from here on: a failure would leave the button down, which the page would take as a drag still going.
      try {
        await showClick(state.page);
        await onElement(to.selector, () => aimAt(state.page, target, left()));
        await onElement(to.selector, () => target.hover({ timeout: left() }));
      } catch (error) {
        await state.page.mouse.up().catch(() => {});
        throw error;
      }
      await state.page.mouse.up();
      const box = await target.boundingBox({ timeout: 1000 }).catch(() => null);
      tabState(state.page).mouseAt = box ? { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } : null;
      out.log(`Dragged ${from.word} to ${to.word}`);
    });
  },

  /** @param {string} args */
  async hover(args) {
    const selector = soleSelector(args, 'hover <selector>');
    await notingHiddenScrolls([selector], async () => {
      const which = await pointerAction(selector, (on, sel, o) => (sel ? on.hover(sel, o) : on.hover(o)));
      out.log(`Hovered: ${args.trim()}${which}`);
    });
  },

  /** @param {string} args */
  async highlight(args) {
    const usage = 'Usage: highlight [<selector> [--style=<css>] | --hide [<selector>] | --labels off|on | off]';
    const { found, rest } = takeOptions((args || '').trim(), { style: 'value', hide: 'flag', labels: 'value' });
    const style = found.find(o => o.name === 'style');
    const hide = found.some(o => o.name === 'hide');
    const labels = found.find(o => o.name === 'labels');
    const highlights = highlightsOf(state.page);
    // For the whole tab, with a highlight to draw or on its own.
    if (labels) {
      if (hide || rest === 'off' || !['off', 'on'].includes(/** @type {string} */ (labels.value))) throw new Error(usage);
      await setLabels(state.page, labels.value === 'on');
      out.log(labels.value === 'on'
        ? 'Labels on in the selected tab: each highlight is labelled with its locator; highlight --labels off hides them'
        : 'Labels off in the selected tab');
      if (!rest) return;
    }
    if (!rest && !found.length) {
      if (!highlights.size) { out.log(`Nothing is highlighted in the selected tab.\n${hints([['highlight <selector>', 'draw a box around it']])}`); return; }
      for (const [selector, h] of highlights) out.log(`${selector}${h.drawn?.toString() !== state.page.locator(selector).toString() ? `  as ${h.drawn}` : ''}${h.style ? `  --style=${JSON.stringify(h.style)}` : ''}${h.owner ? `  (by ${h.owner})` : ''}`);
      const on = tabState(state.page).labelsOn;
      if (on) out.log(`Labels are on${on.owner ? ` (by ${on.owner})` : ''}.`);
      out.log(hints([['highlight --hide [<selector>]', 'hide one, or all'], on ? ['highlight --labels off', 'hide their labels'] : ['highlight --labels on', 'label each with its locator']]));
      return;
    }
    if (rest === 'off' && !found.length || hide && !rest) {
      const count = await hideHighlights(state.page);
      out.log(count ? `Hid ${count} highlight${count === 1 ? '' : 's'}` : 'Nothing was highlighted in the selected tab.');
      return;
    }
    if (!rest || style && (hide || !style.value)) throw new Error(usage);
    const selector = soleSelector(rest, usage);
    const locator = state.page.locator(selector);
    if (hide) {
      if (!highlights.has(selector)) throw new Error(`${rest} is not highlighted; highlight lists what is`);
      await (highlights.get(selector).drawn || locator).hideHighlight();
      highlights.delete(selector);
      out.log(`Hid the highlight on ${rest}`);
      return;
    }
    const count = await locator.count();
    if (!count) throw new Error(`No element matches ${rest}; nothing was highlighted`);
    // Drawn again, with its new style, rather than twice.
    if (highlights.has(selector)) await (highlights.get(selector).drawn || locator).hideHighlight();
    // Playwright labels a box with the locator it is given, and a snapshot ref's (aria-ref=e5) finds
    // nothing in the page's code: one is drawn with the locator Playwright makes for its element.
    const drawn = REF.test(rest) ? await locator.normalize().catch(() => locator) : locator;
    await drawn.highlight(style ? { style: style.value } : {});
    await keepLabels(state.page);
    highlights.set(selector, { owner: state.client, style: style?.value || null, drawn });
    out.log(`Highlighted ${rest}${count > 1 ? ` (all ${count} matches)` : ''}; highlight --hide ${rest} hides it`);
    // Recording, its steps say where the box is (the first match's), and it is shown before the next
    // command, which may take it away.
    if (recordingOf(state.page)) stepTarget(state.page, await locator.first().boundingBox({ timeout: 1000 }).catch(() => null), null);
    pauseToShow(state.page);
  },

  // mouse <action>, as Playwright's page.mouse: at a point, or where the mouse is.
  /** @param {string} line */
  async mouse(line) {
    const [action, ...rest] = (line || '').trim().split(/\s+/);
    if (!Object.hasOwn(MOUSE, action)) throw new Error(`Usage: mouse ${Object.keys(MOUSE).join('|')} ...; help mouse says what each takes`);
    await MOUSE[action](rest.join(' '));
  },

  /** @param {string} line */
  async fill(line) {
    const { args, submit } = submitFlag(line);
    const { selector, value, shown } = selectorAndValue(args, 'fill <selector> <value> [--submit]', 'fill #name Ada Lovelace');
    await notingHiddenScrolls([selector], async () => {
      const timeout = await aimFor(selector);
      await onElement(selector, () => state.page.fill(selector, value, { timeout }));
      if (submit) await state.page.press(selector, 'Enter', { timeout: 5000 });
      out.log(`Filled${submit ? ' and submitted' : ''}: ${shown}`);
    });
  },

  /** @param {string} line */
  async type(line) {
    // --delay=<ms> goes first, so text with --delay in it is still text.
    const paced = /^\s*--delay(?:=|\s+)(\S*)(?:\s+|$)/.exec(line || '');
    if (paced && !/^\d+$/.test(paced[1])) throw new Error('Usage: type --delay=<ms> [<selector>] <text>, the pause between keys, e.g. type --delay=80 #search garden hose');
    const { args, submit } = submitFlag(paced ? line.slice(paced[0].length) : line);
    const delay = () => (paced ? Number(paced[1]) : typingPace());
    // One word, or one quoted, is typed into the focused element, as playwright-cli's type does.
    const sole = splitSelector(args);
    if (sole && sole.rest === undefined) {
      // Named, since it may not be the element meant; one that takes no text is refused.
      const focused = await state.page.evaluate(() => {
        let el = document.activeElement;
        while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        const field = /** @type {HTMLInputElement} */ (el);
        const editable = field.isContentEditable || el.matches('textarea, input:not([type=checkbox],[type=radio],[type=button],[type=submit],[type=reset],[type=image],[type=file],[type=range],[type=color],[type=hidden])');
        const id = el.id ? `#${el.id}` : field.name ? `[name=${field.name}]` : field.placeholder ? `[placeholder="${field.placeholder}"]` : '';
        return { editable, name: `${el.tagName.toLowerCase()}${id}`, type: field.type };
      });
      const usage = 'type <selector> <text> types into an element, e.g. type #search garden hose';
      if (!focused) throw new Error(`Nothing on the page has focus: ${usage}`);
      if (!focused.editable) throw new Error(`The focused element, ${focused.name}, takes no text: ${usage}`);
      refuseIsoDate(focused.type, sole.word, `The focused ${focused.name}`, '<selector>');
      await state.page.keyboard.type(sole.word, { delay: delay() });
      const held = DATE_INPUTS[focused.type] ? dateInputHolds(focused.type, await state.page.evaluate(() => {
        let el = document.activeElement;
        while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
        return /** @type {HTMLInputElement} */ (el)?.value;
      }), `The focused ${focused.name}`, '<selector>') : '';
      if (submit) await state.page.keyboard.press('Enter');
      out.log(`Typed into the focused ${focused.name}${held}${submit ? ', and submitted' : ''}`);
      return;
    }
    const { selector, value, shown } = selectorAndValue(args, 'type [<selector>] <text> [--submit]', 'type #search garden hose');
    await notingHiddenScrolls([selector], async () => {
      const timeout = await aimFor(selector);
      // Typed after what the field already holds, as someone clicking into it
      // at the end would; focusing it alone leaves the caret at the start.
      const kind = await onElement(selector, () => state.page.locator(selector).first().evaluate((/** @type {HTMLInputElement} */ el, dateKinds) => {
        // Focused again, so a date input already focused takes keys from its first part, not where it was left.
        if (dateKinds.includes(el.type) && el.matches(':focus')) el.blur();
        el.focus();
        if (typeof el.value === 'string' && typeof el.setSelectionRange === 'function') {
          try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
        } else if (el.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          /** @type {Selection} */ (getSelection()).removeAllRanges();
          /** @type {Selection} */ (getSelection()).addRange(range);
        }
        return el.type;
      }, Object.keys(DATE_INPUTS), { timeout }));
      const quoted = /\s/.test(shown) ? `"${shown}"` : shown;
      refuseIsoDate(kind, value, shown, quoted);
      await state.page.keyboard.type(value, { delay: delay() });
      const held = DATE_INPUTS[kind] ? dateInputHolds(kind, await onElement(selector, () => state.page.locator(selector).first().evaluate((/** @type {HTMLInputElement} */ el) => el.value, null, { timeout: 5000 })), shown, quoted) : '';
      if (submit) await state.page.keyboard.press('Enter');
      out.log(`Typed into${submit ? ' and submitted' : ''}: ${shown}${held}`);
    });
  },

  /** @param {string} args */
  async press(args) {
    const parsed = splitSelector(args);
    if (!parsed) throw new Error('Usage: press <key> | press <selector> <key>, e.g. press Enter or press #name Enter');
    if (parsed.rest === undefined) {
      await state.page.keyboard.press(keyName(parsed.word));
      out.log(`Pressed: ${keyName(parsed.word)}`);
      return;
    }
    const key = keyName(unquote(parsed.rest));
    await notingHiddenScrolls([parsed.selector], async () => {
      const timeout = await aimFor(parsed.selector);
      await onElement(parsed.selector, () => state.page.press(parsed.selector, key, { timeout }));
      out.log(`Pressed ${key} on ${parsed.word}`);
    });
  },

  /** @param {string} args */
  async keydown(args) {
    const key = keyName(unquote(args.trim()));
    if (!key) throw new Error('Usage: keydown <key>, e.g. keydown Shift');
    await state.page.keyboard.down(key);
    out.log(`Held down: ${key}`);
  },

  /** @param {string} args */
  async keyup(args) {
    const key = keyName(unquote(args.trim()));
    if (!key) throw new Error('Usage: keyup <key>, e.g. keyup Shift');
    await state.page.keyboard.up(key);
    out.log(`Released: ${key}`);
  },

  // As Playwright's locator.focus, which succeeds on an element that cannot take focus and leaves focus
  // where it was: the next key would go there, so that is refused, naming where it went.
  /** @param {string} args */
  async focus(args) {
    const selector = soleSelector(args, 'focus <selector>');
    const shown = args.trim();
    await notingHiddenScrolls([selector], async () => {
      const timeout = await aimFor(selector);
      const target = state.page.locator(selector).first();
      await onElement(selector, () => target.focus({ timeout }));
      const focus = await onElement(selector, () => target.evaluate(focusOn, null, { timeout: 5000 }));
      if (!focus.on) throw new Error(`${shown} did not take focus: it is not focusable (no tabindex, or disabled); ${focusedNow(focus.name)}`);
      out.log(`Focused: ${shown}`);
    });
  },

  /** @param {string} args */
  async blur(args) {
    const shown = (args || '').trim();
    if (!shown) {
      const { name } = await state.page.evaluate(focusOn, null);
      if (!name) throw new Error('Nothing on the page has focus');
      await state.page.evaluate(() => {
        let el = document.activeElement;
        while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
        /** @type {HTMLElement | null} */ (el)?.blur();
      });
      out.log(`Blurred the focused ${name}`);
      return;
    }
    const selector = soleSelector(args, 'blur [<selector>]');
    const target = state.page.locator(selector).first();
    const focus = await onElement(selector, () => target.evaluate(focusOn, null, { timeout: 5000 }));
    if (!focus.on) throw new Error(`${shown} did not have focus; ${focusedNow(focus.name)}`);
    await onElement(selector, () => target.blur({ timeout: 5000 }));
    out.log(`Blurred: ${shown}`);
  },

  /** @param {string} args */
  async select(args) {
    const { selector, value, shown } = selectorAndValue(args, 'select <selector> <value>', 'select #country Canada');
    await notingHiddenScrolls([selector], async () => {
      const timeout = await aimFor(selector);
      const target = state.page.locator(selector).first();
      await onElement(selector, () => showSelect(state.page, target, value, () => state.page.selectOption(selector, value, { timeout })));
      out.log(`Selected "${value}" in ${shown}`);
    });
  },

  /** @param {string} args */
  async check(args) {
    const selector = soleSelector(args, 'check <selector>');
    await notingHiddenScrolls([selector], async () => {
      const timeout = await aimFor(selector);
      await onElement(selector, () => state.page.check(selector, { timeout }));
      await clickedHere();
      out.log(`Checked: ${args.trim()}`);
    });
  },

  /** @param {string} args */
  async uncheck(args) {
    const selector = soleSelector(args, 'uncheck <selector>');
    await notingHiddenScrolls([selector], async () => {
      const timeout = await aimFor(selector);
      await onElement(selector, () => state.page.uncheck(selector, { timeout }));
      await clickedHere();
      out.log(`Unchecked: ${args.trim()}`);
    });
  },

  // The files are read here and handed to the page as their contents, not
  // their paths: the browser may run on another machine, or in another
  // container, where the paths mean nothing.
  /** @param {string} args */
  async upload(args) {
    const parsed = splitSelector(args);
    // playwright-cli's upload <file> answers a file picker a click opened. Here
    // the input is named instead: catching pickers would catch the user's too.
    const usage = 'Usage: upload <selector> <file>..., naming the file input (or the button that opens it) first, e.g. upload e12 ./doc.pdf; quote a path with spaces';
    if (!parsed || parsed.rest === undefined) throw new Error(usage);
    // A path, not a selector; // starts an XPath.
    if (/^(?:\.{1,2}\/|\/(?!\/)|~)/.test(parsed.word) || (!REF.test(parsed.word) && fs.statSync(path.resolve(parsed.word), { throwIfNoEntry: false })?.isFile())) throw new Error(`${parsed.word} is a file, not the input: ${usage.slice(7)}`);
    const files = [...parsed.rest.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map(m => path.resolve(m[1] !== undefined ? unescapeDouble(m[1]) : m[2] ?? m[3]));
    const payloads = files.map(file => {
      let buffer;
      try { buffer = fs.readFileSync(file); } catch (error) { throw new Error(`Cannot read ${file}: ${error.code === 'ENOENT' ? 'no such file' : error.code === 'EISDIR' ? 'it is a folder' : error.message}`); }
      return { name: path.basename(file), mimeType: mimeType(file), buffer };
    });
    const { selector } = parsed;
    await notingHiddenScrolls([selector], async () => {
      await aimFor(selector);
      await onElement(selector, async () => {
        try {
          await state.page.setInputFiles(selector, payloads, { timeout: 5000 });
        } catch (error) {
          if (!/not an HTMLInputElement/.test(error.message)) throw error;
          // A button that opens the file picker itself: click it, and answer the picker.
          const [chooser] = await Promise.all([state.page.waitForEvent('filechooser', { timeout: 5000 }), state.page.click(selector, { timeout: 5000 })]);
          await chooser.setFiles(payloads);
          await clickedHere();
        }
      });
      out.log(`Chose ${files.length === 1 ? 'a file' : `${files.length} files`} in ${parsed.word}: ${files.join(', ')}`);
    });
  },
};

module.exports = { commands, soleSelector, onElement, hideHighlights, setLabels };
