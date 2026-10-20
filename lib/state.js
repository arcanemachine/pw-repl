// Session state shared by the entry point, the runner, and the commands, plus
// the shutdown that ends the session.
const { AsyncLocalStorage } = require('async_hooks');
const out = require('./output');

const SHUTDOWN_TIMEOUT = 5000;

const state = {
  browser: null,
  rl: null,
  promptBase: 'pw> ',
  // The browser the REPL is connected to, and whether --launch started it.
  cdpUrl: null,
  launched: false,
  // The command server takes commands; before, it answers that the REPL is starting, and what it is doing.
  serving: false,
  startingStep: 'starting',
  stopping: false,
  connectionLost: false,
  shutdownFailed: false,
  // The folder of a socket of its own, where its screenshots go.
  ownDir: null,
};

// What each client has selected and when its commands ran: state.page and the
// rest read and write the running client's, so commands need not know.
const PER_CLIENT = { page: null, previousPage: null, tabListing: [], previousCommandAt: 0, currentCommandAt: 0 };
const clients = new Map();

out.onSelectedTab(() => state.page);

function clientRecord(name = state.client) {
  if (!clients.has(name)) clients.set(name, { ...PER_CLIENT, tabListing: [] });
  return clients.get(name);
}

// The command running in this async context: its client, and whether its sender gave up on it.
// Code outside any command (a browser event, quit and dialog, which skip the queue) goes by the
// queued command running now.
const running = new AsyncLocalStorage();
let queued = null;

// The client whose command runs now: null for the prompt and senders without a name, who share one
// selected tab, as before clients had names. Each command keeps its own for its whole life, so one
// its sender gave up on, still running, never acts as the command after it.
Object.defineProperty(state, 'client', { enumerable: true, get: () => (running.getStore() ?? queued)?.client ?? null });

out.onCancelled(() => running.getStore()?.cancelled === true);

for (const key of Object.keys(PER_CLIENT)) {
  Object.defineProperty(state, key, { enumerable: true, get: () => clientRecord()[key], set: value => { clientRecord()[key] = value; } });
}

// Runs fn as the named client. run is the command's record, whose cancelled the runner sets.
async function asClient(name, fn, run = {}) {
  queued = Object.assign(run, { client: name || null });
  try { return await running.run(run, fn); } finally { if (queued === run) queued = null; }
}

const cleanups = [];
const endings = [];
const exitWaits = [];
let shutdownPromise = null;

function withTimeout(promise, label, duration = SHUTDOWN_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), duration);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function onShutdown(fn) {
  cleanups.push(fn);
}

// Run once every cleanup has finished, before the browser is closed.
function onShutdownEnd(fn) {
  endings.push(fn);
}

// Things to finish before the process exits, e.g. answers still being sent.
function onBeforeExit(fn) {
  exitWaits.push(fn);
}

async function beforeExit() {
  await Promise.all(exitWaits.map(fn => fn()));
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  state.stopping = true;
  shutdownPromise = (async () => {
    // Some undo what the REPL changed in the browser, so they finish first.
    await withTimeout(Promise.all(cleanups.map(async fn => fn())), 'Cleanup').catch(() => {});
    for (const fn of endings) try { await fn(); } catch {}
    if (state.browser) {
      try { await withTimeout(state.browser.close(), 'Chromium shutdown'); }
      catch (error) { state.shutdownFailed = true; process.exitCode = 1; out.error(`Could not confirm Chromium shutdown: ${error.message}`); }
    }
  })();
  return shutdownPromise;
}

module.exports = { state, clientRecord, asClient, withTimeout, onShutdown, onShutdownEnd, onBeforeExit, beforeExit, shutdown, SHUTDOWN_TIMEOUT };
