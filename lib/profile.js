// Profiling a tab: a Chrome performance trace of what its main thread did, summed up when it stops.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { state, onShutdown } = require('./state');
const out = require('./output');
const { NO_TAB, clock, hints, TIME, longDuration, durationText } = require('./util');
const { tabState } = require('./tabstate');
const { targetIdOf } = require('./tabs');
const { summarize, LONG_TASK } = require('./trace');

// Without a time, a profile left on stops by itself after this long.
const UNTIMED_MAX = 120000;
const SHOWN = 10;
// DevTools' Performance panel's categories, less the browser-wide ones the summary does not use.
const CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack', 'toplevel', 'v8.execute', 'blink.user_timing', 'loading', 'latencyInfo',
  // JS samples, which name the function a long task spent its time in; --cpu samples more often.
  'disabled-by-default-v8.cpu_profiler'];
const CPU_CATEGORIES = ['disabled-by-default-v8.cpu_profiler.hires'];

let prof = null;
// A profile still being read after it ended by itself (its tab closed, or it reached its limit).
let finishing = null;
let last = null;
let dir = null;

function currentProfile() {
  return prof;
}

function workDir() {
  if (!dir) dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-repl-profile-'));
  return dir;
}

// A trace event naming the tab's frame, from its renderer, so an idle tab is still found in the trace.
// console.timeStamp prints nothing in the console. A page held by a dialog does not answer: no wait.
// At the end it waits two frames and 100ms more first: a click's timing reaches the trace only after the
// paint that follows it, and its step takes in what the page did for 100ms after it.
async function mark(page, { last = false } = {}) {
  if (page.isClosed()) return;
  const marked = page.evaluate(async settle => {
    if (settle) await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))));
    console.timeStamp('pw-repl profile');
  }, last).catch(() => {});
  await Promise.race([marked, new Promise(resolve => setTimeout(resolve, 1000))]);
}

function forget(profile) {
  if (profile?.saveFile) fs.rmSync(profile.saveFile, { force: true });
}

async function startProfile(tokens, quiet = false) {
  if (prof) throw new Error(`Already profiling ${prof.page.url()}; profile off stops it`);
  const usage = 'Usage: profile on [time] [--cpu] (ms, or 30s)';
  const cpu = tokens.includes('--cpu');
  const rest = tokens.filter(t => t !== '--cpu');
  if (rest.length > 1 || (rest.length && !TIME.test(rest[0]))) throw new Error(usage);
  const ms = rest.length ? longDuration(rest[0], 'profile on\'s time') : null;
  if (!state.page || state.page.isClosed()) throw new Error(NO_TAB);
  await finishing;
  const page = state.page;
  const frameId = await targetIdOf(page.context(), page);
  if (!frameId) throw new Error('Could not tell which tab this is in the browser; profile needs a Chromium tab');
  // The browser's own session, not the tab's: a tab's session goes when the tab closes, and its trace
  // with it. Chrome ends the trace if the session goes, so a REPL that dies leaves none running.
  const session = await state.browser.newBrowserCDPSession();
  try {
    await session.send('Tracing.start', {
      transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'none', bufferUsageReportingInterval: 500,
      traceConfig: { includedCategories: cpu ? [...CATEGORIES, ...CPU_CATEGORIES] : CATEGORIES, excludedCategories: ['*'] },
    });
  } catch (error) {
    await session.detach().catch(() => {});
    if (/already/i.test(error.message)) throw new Error('The browser is already recording a trace, and records one at a time: DevTools\' Performance panel, or another REPL\'s profile. Stop that one first.');
    throw error;
  }
  const profile = { page, session, frameId, cpu, owner: state.client, startedAt: Date.now(), url: page.url(), wake: null };
  prof = profile;
  await mark(page);
  // A profile that stops by itself says why in its summary, and in a notice unless a timed profile on
  // is waiting to print it.
  const stop = (why, notice) => {
    profile.stopped = why;
    finishProfile().then(() => { if (!profile.wake) out.notice(`${notice}; profile shows its summary.`, page); }, () => {});
  };
  const onClose = () => {
    if (prof === profile) stop('the tab closed.', 'The profiled tab closed, which ended the profile');
  };
  page.on('close', onClose);
  // Chrome stops recording when its trace buffer fills, as a busy page does in under a minute; the
  // profile stops with it, so it does not run on recording nothing.
  const onUsage = ({ percentFull }) => {
    if (prof !== profile || !(percentFull >= 0.99)) return;
    const after = Math.round((Date.now() - profile.startedAt) / 1000);
    stop(`Chrome's trace buffer filled after ${after}s. Profile a shorter stretch to have all of it.`, `Chrome's trace buffer filled, which stopped the profile after ${after}s`);
  };
  session.on('Tracing.bufferUsage', onUsage);
  profile.unlisten = () => { page.off('close', onClose); session.off('Tracing.bufferUsage', onUsage); };
  if (!ms) {
    profile.cap = setTimeout(() => {
      if (prof === profile) stop(`it reached ${durationText(UNTIMED_MAX)}, the most a profile records without a time (profile on <time> for longer).`, `The profile stopped at ${durationText(UNTIMED_MAX)}, the most it records without a time`);
    }, UNTIMED_MAX);
    if (quiet) return;
    out.log(`Profiling the selected tab${cpu ? ' with a JS CPU profile' : ''}; profile off stops it and prints a summary.`);
    return;
  }
  out.log(`Profiling the selected tab for ${durationText(ms)}...`);
  await new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    profile.wake = () => { clearTimeout(timer); resolve(); };
  });
  // profile off may have ended it first, and printed it; anything else that ended it (its tab closed,
  // the buffer filled) leaves it to this command to print.
  if (profile.stoppedByOff) return;
  await finishProfile();
  await profile.finished;
  printProfile(last);
}

// Ends the trace, reads it from the browser, and sums it up. Once, however many ask.
function finishProfile() {
  const profile = prof;
  if (!profile) return Promise.resolve();
  prof = null;
  clearTimeout(profile.cap);
  profile.unlisten();
  profile.finished = (async () => {
    await mark(profile.page, { last: true });
    const endedAt = Date.now();
    const raw = path.join(workDir(), `raw-${process.pid}-${endedAt}.json`);
    try {
      const complete = new Promise(resolve => profile.session.once('Tracing.tracingComplete', resolve));
      await profile.session.send('Tracing.end');
      const { stream } = await complete;
      const file = fs.openSync(raw, 'w', 0o600);
      try {
        for (;;) {
          const chunk = await profile.session.send('IO.read', { handle: stream, size: 1 << 20 });
          fs.writeSync(file, chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data);
          if (chunk.eof) break;
        }
      } finally {
        fs.closeSync(file);
        await profile.session.send('IO.close', { handle: stream }).catch(() => {});
      }
      await profile.session.detach().catch(() => {});
      forget(last);
      const saveFile = path.join(workDir(), `tab-${process.pid}-${endedAt}.json`);
      const summary = await summarize(raw, { frameId: profile.frameId, url: profile.url, saveFile, cpu: profile.cpu });
      last = { ...profile, endedAt, summary, saveFile, drawing: 'drawing' in tabState(profile.page) };
    } catch (error) {
      await profile.session.detach().catch(() => {});
      last = { ...profile, endedAt, summary: null, error: error.message };
    } finally {
      fs.rmSync(raw, { force: true });
      if (profile.wake) profile.wake();
    }
  })();
  finishing = profile.finished;
  return profile.finished;
}

function secs(us) {
  return `${(us / 1e6).toFixed(2)}s`;
}

// A total in the unit of the items under it: ms under a second.
function total(us) {
  return us < 1e6 ? ms(us) : secs(us);
}

function ms(us) {
  return `${Math.round(us / 1000)}ms`;
}

// The tab's request with this URL nearest to when the trace saw it, for its number in requests.
function requestNumber(profile, request) {
  const at = profile.startedAt + (request.sent - profile.summary.t0) / 1000;
  const entries = (tabState(profile.page).log || []).filter(e => e.url === request.url);
  const nearest = entries.sort((a, b) => Math.abs(a.t - at) - Math.abs(b.t - at))[0];
  return nearest && Math.abs(nearest.t - at) < 2000 ? `#${nearest.id} ` : '';
}

function printProfile(profile, all = false) {
  // So profile off does not show again what has been shown.
  if (finishing && profile === last) finishing.shown = true;
  if (profile.error) { out.log(`The profile from ${clock(profile.startedAt)} could not be read: ${profile.error}`); return; }
  const s = profile.summary;
  const lines = [];
  if (!s) {
    out.log(`Nothing from ${profile.url} was in the trace: its page did no work while it ran, or it closed first.`);
    return;
  }
  const at = ts => `+${((ts - s.t0) / 1e6).toFixed(2)}s`;
  lines.push(`Profiled ${profile.url} for ${secs(s.duration)}, from ${clock(profile.startedAt)}${profile.cpu ? ', with a JS CPU profile' : ''}`);
  if (profile.stopped) lines.push(`Stopped early: ${profile.stopped}`);
  const split = Object.entries(s.buckets).filter(([, us]) => us >= 5000).map(([b, us]) => `${b} ${secs(us)}`);
  lines.push(`Main thread busy ${secs(s.busy)} (${s.duration ? Math.round((100 * s.busy) / s.duration) : 0}%)${split.length ? `: ${split.join(', ')}` : ''}`);
  if (s.marks.length) lines.push(`Page: ${s.marks.map(([name, ts]) => `${name} ${at(ts)}`).join(', ')}`);
  const longTotal = s.longTasks.reduce((sum, t) => sum + t.dur, 0);
  lines.push(`Long tasks (over ${LONG_TASK / 1000}ms): ${s.longTasks.length ? `${s.longTasks.length}, ${total(longTotal)} in all` : 'none'}`);
  const longest = all ? s.longTasks : [...s.longTasks].sort((a, b) => b.dur - a.dur).slice(0, SHOWN).sort((a, b) => a.ts - b.ts);
  for (const t of longest) {
    const after = t.after ? `  (after ${requestNumber(profile, t.after)}${t.after.method} ${t.after.url}, ${Math.round(t.after.size / 1024)}KB, finished ${at(t.after.finished)})` : '';
    const hot = t.hot ? `; most in ${t.hot.where} (${ms(t.hot.us)})` : '';
    lines.push(`  ${at(t.ts).padStart(8)}  ${ms(t.dur).padStart(6)}  ${[t.kind, t.trigger, t.script].filter(Boolean).join(', ')}${hot}${after}`);
  }
  if (longest.length < s.longTasks.length) lines.push(`  (the ${longest.length} longest; profile --all lists them all)`);
  if (s.forced.length) {
    const count = s.forced.reduce((sum, f) => sum + f.count, 0);
    lines.push(`Forced style and layout (work a script waited for, reading a size or style): ${count}, ${ms(s.forced.reduce((sum, f) => sum + f.dur, 0))} in all`);
    for (const f of all ? s.forced : s.forced.slice(0, SHOWN)) lines.push(`  ${`${f.count}x`.padStart(5)}  ${ms(f.dur).padStart(6)}  ${f.where}`);
  }
  if (s.steps.length) {
    lines.push('Steps (input that reached the page, and what it did until 100ms after each step\'s last event):');
    const steps = all ? s.steps : s.steps.slice(0, SHOWN * 2);
    for (const step of steps) {
      const span = step.latency != null
        ? `${Math.round(step.latency)}ms to next paint (input delay ${Math.round(step.delay)}ms, handlers ${Math.round(step.handlers)}ms, presentation ${Math.round(step.presentation)}ms)${step.scrolled ? ', the page scrolled' : ''}`
        : `${secs(step.end - step.start)}, ${step.events} event${step.events === 1 ? '' : 's'}`;
      const frames = step.frames ? `, frames ${step.frames} drawn, ${step.dropped} dropped` : '';
      // One under way at profile on (an action still running): what ran before it began is not in the
      // trace, so its busy time would be only the end of it.
      const busy = step.start < s.t0 ? 'began before the profile: its busy time was not recorded' : `busy ${ms(step.busy)}${step.longest ? `, longest task ${ms(step.longest)}` : ''}`;
      lines.push(`  ${(step.start < s.t0 ? 'before' : at(step.start)).padStart(8)}  ${step.kind}  ${span}; ${busy}${frames}`);
    }
    if (steps.length < s.steps.length) lines.push(`  (the first ${steps.length} of ${s.steps.length}; profile --all lists them all)`);
    if (profile.drawing && s.steps.some(step => step.frames)) {
      lines.push('  Frames are counted as for a tab in front: pw-repl keeps every tab it uses drawing as if it were. Behind another tab, as the user would have it, Chrome draws far less.');
    }
  }
  if (s.cpu) {
    lines.push(s.cpu.length ? 'JS CPU profile, by own time:' : 'JS CPU profile: no JS ran');
    for (const f of all ? s.cpu : s.cpu.slice(0, SHOWN)) lines.push(`  ${ms(f.us).padStart(7)}  ${f.where}`);
  }
  out.printOutput(lines.join('\n'), true);
}

const commands = {
  async profile(args, all) {
    const [sub, ...rest] = (args || '').trim().split(/\s+/).filter(Boolean);
    if (sub === 'on') return startProfile(rest);
    if (sub === 'off' && !rest.length) {
      // One that ended by itself is printed once it has been read.
      const ended = !prof && finishing && !finishing.shown;
      if (!prof && !ended) { out.log('Not profiling.'); return; }
      if (ended) out.log('The profile had already stopped:');
      if (prof) prof.stoppedByOff = true;
      await finishProfile();
      await finishing;
      printProfile(last, all);
      out.log(hints([['profile save <file>', 'write the tab\'s trace, for DevTools\' Performance panel']]));
      return;
    }
    await finishing;
    if (sub === 'save') return saveProfile(rest.join(' '));
    if (sub === 'reload' && !rest.length) return profileReload(all);
    if (sub) throw new Error(`Usage: profile on [time] [--cpu] | off | save <file> | reload`);
    if (prof) {
      out.log(`Profiling ${prof.page.url()} since ${clock(prof.startedAt)}${prof.owner ? `, for ${prof.owner}` : ''}`);
      out.log(hints([['profile off', 'stop and print a summary']]));
      return;
    }
    if (last) {
      out.log(`Not profiling. The last profile, from ${clock(last.startedAt)}:`);
      printProfile(last, all);
    } else {
      out.log('Not profiling.');
    }
    out.log(hints([
      ['profile on [time]', 'record what the selected tab\'s main thread does'],
      ['profile reload', 'profile the selected tab\'s page as it loads'],
    ]));
  },
};

async function profileReload(all) {
  if (prof) throw new Error(`Already profiling ${prof.page.url()}; profile off stops it`);
  if (!state.page || state.page.isClosed()) throw new Error(NO_TAB);
  const page = state.page;
  await startProfile([], true);
  let note = null;
  try {
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { note = 'Its network was still busy 10s after load; the profile stops there.'; });
    // Its largest paint and the work after load land in the next frames.
    await page.waitForTimeout(500);
  } finally {
    await finishProfile();
  }
  printProfile(last, all);
  if (note) out.log(note);
}

function saveProfile(file) {
  if (!file) throw new Error('Usage: profile save <file>, e.g. profile save load.json');
  if (prof) throw new Error('Still profiling; profile off stops it first');
  if (!last?.saveFile || !fs.existsSync(last.saveFile)) throw new Error('No profile to save: profile on records one first');
  if (fs.existsSync(file)) throw new Error(`${file} exists already; name another file`);
  if (!fs.existsSync(path.dirname(path.resolve(file)))) throw new Error(`No folder ${path.dirname(path.resolve(file))} to save ${path.basename(file)} in`);
  fs.copyFileSync(last.saveFile, file, fs.constants.COPYFILE_EXCL);
  const kb = Math.round(fs.statSync(file).size / 1024);
  out.log(`Saved the profile of ${last.url} to ${file} (${kb} KB): the tab's events only. Chrome DevTools' Performance panel (Load profile) and ui.perfetto.dev open it.`);
}

// A profile must not outlive the REPL: Chrome traces one at a time, for the whole browser.
onShutdown(async () => {
  if (prof) {
    const { session } = prof;
    prof = null;
    await session.send('Tracing.end').catch(() => {});
    await session.detach().catch(() => {});
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

module.exports = { commands, currentProfile, finishProfile, printProfile };
