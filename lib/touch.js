// touch: gestures at points in the viewport, as a finger makes them, for a tab under emulate mobile.
// Raw touch events through the tab's kept CDP session, not Chrome's synthesize gestures, which send
// no click or dblclick.
const { state } = require('./state');
const out = require('./output');
const { numbers, parseDuration, durationText } = require('./util');
const { tabState } = require('./tabstate');
const { keptSession } = require('./cdp');
const { outsideViewport, IN_VIEW } = require('./emulation');

const GESTURES = ['tap', 'doubletap', 'longpress', 'swipe', 'pinch'];
const LONGPRESS = 800;
// A move every frame or so: one jump would read as no swipe to a page that measures its speed.
const STEP_MS = 16;
const STEPS = 12;
// Where pinch's two fingers start: this far apart, side by side about the point.
const PINCH_SPAN = 100;

const wait = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {'touchStart' | 'touchMove' | 'touchEnd'} type
 * @param {number[][]} points
 */
async function send(type, points) {
  const session = await keptSession(state.page);
  await session.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
}

/**
 * @param {number} x
 * @param {number} y
 */
async function tap(x, y) {
  await send('touchStart', [[x, y]]);
  await send('touchEnd', []);
}

/** @param {string} gesture */
function usageOf(gesture) {
  return /** @type {Record<string, string>} */ ({
    tap: 'touch tap <x> <y>',
    doubletap: 'touch doubletap <x> <y>',
    longpress: 'touch longpress <x> <y> [time]',
    swipe: 'touch swipe <x> <y> <dx> <dy>',
    pinch: 'touch pinch <x> <y> <scale>',
  })[gesture];
}

const commands = {
  /** @param {string} args */
  async touch(args) {
    const [gesture, ...rest] = (args || '').trim().split(/\s+/);
    if (!GESTURES.includes(gesture)) throw new Error(`Usage: touch ${GESTURES.join('|')} <x> <y> ...; help touch says what each takes`);
    const usage = `Usage: ${usageOf(gesture)}`;
    // Without it the page gets touch events but no touch screen: pointerType and the like say otherwise.
    if (!tabState(state.page).emulation?.device) throw new Error('touch needs a touch screen: emulate mobile first, then reload');
    const counts = /** @type {Record<string, number>} */ ({ tap: 2, doubletap: 2, longpress: 3, swipe: 4, pinch: 3 })[gesture];
    if (gesture === 'longpress' && rest.length === 3) {
      const held = parseDuration(rest[2]);
      if (held === null) throw new Error(`${usage}, the time in ms or seconds (1.5s)`);
      rest[2] = String(held);
    }
    const values = numbers(rest.join(' '), usageOf(gesture));
    if (values.length < (gesture === 'longpress' ? 2 : counts) || values.length > counts) throw new Error(usage);
    const [x, y] = values;
    // A finger put down outside the viewport touches nothing; a swipe may still end outside it.
    const outside = await outsideViewport(x, y);
    if (outside) throw new Error(`${x}, ${y} is outside the viewport (${outside}); nothing was touched. ${IN_VIEW}`);
    if (gesture === 'tap') {
      await tap(x, y);
      out.log(`Tapped at ${x}, ${y}`);
    } else if (gesture === 'doubletap') {
      await tap(x, y);
      await tap(x, y);
      out.log(`Double-tapped at ${x}, ${y}`);
    } else if (gesture === 'longpress') {
      const held = values[2] ?? LONGPRESS;
      await send('touchStart', [[x, y]]);
      await wait(held);
      await send('touchEnd', []);
      out.log(`Long-pressed at ${x}, ${y} for ${durationText(held)}`);
    } else if (gesture === 'swipe') {
      const [, , dx, dy] = values;
      await send('touchStart', [[x, y]]);
      for (let i = 1; i <= STEPS; i++) {
        await wait(STEP_MS);
        await send('touchMove', [[x + dx * i / STEPS, y + dy * i / STEPS]]);
      }
      await send('touchEnd', []);
      out.log(`Swiped from ${x}, ${y} to ${x + dx}, ${y + dy}`);
    } else {
      const scale = values[2];
      if (!(scale > 0)) throw new Error(`${usage}: a scale above 0; under 1 pinches in`);
      const fingers = (/** @type {number} */ span) => [[x - span / 2, y], [x + span / 2, y]];
      await send('touchStart', fingers(PINCH_SPAN));
      for (let i = 1; i <= STEPS; i++) {
        await wait(STEP_MS);
        await send('touchMove', fingers(PINCH_SPAN * (1 + (scale - 1) * i / STEPS)));
      }
      await send('touchEnd', []);
      out.log(`Pinched at ${x}, ${y} to ${scale}x`);
    }
  },
};

module.exports = { commands, GESTURES };
