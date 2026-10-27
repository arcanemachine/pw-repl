// Emulating a phone, a color scheme and other media features, a locale or a timezone in a tab, and its viewport.
const { state, onShutdown } = require('./state');
const out = require('./output');
const { devices } = require('playwright-core');
const { hints } = require('./util');
const { tabState } = require('./tabstate');
const { keptSession } = require('./cdp');

/**
 * @typedef {import('playwright-core').Page} Page
 * @typedef {import('playwright-core').CDPSession} CDPSession
 * @typedef {{ device?: string, scheme?: string, motion?: string, colors?: string, contrast?: string, media?: string, locale?: string, timezone?: string }} Emulation
 */

// A tab in a browser the REPL connected to has no viewport set, so its size is
// the window's; it is read from the page.
async function viewportText() {
  const device = tabState(state.page).emulation?.device;
  if (device) {
    const { width, height } = devices[device].viewport;
    // A page with no viewport meta tag is laid out as on a desktop, and the phone shows it shrunk.
    const laidOut = await state.page.evaluate(() => innerWidth).catch(() => null);
    const wider = laidOut && laidOut > width ? `; the page lays out ${laidOut} wide, shown shrunk: it has no viewport meta tag` : '';
    return `${width}x${height} (emulate mobile: ${device}${wider})`;
  }
  const set = tabState(state.page).viewport;
  if (set) return `${set.width}x${set.height} (set with viewport)`;
  const size = await state.page.evaluate(() => `${innerWidth}x${innerHeight}`).catch(() => null);
  // The window less its frame (headless Chromium counts one too: a 1280x800 window has a 1280x657 page).
  return size ? `${size} (the window's page area)` : 'unknown';
}

// The viewport's size, in the CSS pixels mouse and touch points are given in: a phone's, a size set
// with viewport, or else the page's (a tab attached over CDP has none set, so Playwright knows none).
async function viewportSize() {
  const device = tabState(state.page).emulation?.device;
  if (device) return devices[device].viewport;
  const set = tabState(state.page).viewport;
  if (set) return set;
  return state.page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => null);
}

// The viewport's size (1280x657) when a point is outside it; null when it is inside, or the size is unknown.
/**
 * @param {number} x
 * @param {number} y
 */
async function outsideViewport(x, y) {
  const size = await viewportSize();
  if (!size || x >= 0 && y >= 0 && x < size.width && y < size.height) return null;
  return `${size.width}x${size.height}`;
}

const IN_VIEW = 'A point is in CSS pixels from the top left of the viewport: scroll what you want into view (eval document.querySelector(<selector>).scrollIntoView(), or mouse wheel), then measure it again';

const DEFAULT_DEVICE = 'Pixel 7';
// The media features and type besides the color scheme, as Playwright's emulateMedia names their values;
// the first is the default.
/** @type {Record<string, { key: 'motion' | 'colors' | 'contrast' | 'media', feature?: string, values: string[] }>} */
const MEDIA_KINDS = {
  'reduced-motion': { key: 'motion', feature: 'prefers-reduced-motion', values: ['reduce', 'no-preference'] },
  'forced-colors': { key: 'colors', feature: 'forced-colors', values: ['active', 'none'] },
  contrast: { key: 'contrast', feature: 'prefers-contrast', values: ['more', 'no-preference'] },
  media: { key: 'media', values: ['print', 'screen'] },
};
const EMULATE_KINDS = ['mobile', 'dark', 'light', ...Object.keys(MEDIA_KINDS), 'locale', 'timezone'];

/** @param {Emulation | null | undefined} e */
function emulatedKinds(e) {
  return [e?.device && 'mobile', e?.scheme, ...Object.entries(MEDIA_KINDS).map(([what, { key }]) => e?.[key] && what), e?.locale && 'locale', e?.timezone && 'timezone'].filter(Boolean);
}

// One call sets them all, and replaces what it set before: each change sends every one that is on.
/** @param {Emulation} e */
function emulatedMedia(e) {
  const features = Object.values(MEDIA_KINDS).filter(k => k.feature && e[k.key]).map(k => ({ name: /** @type {string} */ (k.feature), value: /** @type {string} */ (e[k.key]) }));
  if (e.scheme) features.unshift({ name: 'prefers-color-scheme', value: e.scheme });
  return { media: e.media || '', features };
}

const DEVICES_SHOWN = 20;

/** @param {string} name */
function deviceNamed(name) {
  const names = Object.keys(devices);
  const found = names.find(d => d.toLowerCase() === name.toLowerCase());
  if (found) return found;
  // The names that have every word typed, so a near miss finds the exact name.
  const words = name.toLowerCase().split(/\s+/);
  const close = names.filter(d => !/ landscape$/.test(d) && words.every(w => d.toLowerCase().includes(w)));
  if (!close.length) throw new Error(`No device ${JSON.stringify(name)}; names are Playwright's, e.g. Pixel 7, iPhone 13, iPad Mini, Galaxy S9+`);
  const more = close.length > DEVICES_SHOWN ? `, and ${close.length - DEVICES_SHOWN} more` : '';
  throw new Error(`No device ${JSON.stringify(name)}; matching: ${close.slice(0, DEVICES_SHOWN).join(', ')}${more} (each also as "<name> landscape")`);
}

/** @param {string} name */
function deviceText(name) {
  const d = devices[name];
  return `${name}, ${d.viewport.width}x${d.viewport.height} at ${d.deviceScaleFactor}x${d.hasTouch ? ', touch' : ''}`;
}

// A viewport set with viewport, on the kept session, as a phone's size is, so that viewport off can
// undo it: Playwright's setViewportSize has no undo. As Playwright sets it, at one device pixel per
// CSS pixel, and the window is left as it is.
/**
 * @param {CDPSession} session
 * @param {{ width: number, height: number }} size
 */
function viewportMetrics(session, { width, height }) {
  return session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height });
}

// Chrome answers a change of screen size before the page has it (a clear, often), so the size read
// next, a screenshot or a recording would be the old one: two frames later it has it. Bounded, as a
// dialog holds the page.
/** @param {Page} p */
function settled(p) {
  return Promise.race([
    p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 1000)),
  ]);
}

// Bringing a tab to the front can leave Chrome capturing it at the window's size after its next
// navigation, although the page is still laid out at its viewport's or phone's: sending the same
// metrics again, on the kept session, has it draw at them.
/** @param {Page} p */
async function reapplyMetrics(p) {
  const tab = tabState(p);
  if (!tab.viewport && !tab.emulation?.device) return;
  const session = await keptSession(p);
  if (tab.viewport) await viewportMetrics(session, tab.viewport);
  else if (tab.emulation?.device) await deviceMetrics(session, tab.emulation.device);
  await settled(p);
}

/**
 * @param {Page} p
 * @param {{ width: number, height: number } | null} size
 */
async function setViewport(p, size) {
  const session = await keptSession(p);
  if (size) {
    await viewportMetrics(session, size);
    tabState(p).viewport = { ...size, owner: state.client };
  } else {
    await session.send('Emulation.clearDeviceMetricsOverride');
    delete tabState(p).viewport;
  }
  await settled(p);
}

// Sends only what changed. Chrome takes the user agent and the languages
// together, so a change to either sends both.
/**
 * @param {CDPSession} session
 * @param {string} name
 */
function deviceMetrics(session, name) {
  // Playwright's descriptors carry a screen size its DeviceDescriptor type leaves out.
  const d = /** @type {typeof devices[string] & { screen?: { width: number, height: number } }} */ (devices[name]);
  return session.send('Emulation.setDeviceMetricsOverride', {
    width: d.viewport.width, height: d.viewport.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.isMobile,
    screenWidth: d.screen?.width || d.viewport.width, screenHeight: d.screen?.height || d.viewport.height,
  });
}

/**
 * @param {Page} p
 * @param {Emulation} next
 */
async function setEmulation(p, next) {
  const session = await keptSession(p);
  const previous = tabState(p).emulation || {};
  /** @type {(method: Parameters<CDPSession['send']>[0], params?: any) => Promise<any>} */
  const send = (method, params) => session.send(method, params);
  if (next.device !== previous.device) {
    const d = devices[/** @type {string} */ (next.device)];
    if (d) {
      await deviceMetrics(session, /** @type {string} */ (next.device));
    } else {
      await send('Emulation.clearDeviceMetricsOverride');
    }
    await send('Emulation.setTouchEmulationEnabled', d?.hasTouch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    await settled(p);
  }
  if (next.device !== previous.device || next.locale !== previous.locale) {
    if (next.device || next.locale) {
      const userAgent = next.device ? devices[next.device].userAgent : (await send('Browser.getVersion')).userAgent;
      await send('Emulation.setUserAgentOverride', { userAgent, ...(next.locale ? { acceptLanguage: next.locale } : {}) });
    } else {
      // An empty user agent ends the override.
      await send('Emulation.setUserAgentOverride', { userAgent: '' });
    }
  }
  if (next.locale !== previous.locale) await send('Emulation.setLocaleOverride', next.locale ? { locale: next.locale } : {});
  if (next.timezone !== previous.timezone) await send('Emulation.setTimezoneOverride', { timezoneId: next.timezone || '' });
  if (JSON.stringify(emulatedMedia(next)) !== JSON.stringify(emulatedMedia(previous))) await send('Emulation.setEmulatedMedia', emulatedMedia(next));
  if (emulatedKinds(next).length) tabState(p).emulation = { ...next, owner: state.client }; else delete tabState(p).emulation;
}

function showEmulation() {
  const e = tabState(state.page).emulation;
  const forms = [
    ['emulate mobile [device]', `a phone's screen, touch and user agent (default ${DEFAULT_DEVICE})`],
    ['emulate dark | light', 'the color scheme the page sees'],
    ['emulate reduced-motion [reduce | no-preference]', 'prefers-reduced-motion (default reduce)'],
    ['emulate forced-colors [active | none]', 'forced-colors (default active)'],
    ['emulate contrast [more | no-preference]', 'prefers-contrast (default more)'],
    ['emulate media <print | screen>', 'the CSS media type'],
    ['emulate locale <tag>', 'its language and formats, e.g. fr-FR'],
    ['emulate timezone <zone>', 'e.g. Asia/Tokyo'],
  ];
  if (!e) {
    out.log('Nothing is emulated in the selected tab.');
    out.log(hints(forms));
    return;
  }
  out.log('Emulated in the selected tab:');
  const rows = [
    e.device && ['mobile', deviceText(e.device)],
    e.scheme && ['color scheme', e.scheme],
    e.motion && ['reduced motion', e.motion],
    e.colors && ['forced colors', e.colors],
    e.contrast && ['contrast', e.contrast],
    e.media && ['media', e.media],
    e.locale && ['locale', e.locale],
    e.timezone && ['timezone', e.timezone],
  ].filter(Boolean);
  for (const [what, value] of rows) out.log(`  ${what.padEnd(14)}  ${value}`);
  out.log(hints([...forms, ['emulate <what> off | emulate off', 'stop one, or all']]));
}

// Resets every tab's emulation and viewport, which detaching would only partly undo.
async function resetEmulations() {
  if (!state.browser || state.connectionLost) return;
  const pages = state.browser.contexts().flatMap(c => c.pages()).filter(p => !p.isClosed());
  await Promise.all(pages.map(async p => {
    if ('emulation' in tabState(p)) await setEmulation(p, {}).catch(() => {});
    if ('viewport' in tabState(p)) await setViewport(p, null).catch(() => {});
  }));
}

onShutdown(resetEmulations);

const commands = {
  /** @param {string} args */
  async viewport(args) {
    const arg = (args || '').trim();
    if (!arg) { out.log(await viewportText()); return; }
    if (arg === 'off') {
      if (!tabState(state.page).viewport) { out.log(`No viewport is set in the selected tab: ${await viewportText()}`); return; }
      await setViewport(state.page, null);
      out.log(`Viewport off: ${await viewportText()}`);
      return;
    }
    const match = /^(\d+)x(\d+)$/i.exec(arg);
    const [w, h] = match ? [Number(match[1]), Number(match[2])] : [];
    if (!match) throw new Error(`A size is <width>x<height>, e.g. viewport 1280x900 (got ${arg}). Usage: viewport [<width>x<height> | off]`);
    if (!w || !h) throw new Error(`A width and a height are 1 or more (got ${arg})`);
    // Both set the screen size; whichever came last would win without saying so.
    if (tabState(state.page).emulation?.device) throw new Error('emulate mobile sets the size of the selected tab; emulate mobile off first');
    await setViewport(state.page, { width: w, height: h });
    out.log(`Viewport set to ${w}x${h}`);
  },

  // Per tab, like network: the settings live in the tab's kept CDP session.
  /** @param {string} args */
  async emulate(args) {
    const words = (args || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return showEmulation();
    const usage = 'Usage: emulate [mobile [device] | dark | light | reduced-motion [reduce|no-preference] | forced-colors [active|none] | contrast [more|no-preference] | media <print|screen> | locale <tag> | timezone <zone>], emulate <what> off, emulate off';
    const [what, ...rest] = words;
    const value = rest.join(' ');
    const current = tabState(state.page).emulation || {};
    if (what === 'off' && !rest.length) {
      const was = emulatedKinds(current);
      await setEmulation(state.page, {});
      out.log(was.length ? `Stopped emulating in the selected tab: ${was.join(', ')}` : 'Nothing was emulated in the selected tab.');
      return;
    }
    if (!EMULATE_KINDS.includes(what)) throw new Error(usage);
    const key = /** @type {Record<string, keyof Emulation>} */ ({ mobile: 'device', dark: 'scheme', light: 'scheme', locale: 'locale', timezone: 'timezone' })[what] || MEDIA_KINDS[what].key;
    if (value === 'off') {
      await setEmulation(state.page, { ...current, [key]: undefined });
      out.log(`Stopped emulating ${key === 'scheme' ? 'the color scheme' : what} in the selected tab`);
      // As when turned on: the page keeps what it read at load until it loads again.
      if ((what === 'mobile' || what === 'locale') && state.page.url() !== 'about:blank') out.log('The page sees its own user agent, touch and languages again from its next load: reload to see all of it.');
      return;
    }
    let next;
    /** @type {string | undefined} */
    let replaced;
    if (what === 'mobile') {
      next = deviceNamed(value || DEFAULT_DEVICE);
      // One screen size at a time: a phone's replaces a viewport, whoever set it, as modes are shared.
      const viewport = tabState(state.page).viewport;
      if (viewport) {
        const owner = viewport.owner === state.client ? 'you' : viewport.owner || 'someone with no client name';
        replaced = `Replaced the viewport set by ${owner} (${viewport.width}x${viewport.height}): a phone has its own size`;
      }
    } else if (what === 'dark' || what === 'light') {
      if (value) throw new Error(usage);
      next = what;
    } else if (MEDIA_KINDS[what]) {
      const { values } = MEDIA_KINDS[what];
      next = value || (what === 'media' ? '' : values[0]);
      if (!values.includes(next)) throw new Error(`Usage: emulate ${what} ${what === 'media' ? `<${values.join('|')}>` : `[${values.join('|')}] (default ${values[0]})`}`);
    } else if (!value || rest.length > 1) {
      throw new Error(`Usage: emulate ${what} ${what === 'locale' ? '<tag>, e.g. fr-FR' : '<zone>, e.g. Asia/Tokyo'}`);
    } else if (what === 'locale') {
      try { next = Intl.getCanonicalLocales(value)[0]; } catch { throw new Error(`Not a locale: ${value}; e.g. fr-FR, de, pt-BR`); }
    } else {
      // Checked, but kept as given: Node's names can be older ones (Asia/Calcutta for Asia/Kolkata).
      try { new Intl.DateTimeFormat('en-US', { timeZone: value }); } catch { throw new Error(`Not a timezone: ${value}; e.g. Asia/Tokyo, America/New_York, UTC`); }
      next = value;
    }
    await setEmulation(state.page, { ...current, [key]: next });
    if (replaced) {
      // Gone, not kept beside the phone: whatever sends the size again prefers a viewport.
      delete tabState(state.page).viewport;
      out.log(replaced);
    }
    const shown = what === 'mobile' ? `mobile (${deviceText(next)})` : what === 'dark' || what === 'light' ? `${what} mode` : `${what} ${next}`;
    out.log(`Emulating ${shown} in the selected tab`);
    // The page reads these when it loads; the rest applies at once. A blank tab has nothing to reload.
    if ((what === 'mobile' || what === 'locale') && state.page.url() !== 'about:blank') out.log('The page sees its user agent, touch and languages from its next load: reload to see all of it.');
  },
};

module.exports = { commands, viewportText, outsideViewport, IN_VIEW, EMULATE_KINDS, emulatedKinds, deviceMetrics, viewportMetrics, setEmulation, setViewport, settled, reapplyMetrics };
