// The CDP session kept for each tab, and keeping a background tab drawing.
const { tabState } = require('./tabstate');
const { onShutdown } = require('./state');

// Per page: a CDP session's emulation applies to the page it is attached to
// and resets, in part, when it detaches, so one is kept for each tab.
/** @param {import('playwright-core').Page} p */
function keptSession(p) {
  if (!('session' in tabState(p))) tabState(p).session = p.context().newCDPSession(p).catch((/** @type {Error} */ error) => { delete tabState(p).session; throw error; });
  return tabState(p).session;
}

// Chrome all but stops drawing a tab that is not in front once it has had
// input (about a frame a second), and Playwright waits for frames to see an
// element hold still before acting on it, so each click in a tab opened in the
// background took 1-2s. A screencast keeps the tab drawing without bringing it
// to the front (the throttle is back within seconds of stopping it). Its frames
// are tiny and rare; the cost is that the tab renders at full rate, as if in
// front, an animation or a video included: with software rendering, cores per
// tab. So it runs only while commands act in the tab, and stops once the tab
// has had none for DRAW_IDLE; starting it again before a click is as quick.
const DRAW_IDLE = 3000;

/** The tabs drawing now, each stopped once idle. @type {Set<import('playwright-core').Page>} */
const drawingTabs = new Set();

/** @param {import('playwright-core').Page} p */
async function keepDrawing(p) {
  const tab = tabState(p);
  clearTimeout(tab.drawIdle);
  delete tab.drawIdle;
  if ('drawing' in tab) return;
  tab.drawing = true;
  try {
    const session = await keptSession(p);
    if (!tab.focusEmulated) {
      // A tab behind another draws no frames, and Playwright's actions wait for frames: told it is in
      // front and focused, it draws, and clicks in it work. Only in tabs the REPL uses (the browser is
      // connected without Playwright's own, which would tell every tab, the user's too), so the user's
      // tabs say truly whether they are in front.
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      tab.focusEmulated = true;
      session.on('Page.screencastFrame', (/** @type {{ sessionId: number }} */ frame) => session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {}));
      p.once('close', () => { clearTimeout(tabState(p).drawIdle); drawingTabs.delete(p); });
    }
    await session.send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 8, maxHeight: 8, everyNthFrame: 60 });
    drawingTabs.add(p);
  } catch {
    // Only slower without it.
    delete tab.drawing;
  }
}

// After a command: each tab drawing stops once it has had no command for DRAW_IDLE. Given a tab, only
// that one: drawn for a browser event, not a command, when another tab's command may be running.
/** @param {import('playwright-core').Page} [only] */
function drawUntilIdle(only) {
  for (const p of only ? [only].filter(p => drawingTabs.has(p)) : drawingTabs) {
    const tab = tabState(p);
    if (tab.drawIdle) continue;
    tab.drawIdle = setTimeout(() => { stopDrawing(p).catch(() => {}); }, DRAW_IDLE);
    tab.drawIdle.unref();
  }
}

/** @param {import('playwright-core').Page} p */
async function stopDrawing(p) {
  const tab = tabState(p);
  clearTimeout(tab.drawIdle);
  delete tab.drawIdle;
  drawingTabs.delete(p);
  if (!('drawing' in tab)) return;
  delete tab.drawing;
  if (!p.isClosed()) await (await keptSession(p)).send('Page.stopScreencast');
}

// At shutdown: no timer left to fire at a page that is going.
function stopIdleTimers() {
  for (const p of drawingTabs) clearTimeout(tabState(p).drawIdle);
  drawingTabs.clear();
}

onShutdown(stopIdleTimers);

module.exports = { keptSession, keepDrawing, drawUntilIdle, DRAW_IDLE };
