// Routes: faking, patching, delaying, failing, rewriting or redirecting a tab's requests.
const { state } = require('./state');
const out = require('./output');
const { unquote, splitSelector } = require('./syntax');
const { hints, parseDuration, durationText } = require('./util');
const { tabState } = require('./tabstate');
const { markChanged, requestEntries } = require('./requestlog');

/**
 * @typedef {import('playwright-core').Page} Page
 * @typedef {{ text: string, matcher?: RegExp, handle: (r: import('playwright-core').Route,
 *   req: import('playwright-core').Request, tag: () => string, notice: (text: string) => void) => Promise<void> }} RouteKind
 */

// Playwright routes are registered per page, so the listing is too.
const ROUTE_PREVIEW = 80;

/** @param {Page} p */
function routesFor(p) {
  if (!('routes' in tabState(p))) tabState(p).routes = new Map();
  return tabState(p).routes;
}


// A JSON Merge Patch (RFC 7386): objects merge, null removes a key, anything else replaces.
/**
 * @param {any} target
 * @param {any} patch
 * @returns {any}
 */
function mergePatch(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  /** @type {Record<string, any>} */
  const result = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

/**
 * @param {string} text
 * @param {string} what
 */
function parseJson(text, what) {
  try { return JSON.parse(text); } catch (error) { throw new Error(`${what} is not valid JSON: ${error.message}`); }
}

const REGEX_SPECIAL = new Set(['$', '^', '+', '.', '*', '(', ')', '|', '\\', '?', '{', '}', '[', ']']);

// Playwright's glob as a RegExp (its globToRegexPattern, playwright-core 1.63, Apache-2.0), with its one
// ** the only capturing group, so a rewrite or redirect can put what ** matched in its URL. Playwright
// is handed this RegExp, so what is routed and what is captured cannot differ.
/** @param {string} glob */
function globCapture(glob) {
  const tokens = ['^'];
  let inGroup = false;
  for (let i = 0; i < glob.length; ++i) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) {
      const char = glob[++i];
      tokens.push(REGEX_SPECIAL.has(char) ? `\\${char}` : char);
      continue;
    }
    if (c === '*') {
      const charBefore = glob[i - 1];
      let starCount = 1;
      while (glob[i + 1] === '*') { starCount++; i++; }
      if (starCount > 1) {
        if (glob[i + 1] === '/') {
          tokens.push(charBefore === '/' ? '((?:.+/)|)' : '(.*/)');
          ++i;
        } else {
          tokens.push('(.*)');
        }
      } else {
        tokens.push('(?:[^/]*)');
      }
      continue;
    }
    if (c === '{') {
      if (inGroup) throw new Error(`Invalid glob ${glob}: nested '{' is not supported`);
      inGroup = true;
      tokens.push('(?:');
    } else if (c === '}') {
      if (!inGroup) throw new Error(`Invalid glob ${glob}: unmatched '}'`);
      inGroup = false;
      tokens.push(')');
    } else if (c === ',') {
      tokens.push(inGroup ? '|' : '\\,');
    } else {
      tokens.push(REGEX_SPECIAL.has(c) ? `\\${c}` : c);
    }
  }
  if (inGroup) throw new Error(`Invalid glob ${glob}: unmatched '{'`);
  tokens.push('$');
  return new RegExp(tokens.join(''));
}

// Where a rewrite or redirect sends a request: its target, with what the glob's ** matched in place of
// the target's **, resolved against the request's URL, so /login works as a Location does.
/**
 * @param {string} glob
 * @param {string} target
 * @returns {{ matcher?: RegExp, to: (url: string) => string }}
 */
function destination(glob, target) {
  const stars = (/** @type {string} */ text) => (text.match(/\*\*/g) || []).length;
  if (!stars(target)) return { to: url => new URL(target, url).href };
  if (stars(glob) !== 1) throw new Error(`A ** in the URL takes what the glob's ** matched, so the glob needs exactly one: route https://host/old/** rewrite https://host/new/**`);
  if (stars(target) !== 1) throw new Error('The URL may have only one **');
  // The glob's **/ matches its slash too, so the URL's ** stands for **/ there.
  const slash = /\*\*\//.test(glob.replace(/\\./g, ''));
  if (slash && !target.includes('**/')) throw new Error(`The glob's ** is followed by a /, so the URL's must be too: **/`);
  const matcher = globCapture(glob);
  return {
    matcher,
    to: url => {
      const found = matcher.exec(url);
      if (!found) throw new Error(`${url} does not match ${glob}`);
      return new URL(target.replace(slash ? '**/' : '**', () => found[1]), url).href;
    },
  };
}

// How a route treats the requests it matches: its text for listing, and what it does to each one.
/**
 * @param {string} glob
 * @param {string} how
 * @param {string | undefined} rest
 * @param {string} usage
 * @returns {RouteKind}
 */
function routeKind(glob, how, rest, usage) {
  if (/^\d{3}$/.test(how)) {
    const status = Number(how);
    if (status < 200 || status > 599) throw new Error('Status must be from 200 to 599');
    // JSON unless its type is given, so a typo in the JSON is not served as text.
    const typed = /^--content-type=("(?:[^"\\]|\\.)*"|'[^']*'|\S+)(?:\s+([\s\S]*))?$/.exec(rest || '');
    const body = typed ? typed[2] || '' : rest || '';
    if (!typed && body) {
      try { JSON.parse(body); } catch (error) {
        throw new Error(`Body is not valid JSON: ${error.message}; for another kind, give its type: route <url-glob> <status> --content-type=text/plain <body>`);
      }
    }
    // Quoted when it has a parameter: --content-type="text/html; charset=utf-8".
    const contentType = typed ? unquote(typed[1]) : body ? 'application/json' : undefined;
    const preview = body.length > ROUTE_PREVIEW ? `${body.slice(0, ROUTE_PREVIEW)}…` : body;
    return {
      text: `${status}${typed ? ` (${contentType})` : ''}${preview ? ` ${preview}` : ''}`,
      async handle(r, req, tag, notice) {
        markChanged(req, status, 'faked');
        await r.fulfill({ status, contentType, body });
        notice(`Faked: ${tag()} -> ${status}`);
      },
    };
  }
  if (how === 'patch') {
    if (!rest) throw new Error(usage);
    // Anything but an object replaces the whole body, as RFC 7386 has it: the way to change an array.
    const patch = parseJson(rest, 'Patch');
    return {
      text: `patch ${rest.length > ROUTE_PREVIEW ? `${rest.slice(0, ROUTE_PREVIEW)}…` : rest}`,
      async handle(r, req, tag, notice) {
        const response = await r.fetch();
        let body;
        try { body = await response.json(); } catch {
          await r.fulfill({ response });
          notice(`Not patched: ${tag()} — its response is not JSON, so it went through unchanged`);
          return;
        }
        markChanged(req, response.status(), 'patched');
        await r.fulfill({ response, json: mergePatch(body, patch) });
        notice(`Patched: ${tag()} -> ${response.status()}`);
      },
    };
  }
  if (how === 'delay') {
    const ms = parseDuration(rest);
    if (!ms) throw new Error('Usage: route <url-glob> delay <time> (ms, or 3s)');
    return {
      text: `delay ${durationText(ms)}`,
      async handle(r, req, tag, notice) {
        await new Promise(resolve => setTimeout(resolve, ms));
        await r.continue();
        notice(`Delayed ${durationText(ms)}: ${tag()}`);
      },
    };
  }
  if (how === 'rewrite') {
    const target = /^(\S+)$/.exec(rest || '')?.[1];
    if (!target) throw new Error('Usage: route <url-glob> rewrite <url>');
    const { matcher, to } = destination(glob, unquote(target));
    return {
      text: `rewrite ${unquote(target)}`,
      matcher,
      async handle(r, req, tag, notice) {
        const url = to(req.url());
        // Playwright's continue keeps the protocol; to another (https to http://localhost), the REPL
        // fetches it, and the page gets that answer, a redirect included.
        if (new URL(url).protocol === new URL(req.url()).protocol) {
          markChanged(req, null, 'rewritten');
          await r.continue({ url });
        } else {
          const response = await r.fetch({ url, maxRedirects: 0 });
          markChanged(req, response.status(), 'rewritten');
          await r.fulfill({ response });
        }
        notice(`Rewritten: ${tag()} -> ${url}`);
      },
    };
  }
  if (how === 'redirect') {
    const words = /^(\S+)(?:\s+(\d{3}))?$/.exec(rest || '');
    if (!words) throw new Error('Usage: route <url-glob> redirect <url> [301|302|303|307|308]');
    const status = Number(words[2] || 302);
    if (![301, 302, 303, 307, 308].includes(status)) throw new Error('A redirect\'s status is 301, 302, 303, 307 or 308');
    const { matcher, to } = destination(glob, unquote(words[1]));
    return {
      text: `redirect ${status} ${unquote(words[1])}`,
      matcher,
      async handle(r, req, tag, notice) {
        const url = to(req.url());
        markChanged(req, status, 'redirected');
        await r.fulfill({ status, headers: { location: url } });
        notice(`Redirected: ${tag()} -> ${status} ${url}`);
      },
    };
  }
  if (how === 'abort' && !rest) {
    return {
      text: 'abort',
      async handle(r, req, tag, notice) {
        await r.abort('failed');
        notice(`Aborted: ${tag()}`);
      },
    };
  }
  throw new Error(usage);
}

function listRoutes() {
  const routes = routesFor(state.page);
  const forms = [
    ['route <url-glob> <status> [json-body]', 'answer it with this status and JSON'],
    ['route <url-glob> <status> --content-type=<type> <body>', 'or with a body of another type'],
    ['route <url-glob> patch <json>', 'let it through, then change its JSON'],
    ['route <url-glob> delay <time>', 'hold it, then let it through'],
    ['route <url-glob> abort', 'fail it as if the connection broke'],
    ['route <url-glob> rewrite <url>', 'send it to another URL, unseen by the page'],
    ['route <url-glob> redirect <url> [status]', 'answer it with a redirect'],
  ];
  if (!routes.size) {
    out.log('No routes on the selected tab.');
    out.log(hints(forms));
    return;
  }
  out.log(`Routes on the selected tab (${routes.size}):`);
  const width = Math.max(...[...routes.keys()].map(glob => glob.length));
  for (const [glob, { text }] of routes) out.log(`  ${glob.padEnd(width)}  ${text}`);
  out.log(hints([...forms, ['route off <url-glob> | route off --all', 'remove']]));
}

/** @param {string | undefined} glob */
async function removeRoutes(glob) {
  if (!glob) throw new Error('Usage: route off <url-glob> | route off --all');
  const routes = routesFor(state.page);
  if (glob !== '--all' && !routes.has(glob)) throw new Error(`No route for ${glob} on the selected tab`);
  const removed = await unroute(state.page, glob === '--all' ? [...routes.keys()] : [glob]);
  for (const g of removed) out.log(`Removed: ${g}`);
  if (!removed.length) out.log('No routes on the selected tab');
}

/**
 * @param {Page} p
 * @param {string[]} globs
 */
async function unroute(p, globs) {
  const routes = routesFor(p);
  for (const g of globs) {
    await p.unroute(routes.get(g).matcher || g, routes.get(g).handler);
    routes.delete(g);
  }
  return globs;
}

const commands = {
  // Fulfilled inside the browser, so the page's own code handles the fake
  // exactly as a real response and the request never reaches the network.
  /** @param {string} args */
  async route(args) {
    const trimmed = (args || '').trim();
    if (!trimmed) return listRoutes();
    // A glob may be quoted, as it is in a shell.
    const off = /^off(?:\s+(\S+))?$/.exec(trimmed);
    if (off) return removeRoutes(off[1] && unquote(off[1]));
    const usage = 'Usage: route <url-glob> <status> [json-body] | route <url-glob> patch <json> | route <url-glob> delay <time> | route <url-glob> abort | route <url-glob> rewrite <url> | route <url-glob> redirect <url> [status] | route off <url-glob>|--all';
    const parsed = splitSelector(trimmed);
    const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(parsed?.rest || '');
    if (!match) throw new Error(usage);
    const glob = /** @type {NonNullable<typeof parsed>} */ (parsed).word;
    const [, how, rest] = match;
    const route = routeKind(glob, how, rest, usage);
    const routes = routesFor(state.page);
    const previous = routes.get(glob);
    if (previous) await state.page.unroute(previous.matcher || glob, previous.handler);
    const page = state.page;
    const notice = (/** @type {string} */ text) => out.notice(text, page);
    const handler = async (/** @type {import('playwright-core').Route} */ r) => {
      const req = r.request();
      // Taken now: a rewrite changes req.url() to where it sent the request.
      const url = req.url();
      const tag = () => { const id = requestEntries.get(req)?.id; return `${id ? `#${id} ` : ''}${req.method()} ${url}`; };
      try {
        await route.handle(r, req, tag, notice);
      } catch (error) {
        // Aborted, never continued: a request meant to be changed must not reach the page as it was.
        await r.abort().catch(() => {});
        notice(`Route failed: ${tag()} — ${error.message}; the request was aborted`);
      }
    };
    await state.page.route(route.matcher || glob, handler);
    routes.set(glob, { text: route.text, matcher: route.matcher, handler, owner: state.client });
    out.log(`${previous ? 'Replaced' : 'Routed'}: ${glob} -> ${route.text}`);
  },
};

module.exports = { commands, routesFor, unroute };
