// Small helpers the commands share: output hints, clipping, times, patterns and number arguments.

const os = require('os');
const path = require('path');

const COMMAND_TIMEOUT = 15000;

const MAX_EVENT_TEXT = 4000;

// For a command that timed out waiting on the page.
const BUSY_PAGE = 'a page busy with a long task does not answer meanwhile: profile on, then try again, shows what it is busy with';

// For a command that needs a tab, when none is selected.
const NO_TAB = 'No tab is selected; select one with tab <index|url-part>, or open one with tab new';

// What a command run on its own prints after its state: the commands that
// come next, set apart from the state by a blank line.
function hints(pairs) {
  const width = Math.max(...pairs.map(([command]) => command.length));
  return `\n${pairs.map(([command, what]) => `  ${command.padEnd(width)}  ${what}`).join('\n')}`;
}

// A time: milliseconds, as Playwright and JavaScript count it, or seconds with an s (1500, 1.5s, 1500ms).
const TIME = /^(\d+(?:\.\d+)?)(ms|s)?$/;

function parseDuration(value) {
  const match = TIME.exec(value || '');
  if (!match) return null;
  return Math.round(Number(match[1]) * (match[2] === 's' ? 1000 : 1));
}

// How a time reads back: 1.5s, or 250ms under a second.
function durationText(ms) {
  return ms >= 1000 ? `${Number((ms / 1000).toFixed(3))}s` : `${ms}ms`;
}

// A time that is a second or more, where a smaller one is most likely seconds written as before.
function longDuration(value, what) {
  const ms = parseDuration(value);
  if (ms === null) throw new Error(`${what} is a time, in milliseconds or with s for seconds: 30000 or 30s (got ${value})`);
  if (ms < 1000) throw new Error(`${what} is in milliseconds, 1000 or more: ${value} is ${durationText(ms)}; ${value}s for seconds`);
  return ms;
}

function clipText(text) {
  return text.length > MAX_EVENT_TEXT ? `${text.slice(0, MAX_EVENT_TEXT)}…` : text;
}

function numbers(args, usage) {
  const words = (args || '').trim().split(/\s+/).filter(Boolean);
  if (words.some(w => !/^-?\d+(?:\.\d+)?$/.test(w))) throw new Error(`Usage: ${usage}, in numbers of CSS pixels`);
  return words.map(Number);
}

// For --regex, as playwright-cli's find --regex and requests --filter take one.
function regexOf(pattern) {
  try { return new RegExp(pattern); } catch (error) { throw new Error(`Not a regular expression: ${error.message}`); }
}

// A pattern without its quotes, and with \" inside them as ", as snapshot
// reads one: other backslashes are the regexp's own (\d).
function patternText(text) {
  return text.replace(/^(["'])(.*)\1$/, '$2').replace(/\\"/g, '"');
}

// Local time with its offset (18:16:15.721-06:00), so it reads against the
// user's clock and is still unambiguous.
function clock(t) {
  const d = new Date(t);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${zone}`;
}

// How the REPL, as it stops, begins what it says of each recording it ended, and of one that ended
// by itself unseen: stop prints those lines.
const STOPPED_RECORDING = 'The REPL stopped, which ended a recording';
const ENDED_UNSEEN = 'A recording ended before the REPL stopped, unseen since';
// Each line stop prints of the files a client left.
const FILES_LEFT = 'Files left';

// Where Playwright installs its browsers and ffmpeg, worked out as playwright-core does it: a cache of
// each platform's own (~/Library/Caches on macOS), unless PLAYWRIGHT_BROWSERS_PATH says otherwise.
function playwrightBrowsersDir() {
  const given = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (given === '0') return path.join(path.dirname(require.resolve('playwright-core/package.json')), '.local-browsers');
  if (given) return path.resolve(process.env.INIT_CWD || process.cwd(), given);
  const cache = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches')
    : process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cache, 'ms-playwright');
}

module.exports = { TIME, parseDuration, durationText, longDuration, BUSY_PAGE, STOPPED_RECORDING, ENDED_UNSEEN, FILES_LEFT, COMMAND_TIMEOUT, MAX_EVENT_TEXT, NO_TAB, hints, clipText, numbers, regexOf, patternText, clock, playwrightBrowsersDir };
