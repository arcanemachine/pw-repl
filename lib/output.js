// All command output goes through here rather than straight to console, so a
// command run through the server can have its output collected and returned.
const OUTPUT_LIMIT = 12000;

/** @type {string[] | null} */
let sink = null;

// A cancelled command still running prints to the pane only, never into the next command's answer.
let cancelled = () => false;

/** @param {() => boolean} fn */
function onCancelled(fn) {
  cancelled = fn;
}

// A command run outside the queue (watch new --wait) collects its own output, which the runner prints
// to the pane once it is done, under the command, as its lines may come minutes after it was sent.
// state.js says which, from the command's own async context.
/** @type {() => string[] | null} */
let ownSink = () => null;

/** @param {() => string[] | null} fn */
function onOwnSink(fn) {
  ownSink = fn;
}

function isCancelled() {
  return cancelled();
}

/** @param {unknown} text */
function log(text) {
  const own = ownSink();
  if (own) { own.push(String(text)); return; }
  console.log(text);
  if (sink && !cancelled()) sink.push(String(text));
}

/** @param {unknown} text */
function error(text) {
  const own = ownSink();
  if (own) { own.push(String(text)); return; }
  console.error(text);
  if (sink && !cancelled()) sink.push(String(text));
}

// The queued command's output, whatever context it is called from: lines the browser causes belong there.
/** @param {unknown} text */
function queuedLog(text) {
  console.log(text);
  if (sink && !cancelled()) sink.push(String(text));
}

// Queued commands run one at a time, so a single sink is enough for them (one beside the queue has its
// own: onOwnSink). Lines printed by background events while it is open (e.g. a Faked line) are
// collected too.
/** @param {() => Promise<unknown>} fn */
async function collect(fn) {
  /** @type {string[]} */
  const lines = sink = [];
  try {
    await fn();
    return lines.join('\n');
  } finally {
    if (sink === lines) sink = null;
  }
}

// Ends the open collection early and returns what it has so far, so a quit
// can answer the command it interrupts without its own output mixed in.
function take() {
  const lines = sink || [];
  sink = null;
  return lines.join('\n');
}

// Lines the browser causes on its own (a faked request, a dialog) can arrive
// while the prompt is showing. The entry point registers how to print above
// the prompt and redraw it, so the pane still ends on a bare prompt.
/** @type {{ idle: () => boolean, print: (text: string) => void } | null} */
let idlePrinter = null;

/** @param {{ idle: () => boolean, print: (text: string) => void }} printer */
function onIdlePrint(printer) {
  idlePrinter = printer;
}

// The running command's selected tab, as state.js tells it (it requires this file, not the other way).
/** @type {() => import('playwright-core').Page | null} */
let selectedTab = () => null;

/** @param {() => import('playwright-core').Page | null} fn */
function onSelectedTab(fn) {
  selectedTab = fn;
}

// A notice from a tab (page) is part of a command's answer only when that command's client has
// the tab selected: another client's tab is not what it asked about. The pane shows it either way.
/**
 * @param {unknown} text
 * @param {import('playwright-core').Page | null} [page]
 */
function notice(text, page = null) {
  if (!sink && idlePrinter && idlePrinter.idle()) idlePrinter.print(String(text));
  else if (sink && page && page !== selectedTab()) console.log(text);
  else queuedLog(text);
}

// Like notice, but never part of a command's answer: for what the user at
// the browser does, which is not the output of the command running now.
/** @param {unknown} text */
function aside(text) {
  if (!sink && idlePrinter && idlePrinter.idle()) idlePrinter.print(String(text));
  else console.log(text);
}

// A footer is printed after the cut, so it is never cut off itself.
/** @param {unknown} value */
function printOutput(value, all = false, footer = '') {
  let text;
  if (typeof value === 'string') text = value;
  else text = JSON.stringify(value, null, 2);
  if (text === undefined) text = 'undefined';
  if (!all && text.length > OUTPUT_LIMIT) {
    // Cut at a line's end, unless the last one within the limit comes so early (a short line before a
    // long minified one) that little would be shown.
    const end = text.lastIndexOf('\n', OUTPUT_LIMIT);
    if (end > OUTPUT_LIMIT / 2) {
      const shown = text.slice(0, end);
      const at = shown.split('\n').length;
      text = `${shown}\n[truncated at line ${at} of ${text.split('\n').length}; add --all to the command to show all]`;
    } else {
      text = `${text.slice(0, OUTPUT_LIMIT)}\n[truncated; add --all to the command to show all]`;
    }
  }
  log(footer ? `${text}\n${footer}` : text);
}

module.exports = { OUTPUT_LIMIT, log, error, collect, take, notice, aside, onIdlePrint, onSelectedTab, onCancelled, onOwnSink, isCancelled, printOutput };
