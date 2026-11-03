// Each tab's recent requests and console messages, their bodies, and waiting for a request or a load.
const { state } = require('./state');
const out = require('./output');
const { printOutput } = out;
const { clipText, regexOf, patternText, clock } = require('./util');
const { tabState } = require('./tabstate');
const { keptSession } = require('./cdp');
const { EventEmitter } = require('events');

/**
 * @typedef {import('playwright-core').Page} Page
 * @typedef {import('playwright-core').Request} Request
 * @typedef {import('playwright-core').Response} Response
 * @typedef {{ id: number, t: number, method: string, url: string, type: string, status: string, ms: number | null,
 *   response: Response | null, navigation: boolean, failed?: string, kept?: Buffer, marked?: boolean,
 *   messages?: Log<Message>, sent?: number, received?: number, before?: boolean }} RequestEntry
 * @typedef {{ t: number, type: string, text: string }} ConsoleEntry
 * @typedef {{ seq: number, t: number, way: 'sent' | 'received', text: string, size: number }} Message
 */

/**
 * A tab's log, and whether it has dropped its oldest.
 * @template T
 * @typedef {T[] & { dropped?: boolean }} Log
 */

// Marks a request a route answered, now: the browser reports it finished only later. One a route
// sent on (no status) gets its status when its response comes.
/**
 * @param {Request} req
 * @param {number | null} status
 * @param {string} how
 */
function markChanged(req, status, how) {
  changedRequests.set(req, how);
  const entry = requestEntries.get(req);
  if (entry && status !== null) { entry.status = `${status} ${how}`; entry.ms = Date.now() - entry.t; }
}

// Always-on request and console logs, so what happened can be checked after
// someone has already clicked through without a capture running. Requests
// keep metadata plus a handle to the response; a body is read from the
// browser only when asked for, and only while the browser still has it.
const RECENT_MAX = 200;
const RECENT_DEFAULT = 20;
const BODY_TIMEOUT = 15000;
// Hidden unless asked for: they are rarely what is being checked and crowd out
// the API calls that are.
const RECENT_HIDDEN_TYPES = new Set(['image', 'font', 'stylesheet', 'media']);
// What watch leaves out: scripts too, since a dev server loads dozens per navigation, crowding out the API calls.
const WATCH_HIDDEN_TYPES = new Set([...RECENT_HIDDEN_TYPES, 'script']);
// The bodies body prints; any other is binary.
const TEXT_BODY = /json|^text\/|javascript|xml|html|x-www-form-urlencoded/;

// UTF-8 with no control characters but tabs and line breaks.
/** @param {Buffer} buffer */
function looksLikeText(buffer) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return false; }
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}
// A watched tab keeps each body watch shows as it arrives, since the browser
// drops them once the tab navigates, often before anyone has read them.
const KEPT_BODY_MAX = 100 * 1024;
// request -> how a route changed it (faked or patched), shown after its status.
/** @type {WeakMap<Request, string>} */
const changedRequests = new WeakMap();
/** @type {WeakMap<Request, RequestEntry>} */
const requestEntries = new WeakMap();

// WebSocket and SSE messages, kept on their connection's entry so they go when it does: its last
// RECENT_MAX, each clipped as console text is, and no more than MESSAGES_TOTAL of text in a tab, the
// oldest across its connections dropped first, so a chatty socket or a reconnect loop stays bounded.
const MESSAGES_TOTAL = 2 * 1024 * 1024;
// The connections whose messages are kept: Playwright's resource types for them.
const CONNECTION_TYPES = new Set(['websocket', 'eventsource']);
// Each message as it is kept, and the connection, the page and the message, for capture.
const connectionEvents = new EventEmitter();
let nextMessageSeq = 1;

// The browser's own "Failed to load resource" message does not say which one.
/** @param {import('playwright-core').ConsoleMessage} msg */
function consoleText(msg) {
  const text = msg.text();
  const url = msg.location()?.url;
  return /^Failed to load resource/.test(text) && url ? `${text}: ${url}` : text;
}

// A level includes the ones above it, as playwright-cli's console [min-level]
// does, which sorts the types the same way; a page error is an error.
const CONSOLE_LEVELS = ['error', 'warning', 'info', 'debug'];
const DEBUG_TYPES = new Set(['clear', 'debug', 'endGroup', 'profile', 'profileEnd', 'startGroup', 'startGroupCollapsed', 'trace']);

/** @param {string} type */
function consoleLevel(type) {
  if (type === 'error' || type === 'assert' || type === 'pageerror') return 'error';
  if (type === 'warning') return 'warning';
  return DEBUG_TYPES.has(type) ? 'debug' : 'info';
}

/**
 * @template T
 * @param {Log<T>} log
 * @param {T} entry
 */
function keep(log, entry) {
  log.push(entry);
  if (log.length > RECENT_MAX) { log.shift(); log.dropped = true; }
}

// Said when a listing leaves some out, or it looks complete: a busy page makes more than the
// default in one load, and the log itself keeps only the last RECENT_MAX.
/**
 * @param {string} what
 * @param {number} shown
 * @param {number} total
 * @param {boolean | undefined} dropped
 * @param {(n: number) => string} command
 */
function cutNote(what, shown, total, dropped, command, limit = `the last ${RECENT_MAX} of every kind`) {
  if (shown < total) return `(last ${shown} of ${total} kept; ${command(Math.min(total, RECENT_MAX))} shows them all${dropped ? `; older ${what} are no longer kept` : ''})`;
  return dropped ? `(older ${what} are no longer kept: only ${limit} are)` : null;
}

// A request's status as requests shows it: its response's, and how a route changed it.
/**
 * @param {Request} req
 * @param {Response | null} res
 */
function statusOf(req, res) {
  const status = res ? String(res.status()) : 'no response';
  return changedRequests.has(req) ? `${status} ${changedRequests.get(req)}` : status;
}

// A message on a connection, kept (see MESSAGES_TOTAL). Binary is kept as its size only.
/**
 * @param {Page} p
 * @param {RequestEntry} entry
 * @param {'sent' | 'received'} way
 * @param {string | Buffer} payload
 * @param {number} [t]
 */
function keepMessage(p, entry, way, payload, t = Date.now()) {
  const text = typeof payload === 'string' ? clipText(payload) : `[binary, ${payload.length} bytes]`;
  // Counted with some overhead, so a flood of empty messages is bounded too.
  const message = { seq: nextMessageSeq++, t, way, text, size: text.length + 64 };
  entry[way] = (entry[way] || 0) + 1;
  keep(entry.messages ||= [], message);
  const tab = tabState(p);
  /** @type {[RequestEntry, Message][]} */
  const queue = tab.messageQueue ||= [];
  queue.push([entry, message]);
  tab.messageBytes = (tab.messageBytes || 0) + message.size;
  while (tab.messageBytes > MESSAGES_TOTAL && queue.length) {
    const [oldest, gone] = /** @type {[RequestEntry, Message]} */ (queue.shift());
    tab.messageBytes -= gone.size;
    // Unless its connection's own limit dropped it already.
    const kept = /** @type {Log<Message>} */ (oldest.messages);
    if (kept[0] === gone) { kept.shift(); kept.dropped = true; }
  }
  connectionEvents.emit('message', p, entry, message);
}

// The counts a connection's line ends with, in requests.
/** @param {RequestEntry} entry */
function messageCounts(entry) {
  const before = entry.before ? 'opened before the REPL connected; ' : '';
  if (entry.type === 'websocket') return ` (${before}${entry.sent || 0} sent, ${entry.received || 0} received)`;
  return entry.type === 'eventsource' ? ` (${before}${entry.received || 0} received)` : '';
}

// Once, whether it closed or its page was left.
/**
 * @param {Page} p
 * @param {RequestEntry} entry
 */
function endSocket(p, entry) {
  if (entry.ms !== null) return;
  if (entry.status === 'open') entry.status = 'closed';
  entry.ms = Date.now() - entry.t;
  connectionEvents.emit('close', p, entry);
}

// A frame on a socket our CDP session never saw made is held a moment, for Playwright's report of the
// socket to arrive (the two come apart), then put to the sockets Playwright reported that our session saw
// no making of: those made as the REPL attached, before our session's Network was on (the race), and a
// worker's, which our session never sees. The one whose messages hold the frame, the same way and text,
// within RACE_MATCH of it, is that socket. With none, the socket was opened before the REPL connected. A
// pre-existing socket whose first frame matches such a socket's message (both send "ping") is taken for
// it, and its frames are dropped: rare, and the cost is a socket missing, not a wrong one.
const RACE_MATCH = 250;
// An SSE stream has no frames to match by: one Playwright reported that our session saw no request for
// is taken for a stream with no request seen only within this of our session's Network coming on.
const RACE_STREAM = 1000;

/**
 * @param {'sent' | 'received'} way
 * @param {string} text
 * @param {number} t
 * @param {RequestEntry[]} candidates
 */
function matchRaceSocket(way, text, t, candidates) {
  return candidates.find(entry => (entry.messages || []).some(m => m.way === way && m.text === text && Math.abs(m.t - t) <= RACE_MATCH));
}

// The URLs of the page's open WebSockets or EventSources, in its main frame, for one opened before the REPL
// connected: CDP names none of it. Those the log already has open are taken off; only when what is left is
// one URL is it that one's.
/**
 * @param {import('playwright-core').CDPSession} session
 * @param {'WebSocket' | 'EventSource'} kind
 * @param {RequestEntry[]} open the entries of that kind open now, with a URL
 * @returns {Promise<string>}
 */
async function untrackedUrl(session, kind, open) {
  const objectGroup = 'pw-repl-connection-url';
  try {
    const proto = await session.send('Runtime.evaluate', { expression: `${kind}.prototype`, objectGroup });
    const found = await session.send('Runtime.queryObjects', { prototypeObjectId: /** @type {string} */ (proto.result.objectId), objectGroup });
    const urls = await session.send('Runtime.callFunctionOn', {
      objectId: /** @type {string} */ (found.objects.objectId),
      functionDeclaration: 'function () { return this.filter(c => c.readyState !== 2 && c.readyState !== 3).map(c => c.url); }',
      returnByValue: true,
    });
    /** @type {string[]} */
    const left = urls.result.value;
    for (const entry of open) { const at = left.indexOf(entry.url); if (at !== -1) left.splice(at, 1); }
    return new Set(left).size === 1 ? left[0] : '';
  } catch {
    return '';
  } finally {
    await session.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
  }
}

// A connection's URL as listed: one opened before the REPL connected may have none known.
/** @param {RequestEntry} entry */
function urlText(entry) {
  return entry.url || '(URL unknown)';
}

// A page's WebSockets (Playwright reports their frames, but no request for their handshake) and its
// server-sent events (only CDP reports their messages; the stream is a request already). A socket or
// stream opened before the REPL connected is reported to neither Playwright nor the request log: CDP still
// reports its messages, with no URL, and it gets an entry of its own.
/**
 * @param {Page} p
 * @param {Log<RequestEntry>} log
 * @param {() => number} nextId
 * @returns {(entry: RequestEntry) => void} for a stream the request log has, not from a request event
 */
function keepConnections(p, log, nextId) {
  // Playwright's sockets and streams not yet paired, by URL, with the making our session saw (in either
  // order), and how many our session saw made with no Playwright report yet.
  /** @type {RequestEntry[]} */
  const unpaired = [];
  /** @type {Map<string, number>} */
  const madeUnpaired = new Map();
  /** @type {(entry: RequestEntry) => void} */
  const reported = entry => {
    const made = madeUnpaired.get(`${entry.type} ${entry.url}`) || 0;
    if (made) madeUnpaired.set(`${entry.type} ${entry.url}`, made - 1); else unpaired.push(entry);
  };
  /** @type {(type: string, url: string) => void} */
  const made = (type, url) => {
    const at = unpaired.findIndex(e => e.type === type && e.url === url);
    if (at !== -1) unpaired.splice(at, 1); else madeUnpaired.set(`${type} ${url}`, (madeUnpaired.get(`${type} ${url}`) || 0) + 1);
  };
  // The log's own listener, added first, has its entry.
  p.on('request', req => { const entry = requestEntries.get(req); if (entry?.type === 'eventsource') reported(entry); });
  p.on('websocket', ws => {
    /** @type {RequestEntry} */
    const entry = { id: nextId(), t: Date.now(), method: 'GET', url: ws.url(), type: 'websocket', status: 'open', ms: null, response: null, navigation: false, messages: [], sent: 0, received: 0 };
    keep(log, entry);
    reported(entry);
    connectionEvents.emit('open', p, entry);
    ws.on('framesent', frame => keepMessage(p, entry, 'sent', frame.payload));
    ws.on('framereceived', frame => keepMessage(p, entry, 'received', frame.payload));
    ws.on('socketerror', error => { entry.status = `failed: ${error}`; });
    ws.on('close', () => endSocket(p, entry));
  });
  // requestId -> the entry of a connection opened before the REPL connected, or null for one Playwright
  // or the request log has.
  /** @type {Map<string, RequestEntry | null>} */
  const known = new Map();
  /** @type {Map<string, { way: 'sent' | 'received', payload: string | Buffer, t: number }[]>} */
  const held = new Map();
  /** @type {Map<string, string>} */
  const streamUrls = new Map();
  /** @type {WeakSet<RequestEntry>} */
  const claimed = new WeakSet();
  let enabledAt = Infinity;
  keptSession(p).then(async (/** @type {import('playwright-core').CDPSession} */ session) => {
    // One at a time, so two opened before cannot both take the one URL left.
    let lookups = Promise.resolve();
    /** @type {(type: string, kind: 'WebSocket' | 'EventSource') => RequestEntry} */
    const openedBefore = (type, kind) => {
      /** @type {RequestEntry} */
      const entry = { id: nextId(), t: Date.now(), method: 'GET', url: '', type, status: 'open', ms: null, response: null, navigation: false, messages: [], sent: 0, received: 0, before: true };
      keep(log, entry);
      connectionEvents.emit('open', p, entry);
      lookups = lookups.then(async () => {
        entry.url = await untrackedUrl(session, kind, log.filter(e => e.type === type && e !== entry && e.url && (e.status === 'open' || e.status === 'pending')));
      });
      return entry;
    };
    /** @type {(id: string, way: 'sent' | 'received', payload: string | Buffer) => void} */
    const frame = (id, way, payload) => {
      const entry = known.get(id);
      if (entry) { keepMessage(p, entry, way, payload); return; }
      if (entry === null) return;
      const waiting = held.get(id);
      if (waiting) { waiting.push({ way, payload, t: Date.now() }); return; }
      held.set(id, [{ way, payload, t: Date.now() }]);
      setTimeout(() => {
        const frames = /** @type {{ way: 'sent' | 'received', payload: string | Buffer, t: number }[]} */ (held.get(id));
        held.delete(id);
        const first = frames[0];
        const text = typeof first.payload === 'string' ? clipText(first.payload) : `[binary, ${first.payload.length} bytes]`;
        const match = matchRaceSocket(first.way, text, first.t, unpaired.filter(e => e.type === 'websocket' && !claimed.has(e)));
        if (match) { claimed.add(match); known.set(id, null); return; }
        const before = openedBefore('websocket', 'WebSocket');
        known.set(id, before);
        for (const f of frames) keepMessage(p, before, f.way, f.payload, f.t);
      }, RACE_MATCH).unref();
    };
    /** @type {(response: { opcode: number, payloadData: string }) => string | Buffer} */
    const payloadOf = response => (response.opcode === 2 ? Buffer.from(response.payloadData, 'base64') : response.payloadData);
    session.on('Network.webSocketCreated', (/** @type {any} */ e) => { known.set(e.requestId, null); made('websocket', e.url); });
    session.on('Network.webSocketFrameSent', (/** @type {any} */ e) => frame(e.requestId, 'sent', payloadOf(e.response)));
    session.on('Network.webSocketFrameReceived', (/** @type {any} */ e) => frame(e.requestId, 'received', payloadOf(e.response)));
    session.on('Network.webSocketFrameError', (/** @type {any} */ e) => { const entry = known.get(e.requestId); if (entry) entry.status = `failed: ${e.errorMessage}`; });
    session.on('Network.webSocketClosed', (/** @type {any} */ e) => { const entry = known.get(e.requestId); if (entry) endSocket(p, entry); });
    session.on('Network.requestWillBeSent', (/** @type {any} */ e) => {
      if (e.type !== 'EventSource') return;
      streamUrls.set(e.requestId, e.request.url);
      made('eventsource', e.request.url);
    });
    session.on('Network.eventSourceMessageReceived', (/** @type {any} */ e) => {
      let entry = known.get(e.requestId);
      if (!entry) {
        // Its entry is the request log's: the latest open stream to its URL not claimed by another. One
        // with no request seen began before our session's Network was on: as the REPL attached, a stream
        // the log has and our session saw no request for, or else one begun before the REPL connected.
        const url = streamUrls.get(e.requestId);
        const pending = log.filter(r => r.type === 'eventsource' && r.status === 'pending' && !claimed.has(r));
        entry = url ? pending.filter(r => r.url === url).pop() : pending.find(r => unpaired.includes(r) && r.t <= enabledAt + RACE_STREAM);
        if (entry) claimed.add(entry);
        else if (url) return;
        else entry = openedBefore('eventsource', 'EventSource');
        known.set(e.requestId, entry);
      }
      keepMessage(p, entry, 'received', e.eventName && e.eventName !== 'message' ? `[${e.eventName}] ${e.data}` : e.data);
    });
    if (!('networkEnabled' in tabState(p))) { await session.send('Network.enable'); tabState(p).networkEnabled = true; }
    enabledAt = Date.now();
  }).catch(() => {});
  return reported;
}

// opened: the tab opened while the REPL runs. One a link opens has started loading before the REPL
// sees it, so the requests it made till then are asked for and put in the log, its document among them.
/** @param {Page} p */
function ensureRecentLog(p, opened = false) {
  if ('log' in tabState(p)) return;
  /** @type {Log<RequestEntry>} */
  const log = [];
  /** @type {Log<ConsoleEntry>} */
  const logs = [];
  let nextId = 1;
  let newDocument = false;
  tabState(p).log = log;
  tabState(p).consoleLog = logs;
  const add = (/** @type {Request} */ req, /** @type {number} */ t) => {
    let navigation = false;
    try { navigation = req.isNavigationRequest() && req.frame() === p.mainFrame(); } catch {}
    const entry = { id: nextId++, t, method: req.method(), url: req.url(), type: req.resourceType(), status: 'pending', ms: null, response: null, navigation };
    if (navigation) newDocument = true;
    requestEntries.set(req, entry);
    keep(log, entry);
  };
  p.on('request', req => add(req, Date.now()));
  const reported = keepConnections(p, log, () => nextId++);
  if (opened) {
    p.requests().then(async earlier => {
      const missed = earlier.filter(req => !requestEntries.has(req));
      if (!missed.length) return;
      for (const req of missed) add(req, Math.round(req.timing().startTime));
      // A stream among them is Playwright's, made before our session's Network was on.
      for (const req of missed) { const entry = requestEntries.get(req); if (entry?.type === 'eventsource') reported(entry); }
      // Numbered in the order they were made, the missed ones first: this is moments after the tab opened.
      log.sort((a, b) => a.t - b.t);
      log.forEach((entry, i) => { entry.id = i + 1; });
      nextId = log.length + 1;
      // One that finished before the REPL saw it has no event to come.
      for (const req of missed) {
        const res = await req.response().catch(() => null);
        const entry = /** @type {RequestEntry} */ (requestEntries.get(req));
        if (!res || entry.status !== 'pending') continue;
        entry.status = statusOf(req, res);
        entry.ms = Math.max(0, Math.round(req.timing().responseEnd >= 0 ? req.timing().responseEnd : req.timing().responseStart));
        entry.response = res;
        keepBody(p, entry, res);
      }
    }).catch(() => {});
  }
  /** @type {(req: Request, status: string, response?: Response | null) => void} */
  const finish = (req, status, response = null) => {
    const entry = requestEntries.get(req);
    if (!entry) return;
    entry.status = status;
    entry.ms = Date.now() - entry.t;
    entry.response = response;
  };
  p.on('requestfinished', async req => {
    /** @type {Response | null} */
    let res = null;
    try { res = await req.response(); } catch {}
    finish(req, statusOf(req, res), res);
    keepBody(p, requestEntries.get(req), res);
  });
  p.on('requestfailed', async req => {
    // A page that never loaded: the app's next route change is not a load either.
    if (requestEntries.get(req)?.navigation) newDocument = false;
    const reason = req.failure()?.errorText || 'unknown';
    // Whatever its status says: wait load must know at once that this one will never load.
    const entry = requestEntries.get(req);
    if (entry) entry.failed = reason;
    // Chrome reports a response that has no body (204, 205, 304) as aborted once it has arrived: the
    // page got its answer. Any other answered one failed while its body came in, and says so.
    const res = await req.response().catch(() => null);
    if (res) {
      const status = statusOf(req, res);
      // An SSE stream aborted once answered was closed by the page (es.close(), or its page left): a server
      // ending it finishes it, and a network error has its own reason.
      const closed = entry?.type === 'eventsource' && reason === 'net::ERR_ABORTED';
      finish(req, [204, 205, 304].includes(res.status()) ? status : closed ? `${status}, closed` : `${status}, then failed: ${reason}`, res);
    } else {
      finish(req, `failed: ${reason}`);
    }
  });
  p.on('load', () => { tabState(p).loadedAt = Date.now(); });
  // A page load, marked among the messages it comes between; it ages out with them. Only a new
  // document counts: an app's own route change (pushState, a hash) navigates without loading.
  p.on('framenavigated', frame => {
    if (frame !== p.mainFrame() || !newDocument) return;
    newDocument = false;
    keep(logs, { t: Date.now(), type: 'load', text: frame.url() });
    // Leaving a page closes its sockets, its frames' and workers' too, with no close reported for them:
    // those opened before the new page was asked for.
    const navigation = log.filter(e => e.navigation).pop();
    for (const e of log) if ((e.type === 'websocket' || e.before) && navigation && e.t < navigation.t) endSocket(p, e);
  });
  p.on('console', msg => keep(logs, { t: Date.now(), type: msg.type(), text: clipText(consoleText(msg)) }));
  // Uncaught exceptions never reach the console event.
  p.on('pageerror', error => keep(logs, { t: Date.now(), type: 'pageerror', text: clipText(error.stack || error.message) }));
}

// A page that navigates as soon as a request answers (a login that redirects)
// takes the body with it before the request is even reported finished; told to
// in time, the browser keeps them outside the page instead. Once per tab, from
// its first watch, and never switched off: up to 50 MB of the browser's memory
// per watched tab, for as long as the REPL runs.
const DURABLE_TOTAL = 50 * 1024 * 1024;

/** @param {Page} p */
async function keepBodiesDurable(p) {
  if ('bodiesDurable' in tabState(p)) return;
  tabState(p).bodiesDurable = true;
  try {
    const session = await keptSession(p);
    await session.send('Network.configureDurableMessages', { maxTotalBufferSize: DURABLE_TOTAL, maxResourceBufferSize: KEPT_BODY_MAX });
  } catch {
    // An older Chrome: bodies are still kept once their requests finish.
  }
}

/**
 * @param {Page} p
 * @param {RequestEntry | undefined} entry
 * @param {Response | null} res
 */
async function keepBody(p, entry, res) {
  if (!entry || !res || !(tabState(p).watch?.on || 'watchStarting' in tabState(p)) || WATCH_HIDDEN_TYPES.has(entry.type)) return;
  const headers = res.headers();
  if (!TEXT_BODY.test(headers['content-type'] || '') || Number(headers['content-length']) > KEPT_BODY_MAX) return;
  try {
    const buffer = await res.body();
    if (buffer.length <= KEPT_BODY_MAX) entry.kept = buffer;
  } catch {}
}

// A pattern without * is a URL part; with * it is a glob (* within a path segment, ** across).
/**
 * @param {string} pattern
 * @returns {(url: string) => boolean}
 */
function urlMatcher(pattern) {
  if (!pattern.includes('*')) return url => url.includes(pattern);
  const source = pattern.split('**').map(chunk => chunk.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  const regex = new RegExp(`^${source}$`);
  return url => regex.test(url);
}

/** @param {RequestEntry} entry */
function printRequest(entry) {
  out.log(`#${entry.id} ${entry.method} ${entry.status} ${entry.url}`);
}

// Watches the recent log, which has every request from the moment it starts, so
// one that began or finished since the previous command (e.g. the click that
// caused it) is found rather than missed.
/**
 * @param {string} pattern
 * @param {number} timeout
 */
async function waitForRequest(pattern, timeout) {
  const matches = urlMatcher(pattern);
  const since = state.previousCommandAt || 0;
  const deadline = Date.now() + timeout;
  for (;;) {
    // Begun since the previous command, or finished since, or still going: one begun earlier (a
    // reload two commands ago) can still be the one waited for. A finished one first, so a request
    // that never ends (a long poll) does not hide one that has.
    const found = /** @type {Log<RequestEntry>} */ (tabState(state.page).log || []).filter(e => matches(e.url) && (e.t >= since || e.ms === null || e.t + e.ms >= since));
    const done = found.find(e => e.status !== 'pending');
    if (done) return printRequest(done);
    const entry = found[0];
    if (Date.now() >= deadline) throw new Error(`No response matching ${pattern} within ${timeout / 1000}s${entry ? ` (#${entry.id} is still pending)` : ''}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// The tab's connections, and their messages in the order they came, each with its connection.
/** @param {Log<RequestEntry>} log */
function connectionMessages(log) {
  const connections = log.filter(e => CONNECTION_TYPES.has(e.type));
  return connections.flatMap(entry => (entry.messages || []).map(message => ({ entry, message }))).sort((a, b) => a.message.t - b.message.t || a.message.seq - b.message.seq);
}

/** @param {{ entry: RequestEntry, message: Message }} item */
function messageLine({ entry, message }, withId = true) {
  return `${withId ? `#${entry.id} ` : ''}${clock(message.t)} ${message.way} ${message.text}`;
}

// A message sent or received since the previous command began, as wait request counts: on any of the
// tab's connections, containing text, or any with none.
/**
 * @param {string} text
 * @param {number} timeout
 */
async function waitForMessage(text, timeout) {
  const since = state.previousCommandAt || 0;
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = connectionMessages(tabState(state.page).log || []).find(({ message }) => message.t >= since && message.text.includes(text));
    if (found) { out.log(messageLine(found)); return; }
    if (Date.now() >= deadline) throw new Error(`No WebSocket or SSE message${text ? ` containing ${text}` : ''} within ${timeout / 1000}s`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// Why a navigation that failed did not load, from its request.
// Its status says why once the request log has it failed; until then (pending, or its code) the reason is added.
/** @param {RequestEntry} navigation */
function notLoaded(navigation) {
  const why = stayedPut(navigation) ? `${navigation.status} (no page to show, so the tab stays where it was)` : /^failed|, then failed: /.test(navigation.status) ? navigation.status : `${navigation.status}, then failed: ${navigation.failed}`;
  return `The page did not load: #${navigation.id} ${navigation.url} ${why}`;
}

// Answered with no page (204, 205): Chrome leaves the tab on the page it was on.
/** @param {RequestEntry} entry */
function stayedPut(entry) {
  return !!entry.failed && /^(?:204|205)\b/.test(entry.status);
}

// Done once the page has loaded: after the latest navigation of the tab that
// began since the previous command did (the click on a link, say), or, with
// none, the document there now. Waiting on Playwright's load state alone would
// see the page being left, which has already loaded.
/** @param {number} timeout */
async function waitForLoad(timeout) {
  const p = state.page;
  const since = state.previousCommandAt || 0;
  const deadline = Date.now() + timeout;
  for (;;) {
    const navigation = /** @type {Log<RequestEntry>} */ (tabState(p).log || []).filter(e => e.navigation && e.t >= since).pop();
    if (navigation?.failed && navigation.status !== 'pending') throw new Error(notLoaded(navigation));
    const loaded = navigation ? (tabState(p).loadedAt || 0) >= navigation.t : await p.evaluate(() => document.readyState === 'complete').catch(() => false);
    if (loaded && !navigation && (tabState(p).loadedAt || 0) < since) {
      // Nothing loaded since the previous command: a page that changes its URL itself (pushState) does not
      // load, and may not have changed it yet.
      out.log(`Loaded before the previous command, nothing since: ${p.url()} — ${await p.title().catch(() => '')}\n(A page that changes its own URL does not load: wait <selector> or wait text waits for its new view.)`);
      return;
    }
    if (loaded) { out.log(`Loaded: ${p.url()} — ${await p.title().catch(() => '')}`); return; }
    if (Date.now() >= deadline) throw new Error(`${p.url()} did not finish loading within ${timeout / 1000}s`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const commands = {
  /** @param {string} args */
  async requests(args) {
    // --regex <pattern> takes the rest of the line.
    /** @type {RegExp | null} */
    let regex = null;
    /** @type {string | null} */
    let regexArg = null;
    const text = (args || '').replace(/(?:^|\s)--regex(?:\s+([\s\S]*))?$/, (_, pattern) => {
      if (!pattern?.trim()) throw new Error('Usage: requests [--all] [n] --regex <pattern>');
      regexArg = pattern.trim();
      regex = regexOf(patternText(/** @type {string} */ (regexArg)));
      return '';
    });
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    const everything = tokens.includes('--all');
    if (everything) tokens.splice(tokens.indexOf('--all'), 1);
    let count = RECENT_DEFAULT;
    if (tokens.length && /^\d+$/.test(tokens[0])) count = Number(tokens.shift());
    if (count < 1 || count > RECENT_MAX || tokens.length > (regex ? 0 : 1)) throw new Error(`Usage: requests [--all] [n] [url-filter | --regex <pattern>] (n from 1 to ${RECENT_MAX})`);
    const filter = regex ? String(regex) : tokens[0];
    /** @type {(url: string) => boolean} */
    const wanted = regex ? url => /** @type {RegExp} */ (regex).test(url) : url => !filter || url.includes(filter);
    const log = /** @type {Log<RequestEntry>} */ (tabState(state.page).log || []);
    const shown = everything ? log : log.filter(e => !RECENT_HIDDEN_TYPES.has(e.type) && !e.url.startsWith('chrome-extension://'));
    const kept = shown.filter(e => wanted(e.url));
    const matches = kept.slice(-count);
    const cut = cutNote('requests', matches.length, kept.length, log.dropped, n => `requests${everything ? ' --all' : ''} ${n}${regex ? ` --regex ${regexArg}` : filter ? ` ${filter}` : ''}`);
    // First, so the list is not read as complete, and its last line is still the latest request.
    if (cut) out.log(cut);
    if (!matches.length) { out.log(filter ? `No requests matching ${filter}` : 'No requests on the selected tab'); return; }
    // Where each page load starts, as console marks it, so the requests of one load can be told
    // apart; from the load the first one shown came from, and whether or not the filter matches it.
    // Not one answered with no page: the tab stayed on the page it was on.
    const loads = log.filter(e => e.navigation && !stayedPut(e));
    let load = loads.filter(e => e.id <= matches[0].id).pop();
    for (const e of matches) {
      for (const next of loads.filter(n => (!load || n.id > load.id) && n.id <= e.id)) load = next;
      if (load && !load.marked) out.log(`${clock(load.t)} --- the page loads ${load.url}`);
      if (load) load.marked = true;
      const ms = e.ms === null ? '-' : `${e.ms}ms`;
      out.log(`#${e.id} ${clock(e.t)} ${e.method} ${e.status} ${ms} ${e.type} ${CONNECTION_TYPES.has(e.type) ? urlText(e) : e.url}${messageCounts(e)}`);
    }
    for (const e of loads) delete e.marked;
    // The numbers skip what is hidden; say so, or they look like requests went missing.
    const first = matches[0].id;
    const last = matches[matches.length - 1].id;
    // With a filter, the numbers skip what does not match too, so the count would mislead.
    const hidden = everything || filter ? 0 : log.filter(e => e.id > first && e.id < last && !shown.includes(e)).length;
    if (hidden) out.log(`(${hidden} hidden between these: images, fonts, stylesheets, media and extension requests; requests --all shows them)`);
  },

  /**
   * @param {string} args
   * @param {boolean} all
   */
  async body(args, all) {
    const arg = (args || '').trim();
    if (!arg) throw new Error('Usage: body <#> | body <url-part> (the number from requests, or the latest request whose URL contains url-part)');
    const log = /** @type {Log<RequestEntry>} */ (tabState(state.page).log || []);
    const match = /^#?(\d+)$/.exec(arg);
    // The latest that has finished: one still pending has no body yet.
    const entry = match ? log.find(e => e.id === Number(match[1])) : log.filter(e => e.url.includes(arg) && e.status !== 'pending').pop();
    if (!entry) throw new Error(match ? `No request #${match[1]} on the selected tab; requests lists them` : `No finished request on the selected tab has a URL containing ${arg}`);
    const id = entry.id;
    if (CONNECTION_TYPES.has(entry.type)) throw new Error(`#${id} is ${entry.type === 'websocket' ? 'a WebSocket' : 'a stream of server-sent events'}: messages #${id} shows its messages`);
    // A fake is marked answered before the browser hands over its response.
    for (let waited = 0; !entry.response && /(?:faked|patched)$/.test(entry.status) && waited < 2000; waited += 50) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!entry.response) throw new Error(`#${id} has no response${entry.status === 'pending' ? ' yet' : ` (${entry.status})`}`);
    let buffer = entry.kept;
    if (!buffer) {
      // Not withTimeout: its "timed out" error would disconnect the REPL, and
      // reading a body cannot have changed anything.
      let timer;
      /** @type {Promise<never>} */
      const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`did not arrive within ${BODY_TIMEOUT / 1000}s`)), BODY_TIMEOUT); });
      try { buffer = await Promise.race([entry.response.body(), late]); }
      // Playwright's reason ends in advice for its own API ("Read response.body() before..."), so only its first line is kept.
      catch (error) { throw new Error(`The body of #${id} is not available: ${String(error.message).split('\n')[0]} (the browser drops bodies, e.g. after the tab navigates; a watched tab keeps them as they arrive)`); }
      finally { clearTimeout(timer); }
    }
    const type = entry.response.headers()['content-type'] || '';
    out.log(`#${id} ${entry.method} ${entry.status} ${entry.url} (${type || 'no content type'}, ${buffer.length} bytes)`);
    if (!buffer.length) return;
    // With no content type, text is told by its bytes: an error page's "not found" often has none.
    if (!TEXT_BODY.test(type) && (type || !looksLikeText(buffer))) { out.log('[binary body not shown]'); return; }
    let text = buffer.toString('utf8');
    if (/json/.test(type)) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
    printOutput(text, all);
  },

  /**
   * @param {string} args
   * @param {boolean} all
   */
  async console(args, all) {
    const tokens = (args || '').trim().split(/\s+/).filter(Boolean);
    let count = RECENT_DEFAULT;
    if (tokens.length && /^\d+$/.test(tokens[0])) count = Number(tokens.shift());
    if (count < 1 || count > RECENT_MAX || tokens.length > 1) throw new Error(`Usage: console [n] [level | filter] (n from 1 to ${RECENT_MAX})`);
    const filter = tokens[0];
    const level = CONSOLE_LEVELS.indexOf(filter);
    /** @type {(e: ConsoleEntry) => boolean} */
    const shown = level === -1
      ? e => !filter || e.type.includes(filter) || e.text.includes(filter)
      : e => CONSOLE_LEVELS.indexOf(consoleLevel(e.type)) <= level;
    const logs = /** @type {Log<ConsoleEntry>} */ (tabState(state.page).consoleLog || []);
    const kept = logs.filter(e => e.type !== 'load' && shown(e));
    const matches = kept.slice(-count);
    const cut = cutNote('messages', matches.length, kept.length, logs.dropped, n => `console ${n}${filter ? ` ${filter}` : ''}`);
    if (cut) out.log(cut);
    if (!matches.length) { out.log(filter ? `No console messages matching ${filter}` : 'No console messages on the selected tab'); return; }
    // Where the page loaded again, so a message from an earlier load does not read as the current one's.
    // From the load the first message shown came from, if it is still kept.
    let first = logs.indexOf(matches[0]);
    while (first > 0 && logs[first].type !== 'load') first -= 1;
    const lines = logs.filter((e, i) => i >= first && (e.type === 'load' || matches.includes(e)));
    printOutput(lines.map(e => (e.type === 'load' ? `${clock(e.t)} --- the page loaded ${e.text}` : `${clock(e.t)} [${e.type}] ${e.text}`)).join('\n'), all);
  },

  /**
   * @param {string} args
   * @param {boolean} all
   */
  async messages(args, all) {
    const tokens = (args || '').trim().split(/\s+/).filter(Boolean);
    const log = /** @type {Log<RequestEntry>} */ (tabState(state.page).log || []);
    const connections = log.filter(e => CONNECTION_TYPES.has(e.type));
    /** @type {RequestEntry | undefined} */
    let entry;
    const byId = /^#(\d+)$/.exec(tokens[0] || '');
    if (byId) {
      entry = log.find(e => e.id === Number(byId[1]));
      if (!entry) throw new Error(`No request #${byId[1]} on the selected tab; requests lists them`);
      if (!CONNECTION_TYPES.has(entry.type)) throw new Error(`#${entry.id} is not a WebSocket or an SSE stream: body #${entry.id} shows what it got back`);
      tokens.shift();
    } else if (tokens.length && !/^\d+$/.test(tokens[0])) {
      // A part of a connection's URL picks it, the latest that matches; any other word is a filter.
      entry = connections.filter(e => e.url.includes(tokens[0])).pop();
      if (entry) tokens.shift();
    }
    let count = RECENT_DEFAULT;
    if (tokens.length && /^\d+$/.test(tokens[0])) count = Number(tokens.shift());
    // No upper limit: across connections, more than RECENT_MAX are kept.
    if (count < 1) throw new Error('Usage: messages [#<n> | <url-part>] [n] [filter] (n 1 or more)');
    const filter = tokens.join(' ');
    if (!connections.length) { out.log('No WebSockets or SSE streams on the selected tab (kept from when the REPL connects; reload for a page that opened one before)'); return; }
    const from = entry ? [entry] : connections;
    if (entry) out.log(`#${entry.id} ${entry.type} ${entry.status} ${urlText(entry)}${messageCounts(entry)}`);
    const kept = connectionMessages(from).filter(({ message }) => !filter || message.text.includes(filter));
    const matches = kept.slice(-count);
    const target = entry ? `#${entry.id} ` : '';
    const cut = cutNote('messages', matches.length, kept.length, from.some(e => e.messages?.dropped), () => `messages ${target}${kept.length}${filter ? ` ${filter}` : ''}`, `the last ${RECENT_MAX} per connection, and ${MESSAGES_TOTAL / 1024 / 1024} MB per tab,`);
    if (cut) out.log(cut);
    if (!matches.length) { out.log(filter ? `No messages containing ${filter}` : entry ? `No messages on #${entry.id}` : 'No messages on the selected tab\'s WebSockets or SSE streams'); return; }
    printOutput(matches.map(item => messageLine(item, !entry)).join('\n'), all);
  },
};

module.exports = { commands, matchRaceSocket, urlText, markChanged, RECENT_DEFAULT, RECENT_HIDDEN_TYPES, WATCH_HIDDEN_TYPES, CONNECTION_TYPES, requestEntries, connectionEvents, consoleText, keep, ensureRecentLog, keepBodiesDurable, waitForRequest, waitForMessage, notLoaded, stayedPut, waitForLoad };
