// Reading a Chrome performance trace for one tab: what its main thread was busy with, its long
// tasks, forced layouts, frames and the input it handled. The trace is the whole browser's; the tab's
// events are told apart by its renderer process, found from events that name its main frame.
const fs = require('fs');
const readline = require('readline');

const LONG_TASK = 50000;
const BIG_REQUEST = 100 * 1024;
// Input events this close together are one step: a wheel-zoom or a scroll is many events.
const STEP_GAP = 300000;
// A step's frames and busy time include this long after its last input, for what it drew.
const STEP_TAIL = 100000;
// How long before its scroll events a scroll's frame can be drawn: the compositor scrolls and draws, and
// the page gets the scroll event in its next frame, later still when frames are being dropped.
const SCROLL_LEAD = 50000;

const BUCKETS = ['scripting', 'style/layout', 'paint', 'GC', 'other'];

// DevTools' categories, by event name; anything else counts as the task's own time, other.
const SCRIPTING = new Set(['FunctionCall', 'EvaluateScript', 'v8.evaluateModule', 'v8.compile', 'v8.compileModule',
  'V8.CompileCode', 'v8.produceCache', 'v8.run', 'TimerFire', 'EventDispatch', 'FireAnimationFrame', 'FireIdleCallback',
  'RunMicrotasks', 'XHRReadyStateChange', 'XHRLoad', 'v8.callFunction', 'v8.parseOnBackground', 'CppGC.IncrementalSweep']);
const LAYOUT = new Set(['UpdateLayoutTree', 'RecalculateStyles', 'Layout', 'HitTest', 'IntersectionObserverController::computeIntersections']);
const PAINT = new Set(['Paint', 'PaintImage', 'PrePaint', 'Layerize', 'UpdateLayer', 'UpdateLayerTree', 'CompositeLayers',
  'Commit', 'Decode Image', 'Draw LazyPixelRef', 'Decode LazyPixelRef', 'ImageDecodeTask']);
const GC = new Set(['MinorGC', 'MajorGC', 'BlinkGC.AtomicPhase', 'V8.GCScavenger', 'V8.GCFinalizeMC', 'V8.GCIncrementalMarking',
  'V8.GC_MC_BACKGROUND_EVACUATE_COPY', 'BlinkGC.ConcurrentMarking', 'CppGC.AtomicMark']);

function bucketOf(name) {
  if (SCRIPTING.has(name)) return 'scripting';
  if (LAYOUT.has(name)) return 'style/layout';
  if (PAINT.has(name)) return 'paint';
  if (GC.has(name) || /^(?:V8|CppGC|BlinkGC)\.GC|GC$/.test(name)) return 'GC';
  return null;
}

// What set a task off, from the first event in it that says.
const TRIGGERS = { TimerFire: 'timer', FireAnimationFrame: 'animation frame', FireIdleCallback: 'idle callback',
  ParseHTML: 'parsing HTML', XHRLoad: 'XHR load', XHRReadyStateChange: 'XHR', RunMicrotasks: 'promise callbacks' };

const RUN_TASK = new Set(['RunTask', 'ThreadControllerImpl::RunTask']);

// The main thread's events the summary times by name alone, read without parsing them: most of a busy
// trace (a style recalculation and a paint per element changed).
function timedOnly(name) {
  return !DETAILED.has(name) && (RUN_TASK.has(name) || bucketOf(name) || TRIGGERS[name] || name === 'ParseHTML');
}
const DETAILED = new Set(['FunctionCall', 'EvaluateScript', 'EventDispatch', 'Layout', 'UpdateLayoutTree']);
// The rest that collect reads.
const PARSED = new Set([...DETAILED, 'EventTiming', 'PipelineReporter', 'ResourceSendRequest', 'ResourceFinish', 'MarkDOMContent',
  'MarkLoad', 'navigationStart', 'firstContentfulPaint', 'largestContentfulPaint::Candidate', 'Profile', 'ProfileChunk']);

// The trace's events, one at a time: Chrome writes each on a line of its own. A trace runs to hundreds
// of megabytes, mostly other processes' events: wanted(line) passes over a line before it is parsed.
/** @param {((line: string) => boolean) | null} [wanted] */
async function eachEvent(file, fn, wanted = null) {
  await eachLine(file, line => {
    if (wanted && !wanted(line)) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    fn(event, line);
  });
}

async function eachLine(file, fn) {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (let line of lines) {
    if (!line.startsWith('{"') || line.startsWith('{"traceEvents"')) continue;
    if (line.endsWith(',')) line = line.slice(0, -1);
    // The last event shares its line with the end of the list, and the start of the trace's metadata.
    else line = line.replace(/\](?:,"metadata":.*|\})$/, '');
    fn(line);
  }
}

function nameOf(line) {
  const at = line.lastIndexOf('"name":"');
  return at < 0 ? '' : line.slice(at + 8, line.indexOf('"', at + 8));
}

// A number field of an event, read from its line without parsing it. Chrome writes the keys in order,
// args first, so the last one by that name is the event's own.
function field(line, name) {
  const at = line.lastIndexOf(`"${name}":`);
  return at < 0 ? NaN : parseFloat(line.slice(at + name.length + 3));
}

function frameOf(e) {
  return e.args?.data?.frame || e.args?.frame || null;
}

function shortUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'data:') return 'data:…';
    const file = u.pathname.split('/').filter(Boolean).pop();
    return file || u.host;
  } catch {
    return url.slice(0, 60);
  }
}

// url:line function, as DevTools names a function. Lines are 1-based in the trace's events and stacks,
// 0-based in its JS samples' call frames.
function where(frame, zeroBased = false) {
  if (!frame) return '';
  const line = frame.lineNumber != null && frame.lineNumber >= 0 ? `:${frame.lineNumber + (zeroBased ? 1 : 0)}` : '';
  const fn = frame.functionName || '(anonymous)';
  return `${shortUrl(frame.url)}${line} ${fn}`.trim();
}

// Reads the trace twice: once to find the tab's renderer processes and their threads, then to sum
// up the tab's events, writing them (with what DevTools needs to open them) to saveFile.
async function summarize(file, { frameId, url, saveFile, cpu = false }) {
  const pids = new Set();
  const threads = new Map();
  /** @type {any} */
  let started = null;
  let firstTs = Infinity;
  let lastTs = 0;
  const firstSeen = new Map();
  await eachEvent(file, e => {
    if (e.name === 'thread_name' && e.ph === 'M') threads.set(`${e.pid}:${e.tid}`, e.args?.name);
    if (e.name === 'TracingStartedInBrowser') started = e;
    if (frameOf(e) === frameId && e.pid) pids.add(e.pid);
  }, line => {
    const ts = field(line, 'ts');
    if (ts && !line.includes('"ph":"M"')) {
      const pid = field(line, 'pid');
      if (!firstSeen.has(pid)) firstSeen.set(pid, ts);
      firstTs = Math.min(firstTs, ts);
      lastTs = Math.max(lastTs, ts + (field(line, 'dur') || 0));
    }
    return line.includes('"thread_name"') || line.includes('TracingStartedInBrowser') || line.includes(frameId);
  });
  const mainOf = new Map();
  const compositorOf = new Map();
  for (const [key, name] of threads) {
    const [pid, tid] = key.split(':').map(Number);
    if (!pids.has(pid)) continue;
    if (name === 'CrRendererMain') mainOf.set(pid, tid);
    if (name === 'Compositor') compositorOf.set(pid, tid);
  }
  // The browser process names the tab's frame too (its navigations): only renderers are the tab's.
  for (const pid of pids) if (!mainOf.has(pid)) pids.delete(pid);
  const t0 = started?.ts ?? firstTs;
  const tracks = { main: new Events(), timings: new Map(), frames: [], requests: new Map(), marks: {}, profiles: new Map() };
  // Written as it is read, in batches: a write stream would hold what the disk has not taken yet.
  /** @typedef {{ fd: number, started: boolean, chunk: string[], size: number }} Save */
  const save = saveFile ? /** @type {Save} */ ({ fd: fs.openSync(saveFile, 'w', 0o600), started: false, chunk: [], size: 0 }) : null;
  // Called only when there is a save.
  const flush = () => { const s = /** @type {Save} */ (save); fs.writeSync(s.fd, s.chunk.join('')); s.chunk = []; s.size = 0; };
  const write = line => {
    const s = /** @type {Save} */ (save);
    s.chunk.push(`${s.started ? ',\n' : '{"traceEvents":[\n'}${line}`);
    s.started = true;
    s.size += line.length;
    if (s.size > 1 << 20) flush();
  };
  // DevTools finds the tab's renderer from these, which a trace of the whole browser leaves out.
  if (save && started) {
    const [first, ...later] = [...pids].map(pid => [pid, firstSeen.get(pid)]).sort((a, b) => a[1] - b[1]);
    if (first) {
      write(JSON.stringify({ ...started, args: { data: { frameTreeNodeId: 0, persistentIds: true, frames: [{ frame: frameId, url, name: '', processId: first[0] }] } } }));
      for (const [pid, ts] of later) {
        write(JSON.stringify({ ...started, name: 'FrameCommittedInBrowser', ts, args: { data: { frame: frameId, url, name: '', processId: pid } } }));
      }
    }
  }
  try {
    await eachLine(file, line => {
      const pid = field(line, 'pid');
      if (!pids.has(pid)) return;
      if (save) write(line);
      const name = nameOf(line);
      const main = mainOf.get(pid) === field(line, 'tid');
      if (main && timedOnly(name)) {
        if (line.includes('"ph":"X"')) tracks.main.push(name, field(line, 'ts'), field(line, 'dur') || 0, null);
        return;
      }
      if (!PARSED.has(name)) return;
      let e;
      try { e = JSON.parse(line); } catch { return; }
      collect(e, tracks, { frameId, main, compositor: compositorOf.get(pid) === e.tid });
    });
    if (save) {
      if (!save.started) save.chunk.push('{"traceEvents":[');
      save.chunk.push('\n]}\n');
      flush();
    }
  } finally {
    if (save) fs.closeSync(save.fd);
  }
  if (!pids.size) return null;
  return analyse(tracks, t0, Math.max(lastTs, t0), { cpu });
}

// The main thread's events, kept compact: a busy page makes hundreds of thousands in a minute (a style
// recalculation and a paint per element it changes). Their times and names in typed arrays; the few
// details the summary names (a script, an event's type, a forced layout's stack) beside them.
class Events {
  constructor() {
    this.n = 0;
    this.ts = new Float64Array(1024);
    this.dur = new Float64Array(1024);
    this.code = new Uint8Array(1024);
    this.names = [];
    this.codes = new Map();
    this.details = new Map();
  }

  push(name, ts, dur, detail) {
    if (this.n === this.ts.length) {
      for (const key of ['ts', 'dur', 'code']) {
        const grown = new this[key].constructor(this.n * 2);
        grown.set(this[key]);
        this[key] = grown;
      }
    }
    if (!this.codes.has(name)) { this.codes.set(name, this.names.length); this.names.push(name); }
    this.ts[this.n] = ts;
    this.dur[this.n] = dur;
    this.code[this.n] = this.codes.get(name);
    if (detail) this.details.set(this.n, detail);
    this.n += 1;
  }

  name(i) {
    return this.names[this.code[i]];
  }
}

function collect(e, tracks, { frameId, main, compositor }) {
  const data = e.args?.data;
  if (main && e.ph === 'X' && (RUN_TASK.has(e.name) || bucketOf(e.name) || TRIGGERS[e.name] || e.name === 'ParseHTML')) {
    /** @type {object | null} */
    let detail = null;
    if (e.name === 'FunctionCall' || e.name === 'EvaluateScript') detail = { frame: { url: data?.url, lineNumber: data?.lineNumber, functionName: data?.functionName } };
    if (e.name === 'EventDispatch') detail = { type: data?.type };
    // A style recalculation or layout with the page's script on the stack: one the script waited for (pw-repl's
    // own scripts have no URL).
    if ((e.name === 'Layout' || e.name === 'UpdateLayoutTree') && e.args?.beginData?.stackTrace?.[0]?.url) detail = { stack: e.args.beginData.stackTrace[0] };
    tracks.main.push(e.name, e.ts, e.dur || 0, detail);
  }
  if (e.name === 'EventTiming' && e.ph === 'b' && data?.interactionId && frameOf(e) === frameId) {
    const list = tracks.timings.get(data.interactionId) || [];
    list.push({ ts: e.ts, ...data });
    tracks.timings.set(data.interactionId, list);
  }
  if (compositor && e.name === 'PipelineReporter' && e.ph === 'b') {
    const state = e.args?.frame_reporter?.state;
    if (state && state !== 'STATE_NO_UPDATE_DESIRED') tracks.frames.push({ ts: e.ts, dropped: state === 'STATE_DROPPED' });
  }
  if (e.name === 'ResourceSendRequest' && data?.requestId) tracks.requests.set(data.requestId, { url: data.url, method: data.requestMethod, sent: e.ts });
  if (e.name === 'ResourceFinish' && data?.requestId) {
    const request = tracks.requests.get(data.requestId);
    // One from the cache has no encoded length.
    if (request) Object.assign(request, { finished: e.ts, size: Math.max(data.encodedDataLength || 0, data.decodedBodyLength || 0), failed: data.didFail });
  }
  const isMain = data?.isOutermostMainFrame ?? data?.isMainFrame;
  if (e.name === 'MarkDOMContent' && isMain && frameOf(e) === frameId) tracks.marks.DOMContentLoaded ??= e.ts;
  if (e.name === 'MarkLoad' && isMain && frameOf(e) === frameId) tracks.marks.load ??= e.ts;
  if (e.name === 'navigationStart' && frameOf(e) === frameId) tracks.marks.navigation ??= e.ts;
  if (e.name === 'firstContentfulPaint' && frameOf(e) === frameId) tracks.marks['first contentful paint'] ??= e.ts;
  if (e.name === 'largestContentfulPaint::Candidate' && frameOf(e) === frameId) tracks.marks['largest contentful paint'] = e.ts;
  // The JS sampling profile of a thread: its call tree and samples, in chunks after a Profile event
  // on the thread it samples.
  if ((e.name === 'Profile' || e.name === 'ProfileChunk') && e.id) {
    const profile = tracks.profiles.get(`${e.pid}:${e.id}`) || { nodes: new Map(), samples: [], deltas: [] };
    if (e.name === 'Profile') Object.assign(profile, { main, startTime: data?.startTime });
    const cpu = data?.cpuProfile;
    for (const node of cpu?.nodes || []) profile.nodes.set(node.id, { ...node.callFrame, parent: node.parent });
    for (const id of cpu?.samples || []) profile.samples.push(id);
    for (const delta of data?.timeDeltas || []) profile.deltas.push(delta);
    tracks.profiles.set(`${e.pid}:${e.id}`, profile);
  }
}

// The main thread's events nested as they ran: the order they started in, each one's own time (less
// its children's), and its top-level task. A task's events follow it in that order, up to its end.
function nest(events) {
  const { n, ts, dur } = events;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => ts[a] - ts[b] || dur[b] - dur[a]);
  const self = Float64Array.from(dur.subarray(0, n));
  const taskOf = new Int32Array(n).fill(-1);
  const tasks = [];
  const stack = [];
  for (let p = 0; p < n; p++) {
    const i = order[p];
    while (stack.length && ts[stack[stack.length - 1]] + dur[stack[stack.length - 1]] <= ts[i]) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent !== undefined) { self[parent] -= Math.min(dur[i], ts[parent] + dur[parent] - ts[i]); taskOf[i] = taskOf[parent]; }
    else if (RUN_TASK.has(events.name(i))) { taskOf[i] = i; tasks.push({ i, p, ts: ts[i], dur: dur[i] }); }
    stack.push(i);
  }
  for (const task of tasks) {
    let p = task.p + 1;
    while (p < n && ts[order[p]] < task.ts + task.dur) p++;
    task.end = p;
  }
  return { order, self, taskOf, tasks };
}

// The main thread's JS samples in time order: when each was taken, how long it stands for, and the
// page's function it was in (an index into keys), -1 for none.
function mainSamples(profiles) {
  const keys = [];
  const keyIndex = new Map();
  const taken = [];
  for (const { main, startTime, nodes, samples: ids, deltas } of profiles.values()) {
    if (!main || startTime == null) continue;
    const scriptOf = new Map();
    let t = startTime;
    for (let i = 0; i < ids.length; i++) {
      t += deltas[i] ?? 0;
      if (!scriptOf.has(ids[i])) {
        const frame = scriptFrame(nodes, nodes.get(ids[i]));
        const key = frame ? where(frame, true) : null;
        if (key !== null && !keyIndex.has(key)) { keyIndex.set(key, keys.length); keys.push(key); }
        scriptOf.set(ids[i], key === null ? -1 : keyIndex.get(key));
      }
      const frame = nodes.get(ids[i]);
      taken.push(t, scriptOf.get(ids[i]), cpuKey(frame, scriptFrame(nodes, frame), keyIndex, keys));
    }
  }
  const count = taken.length / 3;
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort((a, b) => taken[a * 3] - taken[b * 3]);
  const samples = { t: new Float64Array(count), us: new Float64Array(count), script: new Int32Array(count), own: new Int32Array(count), keys };
  for (let k = 0; k < count; k++) {
    samples.t[k] = taken[order[k] * 3];
    samples.script[k] = taken[order[k] * 3 + 1];
    samples.own[k] = taken[order[k] * 3 + 2];
  }
  // Samples can come out of order (a negative delta); each stands for the time until the next one,
  // but no more than a few intervals, so one before a pause does not take the pause.
  for (let k = 0; k < count; k++) samples.us[k] = k + 1 < count ? Math.min(samples.t[k + 1] - samples.t[k], 2000) : 0;
  return samples;
}

// The function a sample itself was in, for --cpu's list: a built-in with the page's function that
// called it; -1 for idle, and for code not the page's (pw-repl's own, run in the page, has no URL).
function cpuKey(frame, script, keyIndex, keys) {
  if (!frame || /^\((?:idle|program|root)\)$/.test(frame.functionName)) return -1;
  let key;
  if (frame.url) key = where(frame, true);
  else if (frame.functionName === '(garbage collector)') key = frame.functionName;
  else if (script) key = `${frame.functionName || '(anonymous)'} (built-in, from ${where(script, true)})`;
  else return -1;
  if (!keyIndex.has(key)) { keyIndex.set(key, keys.length); keys.push(key); }
  return keyIndex.get(key);
}

// The page's own function a sample was in: a built-in (performance.now, JSON.parse) counts as the
// function that called it.
function scriptFrame(nodes, frame) {
  for (let f = frame, depth = 0; f && depth < 200; f = nodes.get(f.parent), depth++) if (f.url) return f;
  return null;
}

// The page's function that ran longest itself between two times, from the samples.
function hottest(samples, from, to) {
  const self = new Map();
  for (let k = lowerBound(samples.t, from); k < samples.t.length && samples.t[k] < to; k++) {
    if (samples.script[k] < 0) continue;
    self.set(samples.script[k], (self.get(samples.script[k]) || 0) + samples.us[k]);
  }
  const [top] = [...self].sort((a, b) => b[1] - a[1]);
  return top ? { where: samples.keys[top[0]], us: top[1] } : null;
}

function lowerBound(times, t) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
}

function analyse(tracks, t0, tEnd, { cpu }) {
  const events = tracks.main;
  const nested = nest(events);
  const samples = mainSamples(tracks.profiles);
  const buckets = Object.fromEntries(BUCKETS.map(b => [b, 0]));
  for (let i = 0; i < events.n; i++) {
    if (nested.taskOf[i] < 0) continue;
    buckets[bucketOf(events.name(i)) || 'other'] += Math.max(0, nested.self[i]);
  }
  const busy = nested.tasks.reduce((sum, t) => sum + t.dur, 0);
  const big = [...tracks.requests.values()].filter(r => r.finished && !r.failed && r.size >= BIG_REQUEST).sort((a, b) => a.finished - b.finished);
  const longTasks = nested.tasks.filter(t => t.dur >= LONG_TASK).map(t => ({ ...describeTask(t, events, nested, big), hot: hottest(samples, t.ts, t.ts + t.dur) }));
  const forced = new Map();
  for (const [i, detail] of events.details) {
    if (!detail.stack) continue;
    const kind = events.name(i) === 'Layout' ? 'layout' : 'style';
    const key = `${where(detail.stack)} (${kind})`;
    const entry = forced.get(key) || { where: key, count: 0, dur: 0 };
    entry.count += 1;
    entry.dur += events.dur[i];
    forced.set(key, entry);
  }
  return {
    t0, duration: tEnd - t0, busy, buckets,
    marks: Object.entries(tracks.marks).sort((a, b) => a[1] - b[1]),
    longTasks,
    forced: [...forced.values()].sort((a, b) => b.dur - a.dur),
    steps: steps(tracks, events, nested),
    cpu: cpu ? cpuTop(samples) : null,
    frames: tracks.frames.length,
  };
}

function describeTask(task, events, { order, self }, big) {
  const own = {};
  let trigger = null;
  let script = null;
  for (let p = task.p; p < task.end; p++) {
    const i = order[p];
    const name = events.name(i);
    const b = bucketOf(name) || 'other';
    own[b] = (own[b] || 0) + Math.max(0, self[i]);
    // One task can dispatch several events (pointerdown, mousedown, click): the one that took longest.
    if ((name === 'EventDispatch' || TRIGGERS[name] || name === 'EvaluateScript') && (!trigger || events.dur[i] > events.dur[trigger])) trigger = i;
    if (events.details.get(i)?.frame?.url && (script === null || events.dur[i] > events.dur[script])) script = i;
  }
  const kind = Object.entries(own).sort((a, b) => b[1] - a[1])[0][0];
  const triggerName = trigger === null ? null : events.name(trigger);
  const triggerText = triggerName === null ? null : triggerName === 'EventDispatch' ? `${events.details.get(trigger).type} event` : triggerName === 'EvaluateScript' ? 'script' : TRIGGERS[triggerName];
  const after = big.filter(r => r.finished <= task.ts && task.ts - r.finished < 1000000).pop() || null;
  return { ts: task.ts, dur: task.dur, kind, trigger: triggerText, script: script === null ? null : where(events.details.get(script).frame), after };
}

// Each step of the user's: an interaction (click, key), a burst of wheel or scroll events, or a drag
// (pointer down, moves, up), with what the page did in it. Interactions inside a drag are its own.
function steps(tracks, events, { taskOf, tasks }) {
  const found = [];
  const dispatches = [...events.details].filter(([, d]) => d.type).map(([i, d]) => ({ ts: events.ts[i], dur: events.dur[i], type: d.type, task: taskOf[i] })).sort((a, b) => a.ts - b.ts);
  // A step starts with the task its first event ran in.
  const began = e => (e.task >= 0 ? events.ts[e.task] : e.ts);
  /** @type {{ kind: string, start: number, end: number, events: number, wheel: boolean } | null} */
  let burst = null;
  for (const e of dispatches.filter(d => /^(?:wheel|mousewheel|scroll)$/.test(d.type))) {
    const wheel = e.type !== 'scroll';
    if (burst && e.ts - burst.end <= STEP_GAP) { burst.end = e.ts + e.dur; burst.events += 1; burst.wheel ||= wheel; continue; }
    burst = { kind: 'wheel/scroll', start: began(e), end: e.ts + e.dur, events: 1, wheel };
    found.push(burst);
  }
  /** @type {typeof dispatches[number] | null} */
  let down = null;
  let moves = 0;
  for (const e of dispatches) {
    if (/^(?:pointerdown|mousedown|touchstart)$/.test(e.type)) { if (!down) { down = e; moves = 0; } }
    else if (down && /^(?:pointermove|mousemove|touchmove)$/.test(e.type)) moves += 1;
    else if (down && /^(?:pointerup|mouseup|touchend|pointercancel|touchcancel)$/.test(e.type)) {
      if (moves >= 3) found.push({ kind: 'drag', start: began(down), end: e.ts + e.dur, events: moves });
      down = null;
    }
  }
  // An interaction's latency is its slowest event's, to the paint after it, as DevTools has it; a key's
  // keydown and keyup share an interaction but not a frame. It is split over the events shown in that
  // frame (pointerup and click): input delay to the first handler, handlers to the last one's end,
  // presentation from then to the paint.
  const drags = found.filter(s => s.kind === 'drag');
  for (const list of tracks.timings.values()) {
    const ts = Math.min(...list.map(t => t.ts));
    const end = Math.max(...list.map(t => t.ts + t.duration * 1000));
    if (drags.some(s => ts <= s.end && end >= s.start)) continue;
    const slowest = list.reduce((a, b) => (b.duration > a.duration ? b : a));
    const painted = slowest.timeStamp + slowest.duration;
    const frame = list.filter(t => Math.abs(t.timeStamp + t.duration - painted) < 8);
    const startAt = Math.min(...frame.map(t => t.timeStamp));
    const processingStart = Math.min(...frame.map(t => t.processingStart));
    const processingEnd = Math.max(...frame.map(t => t.processingEnd));
    const latency = slowest.duration;
    const type = list.some(t => /^key/.test(t.type)) ? 'key press' : list.some(t => /click|pointer|mouse/.test(t.type)) ? 'click' : list[0].type;
    found.push({
      kind: type, start: ts, end, latency,
      delay: processingStart - startAt, handlers: processingEnd - processingStart,
      presentation: Math.max(0, latency - (processingEnd - startAt)),
    });
  }
  // A page gets scroll events for any scroll, not only input: a click's scroll into view (dispatched in
  // the frame after it, or before it when the click waited a frame) or its handler's scrollTo. Scroll
  // events with no wheel event next to a click or key press are that step's.
  for (const burst of found.filter(s => s.kind === 'wheel/scroll' && !s.wheel)) {
    const step = found.find(s => s.latency != null && burst.start <= s.end + STEP_TAIL && burst.end >= s.start - STEP_TAIL);
    if (!step) continue;
    step.scrolled = true;
    step.end = Math.max(step.end, burst.end);
    found.splice(found.indexOf(burst), 1);
  }
  found.sort((a, b) => a.start - b.start);
  const taskStarts = tasks.map(t => t.ts);
  const frames = tracks.frames.sort((a, b) => a.ts - b.ts);
  const frameTimes = frames.map(f => f.ts);
  for (const [i, step] of found.entries()) {
    // Up to the next step, which what follows is counted in.
    const end = Math.max(step.end, Math.min(step.end + STEP_TAIL, found[i + 1]?.start ?? Infinity));
    step.busy = 0;
    step.longest = 0;
    // Tasks in start order; one that began before the step and runs into it counts its part.
    for (let k = Math.max(0, lowerBound(taskStarts, step.start) - 1); k < tasks.length && tasks[k].ts < end; k++) {
      const t = tasks[k];
      if (t.ts + t.dur <= step.start) continue;
      step.busy += Math.min(t.ts + t.dur, end) - Math.max(t.ts, step.start);
      if (t.ts >= step.start) step.longest = Math.max(step.longest, t.dur);
    }
    step.frames = 0;
    step.dropped = 0;
    let first = lowerBound(frameTimes, step.start);
    // A scroll's own frame comes before its scroll event: the last frame before it, if close and not
    // the step before's.
    if (step.kind === 'wheel/scroll' && first > 0) {
      const before = frames[first - 1].ts;
      if (step.start - before <= SCROLL_LEAD && before > (found[i - 1]?.start ?? -Infinity)) first -= 1;
    }
    for (let k = first; k < frames.length && frames[k].ts < end; k++) {
      step.frames += 1;
      if (frames[k].dropped) step.dropped += 1;
    }
  }
  return found;
}

// The functions that ran longest themselves, from the sampling profile's samples.
function cpuTop(samples) {
  const self = new Map();
  for (let k = 0; k < samples.t.length; k++) {
    if (samples.own[k] < 0) continue;
    self.set(samples.own[k], (self.get(samples.own[k]) || 0) + samples.us[k]);
  }
  return [...self].map(([key, us]) => ({ where: samples.keys[key], us })).sort((a, b) => b.us - a.us);
}

module.exports = { summarize, eachEvent, LONG_TASK };
