// The REPL's commands, gathered from each facility's module, and what the prompt and the runner
// need besides: playwright-cli's own commands, the hooks every page gets, and tab completion.
const { state, shutdown } = require('./state');
const { ownFilesText } = require('./written');
const out = require('./output');
const HELP = require('./help');
const { tabState } = require('./tabstate');
const { commands: dialogsCommands, ensureDialogHandler } = require('./dialogs');
const { commands: elementsCommands } = require('./elements');
const { commands: cursorCommands } = require('./cursor');
const { commands: touchCommands, GESTURES } = require('./touch');
const { commands: toastCommands } = require('./toast');
const { commands: requestlogCommands, ensureRecentLog } = require('./requestlog');
const { commands: routesCommands, routesFor } = require('./routes');
const { commands: networkCommands } = require('./network');
const { commands: emulationCommands, EMULATE_KINDS } = require('./emulation');
const { commands: captureCommands } = require('./capture');
const { commands: recordCommands } = require('./record');
const { commands: profileCommands } = require('./profile');
const { commands: inspectCommands } = require('./inspect');
const { commands: watchCommands, nextTabWanted, waitingForMe, watchNewTab } = require('./watch');
const { commands: tabsCommands, isOpening } = require('./tabs');
const { commands: modesCommands, allModesOff } = require('./modes');

// Every facility's commands. Each module is required here, so its shutdown hook is registered.
const commands = {
  ...tabsCommands,
  ...elementsCommands,
  ...cursorCommands,
  ...touchCommands,
  ...toastCommands,
  ...inspectCommands,
  ...watchCommands,
  ...requestlogCommands,
  ...routesCommands,
  ...networkCommands,
  ...emulationCommands,
  ...captureCommands,
  ...recordCommands,
  ...profileCommands,
  ...dialogsCommands,
  ...modesCommands,

  /** @param {string} args */
  async help(args) {
    const topic = (args || '').trim();
    const text = HELP.render(topic);
    if (text === null) throw new Error(HELP.notFound(topic));
    out.log(text);
  },

  async quit() {
    out.log('Disconnecting...');
    await shutdown();
  }
};

// Run for playwright-cli's names (lib/cli-names.js) where no command here does the same.
const cliCommands = {
  // By index only: tab <number> falls back to a tab whose URL contains the number.
  // The index is into the sender's last listing, so a tab someone opened or
  // closed since cannot shift it onto another tab; with none yet, the tabs now.
  /** @param {string} args */
  async 'tab-select'(args) {
    const all = /** @type {import('playwright-core').Browser} */ (state.browser).contexts().flatMap(c => c.pages());
    if (!/^\d+$/.test(args)) throw new Error('Usage: tab-select <index>, as tab-list lists the tabs');
    if (!state.tabListing.length) {
      if (!all[Number(args)]) throw new Error(`No tab [${args}]; there ${all.length === 1 ? 'is 1' : `are ${all.length}`}, and tab-list lists them`);
      state.tabListing = all.slice();
    }
    const target = state.tabListing[Number(args)];
    if (!target) throw new Error(`No tab [${args}] in your last listing; tab-list lists them again`);
    if (target.isClosed() || !all.includes(target)) throw new Error(`The tab at [${args}] in your last listing has closed; tab-list lists them again`);
    return commands.tab(args);
  },

  // playwright-cli's close ends its own session. The browser here is shared, so
  // it ends the sender's part in it: its modes are turned off, and every tab,
  // even one it opened, is left open for someone who may be using it.
  /** @param {string} args */
  async close(args) {
    if (args) throw new Error('Usage: close');
    if (!state.client) {
      throw new Error('close turns off the modes you turned on, which needs a client name: pw-repl send -c <name> close. Without one, they cannot be told from the prompt\'s; modes lists what is on.');
    }
    await allModesOff(true);
    const own = /** @type {import('playwright-core').Browser} */ (state.browser).contexts().flatMap(c => c.pages()).filter(p => tabState(p).owner === state.client);
    if (own.length) out.log(`Tabs you opened are still open: ${own.map(p => p.url()).join(', ')}; tab close <url-part> closes one, or select it and tab close.`);
    const files = ownFilesText(state.client);
    if (files) out.log(files);
  },
};

// Hooks every page needs from the moment the REPL sees it; opened, it opened while the REPL runs.
/** @param {import('playwright-core').Page} p */
function watchPage(p, opened = false) {
  ensureDialogHandler(p);
  ensureRecentLog(p, opened);
  if (nextTabWanted() && !isOpening()) watchNewTab(p);
}

// watch on --next-tab waits for a tab, and watch off stops waiting, with none selected;
// watch says it is still waiting.
/**
 * @param {string} cmd
 * @param {string} args
 */
function needsTab(cmd, args) {
  return !(cmd === 'watch' && (/(?:^|\s)--next-tab(?:\s|$)/.test(args) || /^\s*off\s*$/.test(args) || waitingForMe()));
}

// Tab completion for the prompt: command names first, then the fixed words
// a few commands take.
/** @param {string} line */
function complete(line) {
  const words = line.split(/\s+/);
  const current = words[words.length - 1];
  const match = (/** @type {string[]} */ options) => {
    options = [...new Set(options)];
    const hits = options.filter(o => o.startsWith(current));
    return [hits.length ? hits : options, current];
  };
  if (words.length === 1) return match(Object.keys(commands).sort());
  const command = words[0];
  if (words.length === 2) {
    if (command === 'help') return match(['--all', '--grep', ...Object.keys(HELP.TOPICS), ...Object.keys(HELP.COMMANDS).sort()]);
    if (command === 'tab') return match(['new', 'close']);
    if (command === 'touch') return match(GESTURES);
    if (command === 'mouse') return match(['move', 'click', 'dblclick', 'down', 'up', 'wheel']);
    if (command === 'network') return match(['on', 'off', 'slow']);
    if (command === 'emulate') return match([...EMULATE_KINDS, 'off']);
    if (command === 'wait') return match(['text', 'request', 'load']);
    if (command === 'modes') return match(['off']);
    if (command === 'dialog') return match(['accept', 'dismiss']);
    if (command === 'watch') return match(['on', 'off', 'new', '--all']);
    if (command === 'capture') return match(['on', 'off']);
    if (command === 'record') return match(['on', 'off']);
    if (command === 'profile') return match(['on', 'off', 'save', 'reload']);
    if (command === 'cursor') return match(['on', 'off']);
    if (command === 'toast') return match(['off']);
    if (command === 'viewport') return match(['off']);
    if (command === 'route') return match(['off']);
  }
  if (words.length >= 3 && command === 'watch' && words[1] === 'on') return match(['--changes', '--live', '--next-tab'].filter(f => !words.slice(2, -1).includes(f)));
  if (words.length === 3 && command === 'capture' && words[1] === 'on') return match(['requests', 'console']);
  if (words.length >= 3 && command === 'profile' && words[1] === 'on') return match(['--cpu']);
  if (words.length === 3 && command === 'emulate' && EMULATE_KINDS.includes(words[1])) return match(['off']);
  if (words.length === 3 && command === 'route' && words[1] === 'off') return match(['--all', ...(state.page ? routesFor(state.page).keys() : [])]);
  return [[], current];
}

module.exports = { commands, cliCommands, needsTab, watchPage, complete };
