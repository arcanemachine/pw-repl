// A tab's WebSockets: closing them from the page's side, and routing them (Playwright's routeWebSocket) to
// fake their server, send the page a message as if from it, or drop the connection.
const { state } = require('./state');
const out = require('./output');
const { unquote, splitSelector } = require('./syntax');
const { hints } = require('./util');
const { tabState } = require('./tabstate');
const { keptSession } = require('./cdp');
const { connectionEvents, keepMessage, endSocket, fakedSocket } = require('./requestlog');

/**
 * @typedef {import('playwright-core').Page} Page
 * @typedef {import('playwright-core').WebSocketRoute} WebSocketRoute
 * @typedef {import('./requestlog').RequestEntry} RequestEntry
 * @typedef {{ ws: WebSocketRoute, server: WebSocketRoute | null, url: string, entry: RequestEntry | null,
 *   closed: boolean, dropping: boolean }} RoutedSocket
 */

// websocket close: the code and reason the page's own close() is called with. 4000 is the first a page may
// use (1000 is a normal close; 1006, a dropped connection, only the browser can give).
const CLOSE_CODE = 4000;
const CLOSE_REASON = 'closed by pw-repl';

// Closes the page's open WebSockets whose URL contains part (all, with none), from the page's side: the
// network cannot be cut for one socket (network off holds an open one, it does not close it), and the
// page holds no list of its sockets, so they are found in its heap, in the main frame's JavaScript world.
/**
 * @param {Page} p
 * @param {string} part
 * @returns {Promise<number>}
 */
async function closeWebSockets(p, part) {
  const session = await keptSession(p);
  const objectGroup = 'pw-repl-websocket-close';
  try {
    const proto = await session.send('Runtime.evaluate', { expression: 'WebSocket.prototype', objectGroup });
    const found = await session.send('Runtime.queryObjects', { prototypeObjectId: /** @type {string} */ (proto.result.objectId), objectGroup });
    const closed = await session.send('Runtime.callFunctionOn', {
      objectId: /** @type {string} */ (found.objects.objectId),
      functionDeclaration: `function (part, code, reason) {
        const open = this.filter(ws => ws.readyState < WebSocket.CLOSING && ws.url.includes(part));
        for (const ws of open) ws.close(code, reason);
        return open.length;
      }`,
      arguments: [{ value: part }, { value: CLOSE_CODE }, { value: CLOSE_REASON }],
      returnByValue: true,
    });
    return closed.result.value;
  } finally {
    await session.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
  }
}

/** @param {Page} p */
function wsRoutesFor(p) {
  if (!('wsRoutes' in tabState(p))) tabState(p).wsRoutes = new Map();
  return /** @type {Map<string, { fake: boolean, owner: string | null }>} */ (tabState(p).wsRoutes);
}

/** @param {Page} p */
function socketsOf(p) {
  return /** @type {RoutedSocket[]} */ (tabState(p).wsSockets ||= []);
}

/** @param {RoutedSocket} socket */
function isOpen(socket) {
  // Leaving the page ends its entry, with no close reported to the route.
  return !socket.closed && (!socket.entry || socket.entry.ms === null);
}

// A socket routed through to its server is still made by the page, so CDP reports it, and the request
// log gives it an entry: it is the routed one to its URL waiting longest for its entry.
connectionEvents.on('open', (/** @type {Page} */ p, /** @type {RequestEntry} */ entry) => {
  if (entry.type !== 'websocket' || entry.before || entry.routed) return;
  const socket = (tabState(p).wsSockets || []).find((/** @type {RoutedSocket} */ s) => s.server && !s.entry && s.url === entry.url);
  if (!socket) return;
  socket.entry = entry;
  entry.routed = 'routed through pw-repl';
  out.notice(`Routed: #${entry.id} ${entry.url}`, p);
});

// Playwright takes no WebSocket route back (it has no unrouteWebSocket), so each glob is routed once
// and its handler reads the table: a glob routed off passes its sockets through, as an unrouted page's.
/**
 * @param {Page} p
 * @param {string} glob
 */
async function routeGlob(p, glob) {
  const routed = /** @type {Set<string>} */ (tabState(p).wsRouted ||= new Set());
  if (routed.has(glob)) return;
  routed.add(glob);
  await p.routeWebSocket(glob, ws => {
    const route = wsRoutesFor(p).get(glob);
    if (!route) { ws.connectToServer(); return; }
    /** @type {RoutedSocket} */
    const socket = { ws, server: null, url: ws.url(), entry: null, closed: false, dropping: false };
    socketsOf(p).push(socket);
    if (route.fake) {
      const entry = socket.entry = fakedSocket(p, socket.url);
      ws.onMessage(message => keepMessage(p, entry, 'sent', message));
      out.notice(`Faked: #${entry.id} ${socket.url}`, p);
    } else {
      socket.server = ws.connectToServer();
    }
    // Set, so a drop's 1006 is not passed on to the server's socket, which takes no such code. A close
    // then comes back here from the side it reached: socket.closed has it end once.
    ws.onClose((code, reason) => {
      if (socket.closed) return;
      socket.closed = true;
      const sockets = socketsOf(p);
      if (sockets.includes(socket)) sockets.splice(sockets.indexOf(socket), 1);
      if (socket.server) socket.server.close(socket.dropping ? {} : { code, reason }).catch(() => {});
      else {
        if (!socket.dropping) ws.close({ code, reason }).catch(() => {});
        if (socket.entry) endSocket(p, socket.entry);
      }
    });
  });
}

// Whether the page's document has Playwright's stand-in for WebSocket, put in by a route when a page loads:
// with it, a new route reaches the sockets the page opens next; without it, only after a reload.
/** @param {Page} p */
async function standInLoaded(p) {
  return p.evaluate(() => typeof (/** @type {any} */ (globalThis).__pwWebSocketDispatch) === 'function').catch(() => false);
}

/** @param {Page} p */
async function reachText(p) {
  return await standInLoaded(p) ? 'it reaches the sockets the page opens from now on' : 'reload: it reaches only pages loaded from now on';
}

const ROUTE_USAGE = 'Usage: websocket route [<url-glob> [fake] | off <url-glob>|--all]';

/** @param {string} args */
async function routeCommand(args) {
  const p = /** @type {Page} */ (state.page);
  const routes = wsRoutesFor(p);
  if (!args) {
    const forms = [
      ['websocket route <url-glob>', 'route its sockets through to their server, to send or drop'],
      ['websocket route <url-glob> fake', 'fake their server: no connection is made'],
    ];
    if (!routes.size) { out.log('No WebSocket routes on the selected tab.'); out.log(hints(forms)); return; }
    out.log(`WebSocket routes on the selected tab (${routes.size}):`);
    const width = Math.max(...[...routes.keys()].map(glob => glob.length));
    for (const [glob, route] of routes) out.log(`  ${glob.padEnd(width)}  ${route.fake ? 'fake' : 'through to its server'}`);
    out.log(hints([...forms, ['websocket route off <url-glob> | --all', 'remove']]));
    return;
  }
  const off = /^off(?:\s+(\S+))?$/.exec(args);
  if (off) {
    const glob = off[1] && unquote(off[1]);
    if (!glob) throw new Error('Usage: websocket route off <url-glob> | websocket route off --all');
    if (glob !== '--all' && !routes.has(glob)) throw new Error(`No WebSocket route for ${glob} on the selected tab`);
    const removed = removeWsRoutes(p, glob === '--all' ? [...routes.keys()] : [glob]);
    if (!removed.length) { out.log('No WebSocket routes on the selected tab'); return; }
    for (const g of removed) out.log(`Removed: ${g}`);
    out.log('Sockets open already stay as they are; a reload gives the page its own WebSocket back.');
    return;
  }
  const parsed = splitSelector(args);
  const fake = parsed?.rest === 'fake';
  if (!parsed || (parsed.rest && !fake)) throw new Error(ROUTE_USAGE);
  const glob = parsed.word;
  const previous = routes.get(glob);
  await routeGlob(p, glob);
  routes.set(glob, { fake, owner: state.client });
  out.log(`${previous ? 'Replaced' : 'Routed'}: ${glob} -> ${fake ? 'fake' : 'through to its server'} (${await reachText(p)})`);
}

/**
 * @param {Page} p
 * @param {string[]} globs
 */
function removeWsRoutes(p, globs) {
  for (const g of globs) wsRoutesFor(p).delete(g);
  return globs;
}

// The open sockets websocket route holds that target names: #<n>, a part of their URL, or all of them.
/**
 * @param {Page} p
 * @param {string} target
 * @param {string} command
 */
function routedSockets(p, target, command) {
  const open = socketsOf(p).filter(isOpen);
  const byId = /^#(\d+)$/.exec(target);
  const picked = byId ? open.filter(s => s.entry?.id === Number(byId[1])) : open.filter(s => s.url.includes(target));
  if (picked.length) return picked;
  const what = byId ? ` #${byId[1]}` : target ? ` whose URL contains ${target}` : '';
  const routed = wsRoutesFor(p).size;
  throw new Error(`No open routed WebSocket${what} on the selected tab: ${command} reaches only sockets websocket route holds${routed ? ' (a page loaded before the route is not routed: reload)' : ' (websocket route <url-glob>, then reload)'}`);
}

// A target word when it is #<n> or part of an open routed socket's URL; anything else begins the message.
/**
 * @param {Page} p
 * @param {string} line
 */
function splitTarget(p, line) {
  const [first = '', rest = ''] = /^(\S*)\s*([\s\S]*)$/.exec(line)?.slice(1) || [];
  if (/^#\d+$/.test(first) || (rest && socketsOf(p).some(s => isOpen(s) && s.url.includes(first)))) return { target: first, message: rest };
  return { target: '', message: line };
}

/** @param {string} args */
async function sendCommand(args) {
  const p = /** @type {Page} */ (state.page);
  const { target, message } = splitTarget(p, args);
  if (!message) throw new Error('Usage: websocket send [#<n>|url-part] <message>');
  const sockets = routedSockets(p, target, 'websocket send');
  if (sockets.length > 1) throw new Error(`${sockets.length} open routed WebSockets${target ? ` match ${target}` : ''}: name one by its number in requests (${sockets.map(s => s.entry ? `#${s.entry.id}` : s.url).join(', ')})`);
  const [socket] = sockets;
  socket.ws.send(message);
  if (socket.entry) keepMessage(p, socket.entry, 'received', message, Date.now(), true);
  out.log(`Sent to the page on ${socket.entry ? `#${socket.entry.id} ` : ''}${socket.url}, as if from its server`);
}

/** @param {string} args */
async function dropCommand(args) {
  const p = /** @type {Page} */ (state.page);
  if (/\s/.test(args)) throw new Error('Usage: websocket drop [#<n>|url-part]');
  const sockets = routedSockets(p, args, 'websocket drop');
  for (const socket of sockets) {
    socket.dropping = true;
    // Playwright's close() always says wasClean true; a dropped connection is not clean.
    await /** @type {any} */ (socket.ws)._channel.closePage({ code: 1006, reason: '', wasClean: false });
  }
  const names = sockets.map(s => (s.entry ? `#${s.entry.id} ${s.url}` : s.url)).join(', ');
  out.log(`Dropped ${sockets.length === 1 ? names : `${sockets.length} WebSockets: ${names}`}: the page sees an unclean close (code 1006)`);
}

const commands = {
  /** @param {string} args */
  async websocket(args) {
    const [, sub = '', rest = ''] = /^(\S*)\s*([\s\S]*)$/.exec((args || '').trim()) || [];
    if (sub === 'route') return routeCommand(rest.trim());
    if (sub === 'send') return sendCommand(rest);
    if (sub === 'drop') return dropCommand(rest.trim());
    if (sub !== 'close' || /\s/.test(rest.trim())) throw new Error('Usage: websocket close [#<n> | url-part] | websocket route [<url-glob> [fake]] | websocket send [#<n>|url-part] <message> | websocket drop [#<n>|url-part]');
    let part = rest.trim();
    const byId = /^#(\d+)$/.exec(part);
    if (byId) {
      const entry = /** @type {RequestEntry[]} */ (tabState(state.page).log || []).find(e => e.id === Number(byId[1]));
      if (entry?.type !== 'websocket') throw new Error(`#${byId[1]} is not a WebSocket on the selected tab; requests lists them`);
      if (!entry.url) throw new Error(`#${entry.id} was opened before the REPL connected, and its URL is unknown: websocket close closes every open WebSocket, and websocket close <url-part> those whose URL contains it`);
      // It cannot be told apart from another to its URL, so one closed already would close the page's next.
      if (entry.status !== 'open') throw new Error(`#${entry.id} is ${entry.status} already; websocket close ${entry.url} closes the page's open ones to its URL`);
      part = entry.url;
    }
    const count = await closeWebSockets(/** @type {Page} */ (state.page), part);
    const what = byId ? ` to ${part}` : part ? ` whose URL contains ${part}` : '';
    if (!count) { out.log(`No open WebSockets${what} on the selected tab`); return; }
    out.log(`Closed ${count} open WebSocket${count === 1 ? '' : 's'}${what}, from the page's side (code ${CLOSE_CODE}, "${CLOSE_REASON}")`);
  },
};

module.exports = { commands, wsRoutesFor, removeWsRoutes };
