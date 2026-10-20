// All command output goes through here rather than straight to console, so a
// command run through the server can have its output collected and returned.
const OUTPUT_LIMIT = 12000;

let sink = null;

// A cancelled command still running prints to the pane only, never into the next command's answer.
let cancelled = () => false;

function onCancelled(fn) {
  cancelled = fn;
}

function log(text) {
  console.log(text);
  if (sink && !cancelled()) sink.push(String(text));
}

function error(text) {
  console.error(text);
  if (sink && !cancelled()) sink.push(String(text));
}

// Commands run one at a time, so a single sink is enough. Lines printed by
// background events while it is open (e.g. a Faked line) are collected too.
async function collect(fn) {
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
let idlePrinter = null;

function onIdlePrint(printer) {
  idlePrinter = printer;
}

// The running command's selected tab, as state.js tells it (it requires this file, not the other way).
let selectedTab = () => null;

function onSelectedTab(fn) {
  selectedTab = fn;
}

// A notice from a tab (page) is part of a command's answer only when that command's client has
// the tab selected: another client's tab is not what it asked about. The pane shows it either way.
function notice(text, page = null) {
  if (!sink && idlePrinter && idlePrinter.idle()) idlePrinter.print(String(text));
  else if (sink && page && page !== selectedTab()) console.log(text);
  else log(text);
}

// Like notice, but never part of a command's answer: for what the user at
// the browser does, which is not the output of the command running now.
function aside(text) {
  if (!sink && idlePrinter && idlePrinter.idle()) idlePrinter.print(String(text));
  else console.log(text);
}

// A footer is printed after the cut, so it is never cut off itself.
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

module.exports = { OUTPUT_LIMIT, log, error, collect, take, notice, aside, onIdlePrint, onSelectedTab, onCancelled, printOutput };
