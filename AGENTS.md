# Agent Instructions — pw-repl

How to use the REPL is in the skill `bin/pw-repl.js skill` prints (from `skill/SKILL.md`, stamped with
its version and hash). Read it first. In this clone, `pw-repl` there means `bin/pw-repl.js` (from the
folder this file is in) when it is not installed globally.

If there is a local agent file (e.g. `AGENTS.LOCAL.md`) next to this file, read it too.
They add to the rules in this file, and where the two differ, the local file wins.

## Contributing

If you hit a limitation or write a workaround, consider adding the capability to the REPL instead.

- A command is a function in the `commands` object of the module for what it works on, plus an entry
  in `lib/help.js` under one topic; `lib/commands.js` gathers every module's commands. A command that
  needs no tab, only reads, or takes `--all` is also listed in `lib/runner.js`'s `NO_TAB_NEEDED`,
  `READ_ONLY` or `INSPECTION`, and one that takes fixed words in `complete` (`lib/commands.js`).
- The modules, one per facility, each with its commands: `lib/tabs.js` (tabs, navigating),
  `lib/elements.js` (choosing a match; the interact and mouse commands; highlight), `lib/cursor.js` (the pointer
  drawn over the page, which the element and mouse commands glide first), `lib/touch.js` (touch gestures, under emulate mobile), `lib/toast.js` (a line of text
  over the page), `lib/overlay.js` (the element the cursor and toast are drawn in, one layer each), `lib/inspect.js` (reading the
  page, screenshots, eval, CDP, waits), `lib/watch.js`, `lib/requestlog.js` (requests, bodies, console),
  `lib/routes.js`, `lib/network.js`, `lib/emulation.js` (and viewport), `lib/capture.js`, `lib/profile.js` (performance traces;
  `lib/trace.js` reads and sums them up), `lib/record.js`
  (video, through ffmpeg, and the steps file saved with it), `lib/dialogs.js` and `lib/modes.js`. Beneath them, `lib/tabstate.js` is the one record kept per tab, `lib/cdp.js` the CDP
  session kept per tab, `lib/util.js` small shared helpers, and `lib/written.js` the files written and for whom. No facility requires `lib/modes.js` or
  `lib/commands.js`, and a unit test fails on a require cycle, which CommonJS would not report.
- `bin/pw-repl.js` is the command line; `lib/start.js` connects and runs the prompt; `lib/runner.js`
  runs commands one at a time (`quit` and `dialog` skip its queue); `lib/server.js` is the command
  server; `lib/send.js` and `lib/client.js` are `send` and `where`; `lib/background.js` is
  `serve --background`, `attach` and `stop`; `lib/launch.js` is `--launch`; `lib/syntax.js` is how a
  command line's words are read, shared with `send`, and its `{{ PW_NAME }}` variables; `lib/cli-names.js` maps playwright-cli's command
  names to these; `lib/state.js` holds the session state, with each client's selected tab;
  `lib/output.js` routes all output so the server can return it; `lib/skill.js` stamps the skill
  `pw-repl skill` prints, and gives `where` its hash.
- Match Playwright and playwright-cli (Microsoft's CLI for agents) as closely as is reasonable: agents are
  likelier to be trained on them. A new command, option or output that does what one of theirs does takes
  its name, form and API style (an option named as Playwright's API names it, e.g. type's `delay`), or
  accepts theirs too (`lib/cli-names.js`, `help playwright-cli`). Deviate only where it is necessary, as
  where sharing a browser with a user needs it, and say why in the help.
- Comment the *why* when it isn't obvious from the code.
- `npm run typecheck` type-checks `bin/` and `lib/` (`tsc` over the JavaScript, no build step): run it
  before a commit, and keep it clean. A type goes in JSDoc where one is needed; what JSDoc cannot declare
  (a page global on `window`, a field Node's or Playwright's types leave out) goes in
  `types/globals.d.ts`. A gap in someone else's types is filled with a cast or that file, never by
  changing what the code does.
- `npm test` runs the suite (about two and a half minutes): a private headless Chromium, a local test site
  (`test/harness.js`), and the real REPL with its server. Nothing is mocked, and the shared browser is
  never touched. It finds Chromium through `PW_TEST_CHROME`, or where `--launch` looks (Playwright's
  browsers, then the `PATH`), and skips the browser tests if there is none. Add a test with each new
  command or behaviour. In `test/repl.test.js` each test starts in a fresh tab of its own, and every mode
  is turned off after it; a test whose REPL quits, times out or is killed goes in
  `test/repl-alone.test.js`, with a Chromium of its own.
- A command's help (`lib/help.js`) follows playwright-cli's layout: `usage` and `summary`; `args` and
  `options`, one `[name, text]` each, with the default in its text (`Default: 750; 0 none.`); `detail`,
  short paragraphs on what most callers need, a paragraph on one theme starting with a label (`Steps
  (--steps):`); and `more`, with `moreAbout` naming what is in it, for what only goes wrong now and then,
  shown by `help <command> --all` and `help --all`. An error about something in `more` ends by naming it
  (`help record --all`). Paragraphs are plain: `wrap()` lays each out at 104 columns, and keeps as written
  a paragraph with a bullet, a table or an indented example. `test/fixtures` holds the rendered help;
  after an intended change to it, save it again (the command is in `test/units.test.js`). The common
  tasks and modes on help's front page (`TASKS` and `MODES`) are the README's too: change both, as a
  unit test compares them.
- Time each full run, and put the result in the body of the commit it tests (`npm test: 151 tests, 79s`),
  with the load average (`uptime`) when it is high. Compare with the last commit that has one (`git log
  --grep='npm test:'`): a run that grew by more than a few seconds, at a like load (a busy machine slows
  every test), means a slow test crept in, usually one waiting out a real timeout (5s for a click).
  Find it (each test prints its time) and make it faster, or say why it can't be, before committing.
- Don't race the clock in a test: a page that changes on a timer, or a command timed against a budget,
  fails on a busy machine. Have the page change when the test asks (eval), or measure the thing itself
  (frames drawn, not clicks timed). A click waits for its element to hold still for two frames.
- For anything the tests can't reach, exercise the change in a running REPL of your own: on a socket of
  your own, with `--launch` unless the change needs the user's browser, and then in a tab of your own.
  One started before a change to `lib/` runs the old code: restart it after a change. Stop a process by
  its pid, after checking what it is; a broad `pkill -f` pattern can match your own shell, or a REPL
  someone else is using.
- `skill/SKILL.md` is how agents learn to use the REPL: keep it in step with a change to how it is
  used, and leave its Custom rules section empty. Keep its `<!-- pw-repl skill stamp -->` line: `pw-repl
  skill` replaces it with the version and a hash of the skill's text, which `where` reports, so agents
  can tell a saved copy is out of date.

## Releasing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`,
`test:`, `chore:` and so on, with an optional scope (`fix(watch): ...`). Versions follow semver; before
1.0, a change that breaks how the REPL is used is a minor bump (0.2.0 to 0.3.0), anything else a patch.

1. `npm outdated` and `npm audit` show nothing that needs doing first: a dependency bumped after the tag
   means cutting the release again. Dependencies are always the newest
   stable release, never pinned back. When the newest breaks a test, fix it in our code; only a
   regression of the dependency's own, with the fix already in its next release, keeps the version before
   it, until that release ships. playwright-core stays at 1.63 for that reason: on 1.64.1 a click
   on a link to a 204 hangs at "waiting for scheduled navigations to finish" until its timeout, in plain
   Playwright too (chromium.launch, a page with a link to a 204, page.click on it); 1.65's alphas fix it.
   The test "waits for the page to load, counting a navigation that just began" shows it: move up once it
   passes on the newest release. `@types/node` stays on the major of the oldest Node in `engines`, so that
   type-checking flags an API that Node lacks: move it up when `engines` does.
2. `npm run release <patch|minor|major>` cuts it: `npm version` refuses a working tree with changes, runs
   the checks in the `preversion` script (`npm run typecheck`, then `npm test`), then sets the version in
   `package.json` and `package-lock.json`, commits it as `chore: release X.Y.Z`, and tags that commit
   `vX.Y.Z`. A failed check leaves no commit and no tag. `preversion` is an npm script that runs only on a
   release, not a git hook: commits are never checked.
3. `npm run deploy` pushes the commits and the tag, then publishes. It, and `npm publish` on its own
   (`prepublishOnly`), refuse unless HEAD is the commit tagged `vX.Y.Z` and the tree is clean, untracked
   files included (`scripts/check-tagged.js`): what is published is the commit `release` checked.

A release cut too early and not pushed yet is undone (its commit and tag) and cut again after the fixes.

Pushing and publishing need the maintainer's GitHub and npm credentials.
