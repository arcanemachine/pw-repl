const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const help = require('../lib/help');
const { commands, complete } = require('../lib/commands');
const { compactSnapshot, grepSnapshot } = require('../lib/inspect');
const { summarizeChanges, scrubEditable } = require('../lib/watch');
const { clock, parseDuration, durationText, longDuration } = require('../lib/util');
const { parseEndpoint, looksLikeEndpoint, DEFAULT_SOCKET } = require('../lib/client');

describe('help', () => {
  const names = Object.keys(commands);
  const listed = Object.values(help.TOPICS).flatMap(t => t.commands);

  it('covers every command, each under exactly one topic', () => {
    for (const name of names) {
      assert.ok(help.COMMANDS[name], `${name} has no help entry`);
      assert.equal(listed.filter(n => n === name).length, 1, `${name} should be in one topic`);
    }
    assert.deepEqual(Object.keys(help.COMMANDS).filter(n => !names.includes(n)), [], 'help for commands that do not exist');
  });

  it('starts with common tasks, and names only commands that exist', () => {
    assert.match(help.render(), /^[^\n]+\n[^\n]+\n\nCommon tasks:\n  see where I am /);
    const named = help.TASKS.flatMap(([, commands]) => commands.split(/, (?:click around, )?(?:then )?|; /)).map(part => part.split(' ')[0]);
    // pw-repl send --file is the command line's, not the REPL's.
    for (const name of named) assert.ok(name === 'pw-repl' || Object.hasOwn(help.COMMANDS, name), name);
  });

  it('names every topic in the overview', () => {
    for (const topic of Object.keys(help.TOPICS)) assert.match(help.render(), new RegExp(`(\\n  |   )${topic} `));
  });

  it('renders topics and commands, and nothing for unknown names', () => {
    assert.match(help.render('network'), /route <glob>/);
    assert.match(help.render('network'), /\n\nnetwork is also a command: help network --command$/, 'a topic and a command of the same name');
    assert.doesNotMatch(help.render('network'), /dev proxy/, 'the command\'s help is not run into the topic');
    assert.match(help.render('network --command'), /^network \[on\|off\|slow [^\n]*— [\s\S]*dev proxy/);
    assert.match(help.render('route'), /^route <glob> <how> \| off <glob>\|--all — [\s\S]*<glob> patch <json>/);
    assert.equal(help.render('nope'), null);
    assert.equal(help.notFound('swipe'), 'swipe is touch swipe: help touch', 'an action of touch, found under it');
    assert.equal(help.notFound('up'), 'up is mouse up: help mouse', 'one of a | pair');
    assert.match(help.notFound('nope'), /^No help for nope\. Topics: /);
    // A command's rarer details: a pointer to them, and all of it with --all.
    assert.match(help.render('record'), /\nMore, on [^\n]+[\s\S]*help record --all\.$/);
    assert.doesNotMatch(help.render('record'), /no --mp4 or --webm/);
    assert.match(help.render('record --all'), /no --mp4 or --webm/);
    assert.doesNotMatch(help.render('record --all'), /More, on/);
    assert.match(help.render('--all'), /no --mp4 or --webm/);
    assert.match(help.render('video-start'), /^video-start is playwright-cli's name for record on \[file\.webm\|file\.mp4\]; --filename=<file> is the file\shere\.\n\nrecord \[on/, 'a playwright-cli name, with the command it runs');
    assert.match(help.render('video-chapter'), /^video-chapter is playwright-cli's; not here/);
  });

  it('fits a normal-width pane', () => {
    const views = [help.render(), help.render('--all'), help.render('playwright-cli'), ...Object.keys(help.TOPICS).map(help.render), ...Object.keys(help.COMMANDS).map(help.render)];
    for (const line of views.join('\n').split('\n')) assert.ok(line.length <= 110, `${line.length} chars: ${line}`);
  });

  it('prints every topic and every command in full with --all', () => {
    const all = help.render('--all');
    for (const topic of Object.keys(help.TOPICS)) assert.match(all, new RegExp(`== ${topic} ==`));
    for (const [name, entry] of Object.entries(help.COMMANDS)) {
      assert.ok(all.includes(entry.usage), `${name} usage missing`);
      for (const line of (entry.detail || '').split('\n').filter(Boolean)) assert.ok(all.includes(line), `${name} detail missing`);
    }
  });

  // A saved copy, so a change to how the entries are written (not what they say) shows as a diff.
  // After an intended change to the help, save it again:
  //   node -e "const fs=require('fs'),h=require('./lib/help');for(const v of ['--all','playwright-cli','video'])fs.writeFileSync('test/fixtures/help'+(v==='--all'?'-all':'-'+v)+'.txt',h.render(v)+'\n')"
  it('lists the same common tasks and modes as the README', () => {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const table = readme.slice(readme.indexOf('| I want to'), readme.indexOf('\n\n', readme.indexOf('| I want to')));
    const rows = table.split('\n').slice(2).map(row => row.split('|').slice(1, -1).map(cell => cell.trim().replace(/`/g, '')));
    assert.deepEqual(rows, help.TASKS);
    const modes = /Some commands turn on a mode that stays on until you turn it off: ([^.]*)\./.exec(readme)[1];
    assert.equal(modes.replace(/`/g, '').replace(/\s+/g, ' '), help.MODES);
  });

  it('renders exactly as saved in test/fixtures', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    for (const [view, file] of [['--all', 'help-all.txt'], ['playwright-cli', 'help-playwright-cli.txt'], ['video', 'help-video.txt']]) {
      const saved = fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8');
      // By line, so a failure shows the lines that differ.
      assert.deepEqual(`${help.render(view)}\n`.split('\n'), saved.split('\n'), `help ${view} differs from test/fixtures/${file}; if the change is intended, save it again (see above)`);
    }
  });
});

describe('modules', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const lib = path.join(__dirname, '..', 'lib');

  it('names only commands that exist in the runner\'s lists', () => {
    const { READ_ONLY, INSPECTION, NO_TAB_NEEDED } = require('../lib/runner');
    const { cliCommands } = require('../lib/commands');
    for (const [list, names] of Object.entries({ READ_ONLY, INSPECTION, NO_TAB_NEEDED })) {
      for (const name of names) assert.ok(Object.hasOwn(commands, name) || Object.hasOwn(cliCommands, name), `${list} has ${name}, which is not a command`);
    }
  });

  // A require cycle fails silently in CommonJS: one module gets the other's exports half made.
  // Each module is loaded on its own, with lib/ cleared from the cache first (no module sets
  // anything outside lib/ when loaded), and the requires made while loading must not go round.
  it('loads each lib module on its own, with exports and no require cycle', () => {
    const inLib = (/** @type {string} */ id) => path.dirname(id) === lib;
    const kept = Object.entries(require.cache).filter(([id]) => inLib(id));
    const clear = () => { for (const id of Object.keys(require.cache)) if (inLib(id)) delete require.cache[id]; };
    try {
      for (const file of fs.readdirSync(lib).filter(f => f.endsWith('.js'))) {
        clear();
        const exported = Object.keys(require(path.join(lib, file)));
        assert.ok(exported.length, `${file} exports nothing`);
        /** @type {Record<string, string[]>} */
        const graph = {};
        for (const [id, m] of Object.entries(require.cache)) {
          if (inLib(id) && m) graph[path.basename(id)] = m.children.map(c => c.id).filter(inLib).map(c => path.basename(c));
        }
        const visit = (/** @type {string} */ name, /** @type {string[]} */ trail) => {
          assert.ok(!trail.includes(name), `require cycle: ${[...trail, name].join(' -> ')}`);
          for (const next of graph[name] || []) visit(next, [...trail, name]);
        };
        visit(file, []);
      }
    } finally {
      // Later tests keep the modules they loaded before.
      clear();
      Object.assign(require.cache, Object.fromEntries(kept));
    }
  });
});

describe('times', () => {
  it('reads milliseconds, or seconds with an s, and says them back', () => {
    assert.equal(parseDuration('1500'), 1500);
    assert.equal(parseDuration('1.5s'), 1500);
    assert.equal(parseDuration('250ms'), 250);
    assert.equal(parseDuration('soon'), null);
    assert.equal(durationText(1500), '1.5s');
    assert.equal(durationText(250), '250ms');
  });

  it('says a time under a second, where one must be longer, is milliseconds', () => {
    assert.equal(longDuration('30s', 'x'), 30000);
    assert.equal(longDuration('30000', 'x'), 30000);
    assert.throws(() => longDuration('30', 'capture on\'s time'), { message: 'capture on\'s time is in milliseconds, 1000 or more: 30 is 30ms; 30s for seconds' });
  });
});

describe('playwrightBrowsersDir', () => {
  // Agreeing with playwright-core on whichever platform the tests run on is what finds its ffmpeg and
  // Chromium there: ~/Library/Caches on macOS, ~/.cache on Linux.
  it('is where playwright-core installs its browsers', () => {
    const { playwrightBrowsersDir } = require('../lib/util');
    const dir = playwrightBrowsersDir();
    assert.ok(require('playwright-core').chromium.executablePath().startsWith(dir + path.sep), dir);
  });
});

describe('record', () => {
  it('refuses without an ffmpeg, and says how to get one', () => {
    const { findFfmpeg } = require('../lib/record');
    const saved = { PATH: process.env.PATH, PW_FFMPEG: process.env.PW_FFMPEG, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH };
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-repl-no-ffmpeg-'));
    try {
      Object.assign(process.env, { PATH: empty, PLAYWRIGHT_BROWSERS_PATH: empty });
      delete process.env.PW_FFMPEG;
      assert.throws(() => findFfmpeg('webm'), /^Error: record needs ffmpeg, and none was found: npx playwright-core install ffmpeg/);
      assert.throws(() => findFfmpeg('mp4'), /^Error: record needs ffmpeg, and none was found: an \.mp4 needs ffmpeg from your system's packages, with H\.264/);
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
  it('uses PW_FFMPEG and no other when it is set, and says why it cannot', () => {
    const { findFfmpeg } = require('../lib/record');
    const saved = process.env.PW_FFMPEG;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-repl-ffmpeg-'));
    const fake = (name, script) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      return file;
    };
    const use = file => { process.env.PW_FFMPEG = file; };
    try {
      use(path.join(dir, 'missing'));
      assert.throws(() => findFfmpeg('webm'), /^Error: PW_FFMPEG=\S+missing cannot be used: not found$/);
      use(fake('plain', 'exit 0'));
      fs.chmodSync(process.env.PW_FFMPEG, 0o644);
      assert.throws(() => findFfmpeg('webm'), /cannot be used: not executable$/);
      use(fake('webm-only', 'echo " V....D libvpx  VP8"'));
      assert.equal(findFfmpeg('webm'), process.env.PW_FFMPEG);
      assert.throws(() => findFfmpeg('mp4'), /^Error: PW_FFMPEG=\S+webm-only cannot write MP4 \(H\.264\): its -encoders lists no libx264$/, 'no other ffmpeg in its place');
      // A probe that failed is tried again, not remembered as an ffmpeg with no encoders.
      const tried = path.join(dir, 'tried');
      use(fake('flaky', `[ -f ${tried} ] || { touch ${tried}; exit 1; }\necho " V....D libvpx  VP8"`));
      assert.throws(() => findFfmpeg('webm'), /cannot be used: -encoders failed \(exit 1\)$/);
      assert.equal(findFfmpeg('webm'), process.env.PW_FFMPEG);
    } finally {
      if (saved === undefined) delete process.env.PW_FFMPEG; else process.env.PW_FFMPEG = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('server endpoints', () => {
  it('defaults to the shared socket', () => {
    assert.deepEqual(parseEndpoint(''), { socket: DEFAULT_SOCKET });
  });

  it('treats ports and loopback host:port as TCP', () => {
    assert.deepEqual(parseEndpoint('9230'), { host: '127.0.0.1', port: 9230 });
    assert.deepEqual(parseEndpoint('localhost:9230'), { host: 'localhost', port: 9230 });
    assert.deepEqual(parseEndpoint('[::1]:9230'), { host: '::1', port: 9230 });
  });

  it('refuses addresses other than loopback', () => {
    assert.throws(() => parseEndpoint('0.0.0.0:9230'), /non-loopback/);
    assert.throws(() => parseEndpoint('10.0.0.5:9230'), /non-loopback/);
  });

  it('treats anything else as a socket path', () => {
    assert.deepEqual(parseEndpoint('/tmp/x.sock'), { socket: '/tmp/x.sock' });
  });

  it('tells an endpoint apart from a start URL', () => {
    for (const value of ['9230', '127.0.0.1:9230', '/tmp/x.sock', './x.sock']) assert.ok(looksLikeEndpoint(value), value);
    for (const value of ['http://localhost:3000', 'https://example.com/a.sock', 'example.com']) assert.ok(!looksLikeEndpoint(value), value);
  });
});

describe('tab completion', () => {
  it('completes command names', () => {
    assert.deepEqual(complete('rou'), [['route'], 'rou']);
    assert.deepEqual(complete('snap'), [['snapshot'], 'snap']);
  });

  it('offers every command on an empty line', () => {
    assert.deepEqual(complete('')[0], Object.keys(commands).sort());
  });

  it('completes the fixed words commands take', () => {
    assert.deepEqual(complete('help net'), [['network'], 'net']);
    assert.deepEqual(complete('tab n'), [['new'], 'n']);
    assert.deepEqual(complete('network o'), [['on', 'off'], 'o']);
    assert.deepEqual(complete('network s'), [['slow'], 's']);
    assert.deepEqual(complete('emulate l'), [['light', 'locale'], 'l']);
    assert.deepEqual(complete('emulate dark o'), [['off'], 'o']);
    assert.deepEqual(complete('wait l'), [['load'], 'l']);
    assert.deepEqual(complete('watch n'), [['new'], 'n']);
    assert.deepEqual(complete('watch on --c'), [['--changes'], '--c']);
    assert.deepEqual(complete('watch on --changes --'), [['--live', '--next-tab'], '--']);
    assert.deepEqual(complete('capture o'), [['on', 'off'], 'o']);
    assert.deepEqual(complete('route o'), [['off'], 'o']);
    assert.deepEqual(complete('modes o'), [['off'], 'o']);
    assert.deepEqual(complete('route off --a'), [['--all'], '--a']);
    assert.deepEqual(complete('capture on r'), [['requests'], 'r']);
  });

  it('offers nothing where arguments are free-form', () => {
    assert.deepEqual(complete('click #g'), [[], '#g']);
  });
});

describe('compact snapshot', () => {
  it('drops unnamed wrappers, lifts their children, and keeps everything named', () => {
    const full = [
      '- generic [active] [ref=e1]:',
      '  - generic [ref=e2]:',
      '    - link "FAQ" [ref=e3] [cursor=pointer]:',
      '      - /url: /faqs',
      '      - generic [ref=e4]: FAQ',
      '  - button "Go" [ref=e5]',
      '- heading "Title" [level=1] [ref=e6]',
    ].join('\n');
    assert.equal(compactSnapshot(full), [
      '- link "FAQ" [ref=e3]:',
      '  - /url: /faqs',
      '  - generic [ref=e4]: FAQ',
      '- button "Go" [ref=e5]',
      '- heading "Title" [level=1] [ref=e6]',
    ].join('\n'));
  });
});

describe('snapshot grep', () => {
  it('prints each hit with its named ancestors, skipping unnamed wrappers and their refs', () => {
    const text = [
      '- main [ref=e1]:',
      '  - generic [ref=e2]:',
      '    - region "Results" [ref=e3]:',
      '      - button "Refresh Results" [disabled] [ref=e4]',
      '- button "Other" [ref=e5]',
    ].join('\n');
    assert.deepEqual(grepSnapshot(text, 'DISABLED'), ['main › region "Results" › button "Refresh Results" [disabled] [ref=e4]']);
    assert.deepEqual(grepSnapshot(text, 'other'), ['button "Other" [ref=e5]']);
    assert.deepEqual(grepSnapshot(text, 'nope'), []);
  });

  it('keeps the ref of what holds a hit that has none of its own', () => {
    const text = ['- main [ref=e1]:', '  - paragraph [ref=e2]:', '    - text: "Total:"', '    - strong [ref=e3]: 3,105.75'].join('\n');
    assert.deepEqual(grepSnapshot(text, 'total'), ['main › paragraph [ref=e2] › text: "Total:"']);
  });
});

describe('snapshot changes', () => {
  const before = [
    '- banner [ref=e1]:',
    '  - combobox "Search for resorts" [ref=e2]',
    '  - textbox "Check In" [ref=e3]: 2026-10-09',
    '- dialog "Privacy" [ref=e4]:',
    '  - text: We process your personal information',
    '  - button "Accept All Cookies" [ref=e5]',
    '  - link "More" [ref=e6]:',
    '    - /url: https://example.com/privacy',
  ].join('\n');
  const after = [
    '- banner [ref=e1]:',
    '  - combobox "Search for resorts" [expanded] [active] [ref=e2]: cancun',
    '  - listbox [ref=e7]:',
    '    - option "Cancún Quintana Roo, Mexico" [ref=e8]:',
    '      - generic: Cancún',
    '    - option "Canungra Queensland, Australia" [ref=e9]',
    '    - option "Cancun International (CUN)" [ref=e10]',
    '    - option "Paradisus Cancún" [ref=e11]',
    '  - textbox "Check In" [ref=e3]: 2026-10-12',
  ].join('\n');

  it('shows changed, added and removed elements once each, with what is inside', () => {
    assert.deepEqual(summarizeChanges(before, after), [
      '~ combobox "Search for resorts" [expanded]',
      '+ listbox (4 named inside): option "Cancún Quintana Roo, Mexico", option "Canungra Queensland, Aust…',
      '- dialog "Privacy": We process your personal information, button "Accept All Cookies", link "More"',
    ]);
  });

  it('leaves out field values, focus, refs and link URLs', () => {
    const text = summarizeChanges(before, after).join('\n');
    assert.doesNotMatch(text, /cancun\b|2026|active|ref=|\/url/);
    assert.deepEqual(summarizeChanges(before, before.replace(/\[ref=e\d+\]/g, '[ref=f1e9]')), []);
  });

  it('blanks out the text of editable areas, as text or as a name', () => {
    const text = ['- generic "Draft" [ref=e1]: CESECRET', '- paragraph: my private draft', '- button "Go"', '  - text: CESECRET'].join('\n');
    assert.equal(scrubEditable(text, ['CESECRET', 'my private draft']), ['- generic "Draft" [ref=e1]', '- paragraph', '- button "Go"', '  - text'].join('\n'));
    assert.equal(scrubEditable(text, []), text);
  });

  it('caps the lines per step', () => {
    const many = Array.from({ length: 9 }, (_, i) => `- button "B${i}"`).join('\n');
    const lines = summarizeChanges('', many);
    assert.equal(lines.length, 6);
    assert.equal(lines[5], '… 4 more changes');
  });
});

describe('action timeouts', () => {
  const { onElement } = require('../lib/elements');
  const timedOut = steps => () => Promise.reject(new Error(`page.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('#go')\n    - locator resolved to <button id="go">Go</button>\n  - attempting click action\n${steps.map(step => `    - ${step}`).join('\n')}\n`));
  const quiet = async run => { const log = console.error; console.error = () => {}; try { return await run(); } finally { console.error = log; } };

  it('says a click was sent when the page stopped answering after it, and a busy page when it never got that far', async () => {
    const sent = await quiet(() => onElement('#go', timedOut(['waiting for element to be visible, enabled and stable', 'element is visible, enabled and stable', 'scrolling into view if needed', 'done scrolling', 'performing click action'])).catch(e => e));
    assert.match(sent.message, /^Timed out after 5s on #go: the click was sent, and may have landed, but the page stopped answering after it, likely busy with what it set off\. A profile shows that only if it is on before the action: profile on, then the action again, if repeating it is safe/);
    assert.equal(sent.uncertain, true);
    const waiting = await quiet(() => onElement('#go', timedOut(['waiting for element to be visible, enabled and stable'])).catch(e => e));
    assert.match(waiting.message, /: it never became ready to act on; a page busy with a long task does not answer meanwhile: profile on, then try again/);
  });

  it('is unknown only once input was sent, in any retry', async () => {
    const retry = (blocker, last) => ['waiting for element to be visible, enabled and stable', 'element is visible, enabled and stable', 'scrolling into view if needed', 'done scrolling', blocker, 'retrying click action', 'waiting for element to be visible, enabled and stable', last];
    const sent = await quiet(() => onElement('#go', timedOut(retry('performing click action', 'element is not enabled'))).catch(e => e));
    assert.equal(sent.uncertain, true, 'an earlier retry sent the click');
    const covered = await quiet(() => onElement('#go', timedOut(retry('<div></div> intercepts pointer events', '<div></div> intercepts pointer events'))).catch(e => e));
    assert.equal(covered.uncertain, false, 'a cover is found before the click is sent');
    for (const check of ['element is not enabled', 'element is not visible', 'element is not stable']) {
      const error = await quiet(() => onElement('#go', timedOut(['waiting for element to be visible, enabled and stable', `  - ${check}`])).catch(e => e));
      assert.equal(error.uncertain, false, check);
    }
  });
});

describe('profile summary', () => {
  it('says a step began before the profile, without the busy time it could not record', () => {
    const { printProfile } = require('../lib/profile');
    const t0 = 1e9;
    const step = (start, kind) => ({ kind, start, end: start + 20000, latency: 20, delay: 1, handlers: 2, presentation: 17, busy: 12000, longest: 3000, frames: 2, dropped: 0 });
    const summary = { t0, duration: 2e6, busy: 1e5, buckets: {}, marks: [], longTasks: [], forced: [], steps: [step(t0 - 15e6, 'click'), step(t0 + 5e5, 'key press')], cpu: null };
    const printed = [];
    const log = console.log;
    console.log = text => printed.push(String(text));
    try { printProfile({ url: 'http://x/', startedAt: Date.now(), summary }); } finally { console.log = log; }
    const text = printed.join('\n');
    assert.match(text, /^ +before {2}click {2}20ms to next paint \([^)]*\); began before the profile: its busy time was not recorded, frames 2 drawn, 0 dropped$/m);
    assert.match(text, /^ +\+0\.50s {2}key press {2}20ms to next paint \([^)]*\); busy 12ms, longest task 3ms, frames 2 drawn/m);
  });
});

describe('clock', () => {
  const t = Date.UTC(2026, 8, 25, 0, 16, 15, 721);
  const withZone = (zone, fn) => {
    const saved = process.env.TZ;
    process.env.TZ = zone;
    try { return fn(); } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
  };

  it('prints local time with its offset', () => {
    assert.equal(withZone('America/Edmonton', () => clock(t)), '18:16:15.721-06:00');
    assert.equal(withZone('Asia/Kolkata', () => clock(t)), '05:46:15.721+05:30');
  });

  it('marks UTC explicitly', () => {
    assert.equal(withZone('UTC', () => clock(t)), '00:16:15.721+00:00');
  });
});

describe('key names', () => {
  const { keyName } = require('../lib/syntax');

  it('takes them in any case, as playwright-cli does, in the case Playwright needs', () => {
    assert.equal(keyName('arrowleft'), 'ArrowLeft');
    assert.equal(keyName('control+shift+keya'), 'Control+Shift+KeyA');
    assert.equal(keyName('Control++'), 'Control++');
    assert.equal(keyName('a'), 'a');
    assert.equal(keyName('A'), 'A', 'a single character keeps its case');
    assert.equal(keyName('f5'), 'F5');
  });
});

describe('screenshot files', () => {
  const { SCREENSHOT_FILE } = require('../lib/syntax');

  it('reads a path or an image\'s name as a file, and a selector with a / as a selector', () => {
    for (const word of ['x.png', 'shots/x', './x', '~/x', '/abs/x']) assert.ok(SCREENSHOT_FILE.test(word), word);
    for (const word of ['a[href="/x"]', 'xpath=//a', '//a', 'text=a/b', 'my shots/x', 'shots/a+b']) assert.ok(!SCREENSHOT_FILE.test(word), word);
  });
});

describe('send --file variables', () => {
  const { variablesIn, expandVariables } = require('../lib/syntax');
  const values = { PW_PASSWORD: 'a"b\\c d', PW_WHO: 'Ada' };

  it('fills in {{ PW_NAME }}, padded or not, escaped only in double quotes', () => {
    assert.deepEqual(variablesIn('fill #pw "{{ PW_PASSWORD }}" {{PW_WHO}} {{ PW_PASSWORD }}'), ['PW_PASSWORD', 'PW_WHO']);
    assert.equal(expandVariables('fill #pw "{{ PW_PASSWORD }}"', values), 'fill #pw "a\\"b\\\\c d"');
    assert.equal(expandVariables("fill '#pw' {{PW_PASSWORD}}", values), 'fill \'#pw\' a"b\\c d');
    assert.equal(expandVariables("eval '{{ PW_WHO }}'", values), "eval 'Ada'", 'single quotes escape nothing');
    assert.throws(() => expandVariables("fill '#pw' '{{ PW_PASSWORD }}'", { PW_PASSWORD: "it's" }), /^Error: \{\{ PW_PASSWORD \}\} holds a ', which single quotes cannot hold: put it in double quotes$/);
  });

  it('leaves alone a template\'s own braces, and any other name, and refuses a PW_ one with no value', () => {
    const page = 'fill #tpl "Hi {{ name }}, {{ GITHUB_TOKEN }} {{ pw_who }}" {{ a.b }} {{}} `${x}`';
    assert.deepEqual(variablesIn(page), []);
    assert.equal(expandVariables(page, { ...values, GITHUB_TOKEN: 'secret', name: 'x' }), page);
    assert.throws(() => expandVariables('fill #x "{{ PW_NOPE }}"', values), /\{\{ PW_NOPE \}\} has no value/);
  });
});

describe('step labels', () => {
  it('name the command and what it acts on, its selector without the quotes it needed, and never a value', () => {
    const { stepLabel } = require('../lib/record');
    assert.equal(stepLabel('check', '"role=checkbox[name=\\"Email me news\\"]"'), 'check role=checkbox[name="Email me news"]');
    assert.equal(stepLabel('click', '"text=Send ticket" right --modifiers=Shift'), 'click text=Send ticket right');
    assert.equal(stepLabel('mouse', 'move 10 20'), 'mouse move 10 20');
    assert.equal(stepLabel('fill', '"text=Your name" Ada'), 'fill text=Your name');
    assert.equal(stepLabel('type', '--delay=0 #name secret'), 'type #name');
  });
});

describe('playwright-cli names', () => {
  const { translate } = require('../lib/cli-names');

  it('rewrites them to the commands that do the same here', () => {
    assert.deepEqual(translate('tab-list'), { text: 'tab', as: 'tab' });
    assert.equal(translate('go-back').text, 'back');
    assert.equal(translate('set-color-scheme dark').text, 'emulate dark');
    assert.equal(translate('network-state-set offline').text, 'network off');
    assert.equal(translate('resize 800 600').text, 'viewport 800x600');
    assert.equal(translate('video-start demo.webm').text, 'record on demo.webm');
    assert.equal(translate('video-stop').text, 'record off');
    assert.equal(translate('unroute').text, 'route off --all');
    assert.equal(translate('route **/slots.json --status=500 --body=\'{"error":"x"}\'').text, 'route **/slots.json 500 {"error":"x"}');
    assert.equal(translate('route **/a --status=503').text, 'route **/a 503');
    assert.equal(translate('route "**/a" --body={"mock": true}').text, 'route **/a 200 {"mock": true}', 'status 200 unless given');
    assert.equal(translate("route **/a --body='not found' --status=404").text, 'route **/a 404 --content-type=text/plain not found');
    assert.equal(translate('route **/a --body=<b>x</b> --content-type=text/html').text, 'route **/a 200 --content-type=text/html <b>x</b>');
    assert.equal(translate('route **/x 200 --content-type=text/plain see --header docs'), null, 'this tool\'s own route, whose body is free text');
  });

  it('leaves this tool\'s own commands alone', () => {
    for (const text of ['tab', 'route **/a 500 {}', 'eval 1+1', 'console error', 'upload #f a.png']) assert.equal(translate(text), null, text);
  });

  it('finds playwright-cli\'s options anywhere on the line, and a body with spaces up to the next one', () => {
    const { takeOptions: take } = require('../lib/cli-names');
    const takeOptions = (args, options) => {
      const { found, rest } = take(args, options);
      return { found: found.map(({ name, value }) => ({ name, value })), rest };
    };
    const spec = { body: 'rest', status: 'value', submit: 'flag', filter: 'value' };
    assert.deepEqual(takeOptions('**/a --body={"mock": true} --status 500', spec), {
      found: [{ name: 'body', value: '{"mock": true}' }, { name: 'status', value: '500' }], rest: '**/a',
    });
    assert.deepEqual(takeOptions('e5 "a  b" --submit', spec), { found: [{ name: 'submit', value: undefined }], rest: 'e5 "a  b"' });
    assert.deepEqual(takeOptions('--filter=/api/ 3', spec), { found: [{ name: 'filter', value: '/api/' }], rest: '3' });
    assert.deepEqual(takeOptions('e5 --submitted', spec), { found: [], rest: 'e5 --submitted' }, 'only its own options');
    assert.deepEqual(takeOptions('--filter="a b" x.com', spec), { found: [{ name: 'filter', value: 'a b' }], rest: 'x.com' }, 'a quoted part holds spaces');
    assert.equal(translate('route **/a --content-type="text/html; charset=utf-8" --body=<p>hi</p>').text, 'route **/a 200 --content-type="text/html; charset=utf-8" <p>hi</p>');
  });

  it('refuses playwright-cli\'s options that are not taken here, rather than read them as words', () => {
    assert.match(translate('snapshot --depth=3').refuse, /^playwright-cli's snapshot --depth is not supported here; snapshot <ref>/);
    assert.match(translate('open example.com --headed').refuse, /pw-repl serve --launch \[--headed\]/);
    assert.match(translate('route **/a --header=x:y').refuse, /route --header is not supported here/);
    assert.equal(translate('snapshot --full'), null, 'this tool\'s own options are left to it');
    assert.equal(translate('find --regex "Total: \\d+"').text, 'snapshot --regex "Total: \\d+"', 'a regexp as typed, backslashes and all');
  });

  // Every command playwright-cli 0.1.21 lists.
  const CLI_COMMANDS = [
    'attach', 'check', 'clear-color-scheme', 'clear-contrast', 'clear-forced-colors', 'clear-media',
    'clear-reduced-motion', 'click', 'close', 'close-all', 'console', 'cookie-clear', 'cookie-delete',
    'cookie-get', 'cookie-list', 'cookie-set', 'dblclick', 'delete-data', 'detach', 'dialog-accept',
    'dialog-dismiss', 'drag', 'drop', 'eval', 'fill', 'find', 'generate-locator', 'go-back', 'go-forward',
    'goto', 'highlight', 'hover', 'install', 'install-browser', 'keydown', 'keyup', 'kill-all', 'list',
    'localstorage-clear', 'localstorage-delete', 'localstorage-get', 'localstorage-list',
    'localstorage-set', 'mousedown', 'mousemove', 'mouseup', 'mousewheel', 'network-state-set', 'open',
    'pause-at', 'pdf', 'press', 'recording-start', 'recording-stop', 'reload', 'request', 'request-body',
    'request-headers', 'requests', 'resize', 'response-body', 'response-headers', 'resume', 'route',
    'route-list', 'run-code', 'screenshot', 'select', 'sessionstorage-clear', 'sessionstorage-delete',
    'sessionstorage-get', 'sessionstorage-list', 'sessionstorage-set', 'set-color-scheme', 'set-contrast',
    'set-forced-colors', 'set-media', 'set-reduced-motion', 'show', 'snapshot', 'state-load',
    'state-save', 'step-over', 'tab-close', 'tab-list', 'tab-new', 'tab-select', 'tracing-start',
    'tracing-stop', 'type', 'uncheck', 'unroute', 'upload', 'video-chapter', 'video-hide-actions',
    'video-show-actions', 'video-start', 'video-stop', 'webmcp-call', 'webmcp-list',
  ];

  it('runs, rewrites or refuses each of playwright-cli\'s commands by name, never as unknown', () => {
    const { commands } = require('../lib/commands');
    for (const name of CLI_COMMANDS) assert.ok(translate(name) || Object.hasOwn(commands, name), name);
    assert.match(translate('drop e1').refuse, /^drop is playwright-cli's and not here yet$/);
    assert.match(translate('close-all').refuse, /not here on purpose: it would close a browser someone else may be using/);
  });

  it('reads and writes storage with eval, as playwright-cli\'s storage commands do', () => {
    assert.equal(translate('localstorage-get "my key"').text, 'eval localStorage.getItem("my key")');
    assert.equal(translate('sessionstorage-set k a b').text, 'eval sessionStorage.setItem("k", "a b"), "Set " + "k"');
    assert.match(translate('localstorage-get my key').refuse, /localstorage-get my key is not understood here; .*; quote a key with spaces: localstorage-get "my key"$/);
    assert.deepEqual(translate('recording-stop').steps, ['watch off', 'watch']);
  });

  it('refuses what it cannot do the same way, with the nearest command', () => {
    assert.match(translate('run-code async page => 1').refuse, /eval <JavaScript>/);
    assert.match(translate('tab-close 2').refuse, /tab <index> then tab close/, 'an index here would be read as part of a URL');
    assert.match(translate('set-color-scheme sepia').refuse, /emulate dark\|light/);
  });
});

describe('skill stamp', () => {
  const { hashOf, current } = require('../lib/skill');
  const text = current().text;

  it('hashes only the skill\'s own text', () => {
    const hash = hashOf(text);
    assert.match(hash, /^[0-9a-f]{8}$/);
    assert.equal(hashOf(text.replace('<!-- pw-repl skill stamp -->', 'This skill is from pw-repl 9.9.9 (skill 12345678).')), hash, 'not its stamp');
    assert.equal(hashOf(text.replace(/No custom rules have been added yet\./, '- Always use tab new.')), hash, 'not the Custom rules the user adds');
    assert.equal(hashOf(text.replace(/\n/g, '\r\n')), hash, 'not its line endings');
    assert.notEqual(hashOf(text.replace('## Start it', '## Start it now')), hash, 'but any change to the skill itself');
  });
});

describe('release check', () => {
  const { spawnSync } = require('node:child_process');

  // What deploy and prepublishOnly run: in a repo of its own, with its own package.json beside it.
  it('passes only at the tagged commit, in a clean tree', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-repl-tagged-'));
    const git = (/** @type {string[]} */ ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' });
    const check = () => spawnSync(process.execPath, ['scripts/check-tagged.js'], { cwd: repo, encoding: 'utf8' });
    try {
      fs.mkdirSync(path.join(repo, 'scripts'));
      fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'check-tagged.js'), path.join(repo, 'scripts', 'check-tagged.js'));
      fs.writeFileSync(path.join(repo, 'package.json'), '{ "version": "1.2.3" }\n');
      git('init', '-q');
      git('add', '-A');
      git('commit', '-qm', 'release');
      assert.match(check().stderr, /there is no tag v1\.2\.3/);
      git('tag', 'v1.2.3');
      assert.equal(check().status, 0, 'at the tag');
      fs.writeFileSync(path.join(repo, 'stray.js'), '');
      assert.match(check().stderr, /the working tree is not clean/, 'an untracked file would ship');
      git('add', '-A');
      git('commit', '-qm', 'after');
      const past = check();
      assert.equal(past.status, 1);
      assert.match(past.stderr, /HEAD is not the commit tagged v1\.2\.3/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('drawing', () => {
  const { keepDrawing, drawUntilIdle, DRAW_IDLE } = require('../lib/cdp');
  const { tabState } = require('../lib/tabstate');

  // Only what keepDrawing uses of a page, with the CDP methods it sends written down.
  const page = () => {
    /** @type {string[]} */
    const sent = [];
    /** @type {(() => void)[]} */
    const closers = [];
    let closed = false;
    const session = { send: async (/** @type {string} */ method) => { sent.push(method); }, on: () => {} };
    const p = {
      sent,
      context: () => ({ newCDPSession: async () => session }),
      once: (/** @type {string} */ event, /** @type {() => void} */ fn) => { if (event === 'close') closers.push(fn); },
      isClosed: () => closed,
      close: () => { closed = true; closers.forEach(fn => fn()); },
    };
    return p;
  };

  it('draws a tab while commands act in it, and stops once it has had none for a while', async () => {
    const p = /** @type {any} */ (page());
    const closing = /** @type {any} */ (page());
    await keepDrawing(p);
    await keepDrawing(closing);
    assert.deepEqual(p.sent, ['Emulation.setFocusEmulationEnabled', 'Page.startScreencast']);
    drawUntilIdle();
    await keepDrawing(p);
    assert.ok(!tabState(p).drawIdle, 'a command before the tail ends keeps it drawing');
    // A tab drawn for a browser event (watch's next tab) while p's command runs: only it is timed.
    const event = /** @type {any} */ (page());
    await keepDrawing(event);
    drawUntilIdle(event);
    assert.ok(tabState(event).drawIdle && !tabState(p).drawIdle, 'the command running in p is not cut short');
    drawUntilIdle();
    closing.close();
    await new Promise(r => setTimeout(r, DRAW_IDLE + 200));
    assert.equal(p.sent.at(-1), 'Page.stopScreencast');
    assert.equal(event.sent.at(-1), 'Page.stopScreencast');
    assert.ok(!('drawing' in tabState(p)));
    assert.equal(closing.sent.at(-1), 'Page.startScreencast', 'nothing sent to a closed tab');
    await keepDrawing(p);
    assert.equal(p.sent.at(-1), 'Page.startScreencast', 'drawing again at the next command, its focus already told');
    assert.equal(p.sent.filter((/** @type {string} */ m) => m === 'Emulation.setFocusEmulationEnabled').length, 1);
    drawUntilIdle();
  });
});
