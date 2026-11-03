// Cutting or slowing a tab's network.
const { state } = require('./state');
const out = require('./output');
const { hints } = require('./util');
const { tabState } = require('./tabstate');
const { keptSession } = require('./cdp');

/** @typedef {{ offline?: boolean, latency?: number, down?: number, up?: number }} NetworkSetting */

// DevTools' "Slow 4G".
const SLOW_DEFAULT = { latency: 563, down: 1440, up: 675 };
const SLOW_LATENCY_MAX = 10000;

// setting null restores the network.
/**
 * @param {import('playwright-core').Page} p
 * @param {NetworkSetting | null} setting
 */
async function setNetwork(p, setting) {
  const session = await keptSession(p);
  if (!('networkEnabled' in tabState(p))) { await session.send('Network.enable'); tabState(p).networkEnabled = true; }
  await session.send('Network.emulateNetworkConditions', {
    offline: !!setting?.offline,
    latency: setting?.latency || 0,
    // kbps to bytes per second; -1 is no limit.
    downloadThroughput: setting?.down ? setting.down * 125 : -1,
    uploadThroughput: setting?.up ? setting.up * 125 : -1,
  });
  if (setting) tabState(p).network = { ...setting, owner: state.client }; else delete tabState(p).network;
}

/** @param {NetworkSetting} setting */
function networkText(setting) {
  return setting.offline ? 'off (offline)' : `slow (${setting.latency}ms latency, ${setting.down} kbps down, ${setting.up} kbps up)`;
}

// websocket close: the code and reason the page's own close() is called with. 4000 is the first a page may
// use (1000 is a normal close; 1006, a dropped connection, only the browser can give).
const CLOSE_CODE = 4000;
const CLOSE_REASON = 'closed by pw-repl';

// Closes the page's open WebSockets whose URL contains part (all, with none), from the page's side: the
// network cannot be cut for one socket (network off holds an open one, it does not close it), and the
// page holds no list of its sockets, so they are found in its heap, in the main frame's JavaScript world.
/**
 * @param {import('playwright-core').Page} p
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

const commands = {
  // A stopped upstream does not reach the browser as a failure: the dev proxy
  // holds the request open instead of refusing it. Cutting the connection at
  // the browser is what a visitor's wifi or VPN dropping looks like to the page.
  /** @param {string} args */
  async network(args) {
    const words = (args || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const setting = tabState(state.page).network;
    if (!words.length) {
      out.log(`The selected tab's network is ${setting ? networkText(setting) : 'on'}.`);
      if (setting) out.log(hints([['network on', 'restore it']]));
      else out.log(hints([['network off', 'cut it, like dropped wifi'], ['network slow [<ms> [<kbps>]]', `slow it (default ${networkText(SLOW_DEFAULT).slice(6, -1)})`]]));
      return;
    }
    const [how, ...rest] = words;
    if ((how === 'on' || how === 'off') && !rest.length) {
      await setNetwork(state.page, how === 'on' ? null : { offline: true });
      out.log(`The selected tab's network is ${how}`);
      return;
    }
    const usage = `Usage: network [on | off | slow [<latency-ms> [<kbps>]]] (latency up to ${SLOW_LATENCY_MAX}ms)`;
    if (how !== 'slow' || rest.length > 2 || !rest.every(w => /^\d+$/.test(w))) throw new Error(usage);
    const [latency, kbps] = rest.map(Number);
    if (latency > SLOW_LATENCY_MAX || kbps === 0) throw new Error(usage);
    const slow = rest.length ? { latency, down: kbps || SLOW_DEFAULT.down, up: kbps || SLOW_DEFAULT.up } : SLOW_DEFAULT;
    await setNetwork(state.page, slow);
    out.log(`The selected tab's network is ${networkText(slow)}`);
  },

  /** @param {string} args */
  async websocket(args) {
    const [sub, ...rest] = (args || '').trim().split(/\s+/).filter(Boolean);
    if (sub !== 'close' || rest.length > 1) throw new Error('Usage: websocket close [#<n> | url-part]');
    let part = rest[0] || '';
    const byId = /^#(\d+)$/.exec(part);
    if (byId) {
      const entry = /** @type {import('./requestlog').RequestEntry[]} */ (tabState(state.page).log || []).find(e => e.id === Number(byId[1]));
      if (entry?.type !== 'websocket') throw new Error(`#${byId[1]} is not a WebSocket on the selected tab; requests lists them`);
      if (!entry.url) throw new Error(`#${entry.id} was opened before the REPL connected, and its URL is unknown: websocket close closes every open WebSocket, and websocket close <url-part> those whose URL contains it`);
      // It cannot be told apart from another to its URL, so one closed already would close the page's next.
      if (entry.status !== 'open') throw new Error(`#${entry.id} is ${entry.status} already; websocket close ${entry.url} closes the page's open ones to its URL`);
      part = entry.url;
    }
    const count = await closeWebSockets(state.page, part);
    const what = byId ? ` to ${part}` : part ? ` whose URL contains ${part}` : '';
    if (!count) { out.log(`No open WebSockets${what} on the selected tab`); return; }
    out.log(`Closed ${count} open WebSocket${count === 1 ? '' : 's'}${what}, from the page's side (code ${CLOSE_CODE}, "${CLOSE_REASON}")`);
  },
};

module.exports = { commands, setNetwork };
