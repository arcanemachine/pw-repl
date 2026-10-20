#!/usr/bin/env node
// The one command: pw-repl run | serve | attach | stop | send | where | help | skill.

const { looksLikeEndpoint } = require('../lib/client');

const USAGE = `Usage:
  pw-repl run [--launch [--headed]] [start-url] [-- <chromium flags>]
      connect to the browser and open the prompt

  pw-repl serve [--background] [--launch [--headed]] [[-e] endpoint] [start-url] [-- <chromium flags>]
      the same, plus a command server (socket, port, or 127.0.0.1:port; default /tmp/pw-repl.sock);
      --background runs it detached, with its output in a log next to the socket; a socket's folder is
      made if it is missing

  pw-repl attach [-e endpoint]
      see everything a background REPL does, and type commands to it; Ctrl-C leaves it running

  pw-repl stop [-e endpoint]
      stop a background REPL, and say what became of each recording it ended; its socket is removed, its
      log stays

  pw-repl send [-e endpoint | -s session] [-c client] [-t seconds] [--no-vars]
               <command...> | --file <file>
      run one command in a running REPL and print its output; --file runs a file of them, one per line

  pw-repl where [-e endpoint | -s session]
      say which REPL send would reach

  pw-repl help [topic | command | --all]
      this usage; with a topic or command, the REPL's help for it

  pw-repl skill
      print an agent skill (SKILL.md) that teaches an agent to use the REPL

A browser: --launch starts a Chromium of the REPL's own, headless unless --headed, 1280x800, in a
temporary profile, on a free port of its own (pw-repl where names it). It prints the command it ran, and
stops with the REPL (Ctrl-C while it starts too); stop returns once it has exited. Flags after -- go to
it, and only flags (a start URL goes before --); a --user-data-dir=<dir> among them is used instead of
the temporary profile, and kept. PW_CHROME picks which Chromium.

Without --launch, the REPL connects to a browser running with --remote-debugging-port, at $PW_CDP_URL
(default http://localhost:9222).

send uses the server when -e, $PW_ENDPOINT, or the socket ($PW_SOCKET, default /tmp/pw-repl.sock) is
there, and the tmux session where pw-repl run runs otherwise (-s, $PW_TMUX_SESSION, default pw-repl).
serve without an endpoint serves on that same socket. send exit status: 0 ok, 1 command error, 2
completion not confirmed, 64 usage or unreachable. pw-repl send --help has the rest: clients, -t,
--file and variables.`;

// pw-repl send --help: what send does beyond its usage line.
const SEND_HELP = `send uses the server when -e, $PW_ENDPOINT, or the socket ($PW_SOCKET, default /tmp/pw-repl.sock) is
there, and the tmux session (-s, $PW_TMUX_SESSION, default pw-repl) otherwise, where pw-repl run runs.
If the socket exists but nothing answers, send fails rather than fall back. serve without an endpoint
serves on that same one: $PW_ENDPOINT, then $PW_SOCKET, then the default.

send -c <client> (or $PW_CLIENT) sends as a client of the REPL's with a selected tab of its own, so
several agents can share one REPL; pw-repl help session has the rest.

send's options can also follow the command, as in pw-repl send open <url> -t 30; after a -- before the
command, every word is the command's, -t 30 included.

Exit status: 0 ok, 1 command error, 2 completion not confirmed, 64 usage or unreachable. -t is how long
send waits for the answer (default 20s); it does not lengthen a command's own limits, such as the 5s an
action waits for its element.

--file <file> runs each line of a file as a command, in order, as if typed at the REPL's prompt: quoted
as the prompt reads it (no shell), with a file it records, uploads or saves relative to this folder, as
on send's command line, and # comments and blank lines skipped. It stops at the first command that
fails, saying its line, with its exit status. -t is each command's own limit. Other clients' commands
can run between its lines, on their own tabs.

Variables: a {{ PW_NAME }} in a command, or in a line of the file, takes its value from send's own
environment (PW_NAME), passed along with the command, not in it, so a password stays out of the file and
out of the REPL's log: PW_PASSWORD=... pw-repl send fill '#password' "{{ PW_PASSWORD }}", or
PW_PASSWORD="$(cat <file>)" to give it from a file without typing it. Only PW_ names are variables; any
other {{ ... }} is sent as written. In a file, put one in double quotes (in single quotes, a value with
a ' is refused). One that is not set stops the command, or the file at that line, before it is sent;
--no-vars sends {{ PW_NAME }} as it is. Variables need the command server (pw-repl serve), not the tmux
pane.`;

const REPL_HELP = `The REPL's own commands: help at the pw> prompt, or pw-repl send help here (no REPL needed).

pw-repl help <topic | command [--all] | --all> shows one part of it; pw-repl help video and pw-repl
help playwright-cli are guides.`;

const SUBCOMMANDS = ['run', 'serve', 'attach', 'stop', 'send', 'where', 'help', 'skill'];

// What is wrong, then only the usage of the subcommand it is about: the whole of it would bury the line
// that matters. With no message, the whole usage (-h after a subcommand).
function usage(message, subcommand) {
  if (!message) {
    console.error(USAGE);
    process.exit(64);
  }
  console.error(`pw-repl: ${message}`);
  const lines = subcommand && USAGE.split('\n\n').find(block => new RegExp(`^(?:Usage:\\n)?  pw-repl ${subcommand}(?: |\\n|$)`).test(block));
  if (lines) console.error(`Usage:\n${lines.replace(/^Usage:\n/, '')}`);
  console.error(`pw-repl --help has the ${lines ? 'rest' : 'usage'}.`);
  process.exit(64);
}

// A command line to copy, quoted as a shell reads it.
function shellLine(words) {
  return words.map(w => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`)).join(' ');
}

// -e, -s, -c and -t, then the command words (unquoted words are one command), and send's options again
// at the end, as an agent types them (send open <url> -t 30); after --, every word is the command.
function parseSendArgs(args, subcommand) {
  const allowCommand = subcommand === 'send';
  const options = { endpoint: null, session: null, client: null, timeout: 20, command: '', file: null };
  const given = new Set();
  const take = (arg, value, after) => {
    if (value === undefined) usage(`${arg} needs a value`, subcommand);
    // Given before the command and after it, neither silently wins.
    if (after && given.has(arg)) usage(`${arg} is given twice, ${value === true ? arg : `${arg} ${value}`} after the command; give it once`, subcommand);
    given.add(arg);
    if (arg === '--no-vars') options.noVars = true;
    if (arg === '-e') options.endpoint = value;
    if (arg === '-s') options.session = value;
    if (arg === '-c') options.client = value;
    if (arg === '-t') {
      if (!/^\d+$/.test(value) || Number(value) < 1) usage(`-t takes whole seconds, 1 or more (got ${value})`, subcommand);
      options.timeout = Number(value);
    }
  };
  let i = 0;
  let dashes = false;
  for (; i < args.length; i++) {
    const arg = args[i];
    // playwright-cli's --raw: the output here is only the command's already.
    if (arg === '--raw') continue;
    // playwright-cli's -s=<session> names a browser of its own; the nearest here is a client.
    if (/^(?:-s|--session)=/.test(arg)) {
      console.error(`pw-repl: ${arg} is playwright-cli's session, a browser of its own. Here -s <name> is a tmux session;`);
      console.error('the nearest to a session is a client: -c <name> (or PW_CLIENT), with a selected tab of its own, in a');
      console.error('browser it shares, cookies, storage and modes and all.');
      process.exit(64);
    }
    // A file of commands, one per line, as typed at the prompt.
    if (arg.startsWith('--file=') && arg.length > 7) { options.file = require('path').resolve(arg.slice(7)); continue; }
    if (arg === '--file') {
      if (args[i + 1] === undefined) usage('--file needs a file of commands', subcommand);
      options.file = require('path').resolve(args[++i]);
      continue;
    }
    if (arg === '--no-vars') take(arg, true);
    else if (arg === '-e' || arg === '-s' || arg === '-c' || arg === '-t') take(arg, args[++i]);
    else if (arg === '--') { i++; dashes = true; break; } else break;
  }
  const words = args.slice(i);
  // A word the shell kept whole ("a -t 3") is never one of these; an option with a bad value is still
  // send's, refused, not the end of a URL or a selector.
  while (allowCommand && !dashes) {
    const last = words.length - 1;
    if (last > 0 && words[last] === '--raw') words.pop();
    else if (last > 0 && words[last] === '--no-vars') take(words.pop(), true, true);
    else if (last > 1 && /^-[ecst]$/.test(words[last - 1])) { const value = words.pop(); take(words.pop(), value, true); } else break;
  }
  // An address that is refused (not loopback) is a usage error, said once, not a stack trace.
  const endpoint = options.endpoint || process.env.PW_ENDPOINT;
  if (endpoint) {
    try {
      require('../lib/client').parseEndpoint(endpoint);
    } catch (error) {
      console.error(`pw-repl: ${error.message}`);
      process.exit(64);
    }
  }
  if (!allowCommand && options.file) usage(`--file is send's; ${subcommand} runs no commands`, subcommand);
  if (!allowCommand && words.length) usage(`${subcommand} takes no command (got ${shellLine(words)})`, subcommand);
  if (options.file && words.length) usage(`a command or --file, not both (got --file and ${shellLine(words)})`, subcommand);
  options.command = require('../lib/send').commandLine(words);
  return options;
}

function startOptions(args, serve) {
  const options = { serve, endpoint: null, startUrl: null, background: false, launch: false, headed: false, chromeArgs: [], pidFile: process.env.PW_REPL_PID_FILE || null };
  // Whatever follows -- is for the Chromium that --launch starts.
  const split = args.indexOf('--');
  const rest = split === -1 ? [...args] : args.slice(0, split);
  if (split !== -1) options.chromeArgs = args.slice(split + 1);
  const flag = name => { const i = rest.indexOf(name); if (i === -1) return false; rest.splice(i, 1); return true; };
  if (serve) options.background = flag('--background');
  options.launch = flag('--launch');
  options.headed = flag('--headed');
  const subcommand = serve ? 'serve' : 'run';
  if (options.headed && !options.launch) usage('--headed is for the Chromium --launch starts; add --launch', subcommand);
  if (options.chromeArgs.length && !options.launch) usage('flags after -- go to the Chromium --launch starts; add --launch', subcommand);
  // Chromium takes any word that is not a --switch as a page to open, and a headless one refuses a second.
  const n = options.chromeArgs.findIndex(word => !word.startsWith('-'));
  if (n !== -1) {
    const [page, before] = [options.chromeArgs[n], options.chromeArgs[n - 1]];
    // Most likely a switch's value given as a word of its own (--user-data-dir /tmp/p); a URL after a
    // switch is a URL (--disable-gpu http://...).
    if (before && /^--[^=]+$/.test(before) && !page.includes('://')) usage(`${page} after -- would go to Chromium as a page to open: it takes a switch's value as ${before}=${page}`, subcommand);
    usage(`${page} after -- would go to Chromium as a page to open; only flags go after --. A start URL goes before --; for a browser already running, leave out --launch and set PW_CDP_URL`, subcommand);
  }
  // -e <endpoint>, as send, attach, stop and where take it, or the endpoint as the first word.
  const e = rest.indexOf('-e');
  if (serve && e !== -1 && rest[e + 1] && looksLikeEndpoint(rest[e + 1])) {
    options.endpoint = rest.splice(e, 2)[1];
    // Two endpoints, one with -e: neither silently wins.
    if (rest[0] && looksLikeEndpoint(rest[0])) usage(`two endpoints, -e ${options.endpoint} and ${rest[0]}: give one`, subcommand);
  } else if (serve && rest[0] && looksLikeEndpoint(rest[0])) options.endpoint = rest.shift();
  // Otherwise the socket send would look for: PW_ENDPOINT, then PW_SOCKET, then the default.
  if (serve && !options.endpoint) options.endpoint = process.env.PW_ENDPOINT || process.env.PW_SOCKET || null;
  const option = rest.find(word => word.startsWith('-'));
  if (option === '-h' || option === '--help') usage();
  if (option === '-e') {
    usage(serve ? `-e takes an endpoint: a socket (/tmp/<name>.sock), a port, or 127.0.0.1:port (got ${rest[rest.indexOf('-e') + 1] ?? 'nothing'})` : 'run has no command server, so no endpoint; pw-repl serve has one', subcommand);
  }
  if (option === '--background') usage('--background is serve\'s: pw-repl serve --background', subcommand);
  if (option) usage(`unknown option ${option}`, subcommand);
  if (rest.length > 1) usage(`one start URL at most (got ${shellLine(rest)})`, subcommand);
  options.startUrl = rest[0] || null;
  return options;
}

function help(topic) {
  const helpText = require('../lib/help');
  const text = helpText.render(topic);
  if (text === null) {
    console.log(`Error: ${helpText.notFound(topic)}`);
    process.exit(1);
  }
  console.log(text);
}

// Printed to be saved as a skill, stamped with where it came from; the hint goes to the terminal only.
function skill() {
  process.stdout.write(require('../lib/skill').stamped());
  if (process.stdout.isTTY) console.error('\nSave it as pw-repl/SKILL.md in the folder your agent reads skills from:\npw-repl skill > <skills folder>/pw-repl/SKILL.md');
}

async function main() {
  let [subcommand, ...args] = process.argv.slice(2);
  // -h after send, where, attach or stop is a request for help, never a command to send.
  if (['send', 'where', 'attach', 'stop'].includes(subcommand) && /^(?:-h|--help)$/.test(args[0] || '')) {
    if (subcommand !== 'send') return console.log(`${USAGE}\n\n${REPL_HELP}`);
    const block = USAGE.split('\n\n').find(b => b.startsWith('  pw-repl send '));
    return console.log(`Usage:\n${block}\n\n${SEND_HELP}`);
  }
  // Bare pw-repl explains itself rather than connect to someone's browser.
  if (subcommand === undefined) return console.log(`${USAGE}\n\n${REPL_HELP}`);
  switch (subcommand) {
    case 'run':
    case 'serve': {
      const options = startOptions(args, subcommand === 'serve');
      // A socket of one's own is often in a folder of its own (/tmp/<name>/repl.sock): made here, before
      // the log, the pid file or the socket go in it, whichever way serve runs. Owner-only, as the socket is.
      const socket = subcommand === 'serve' ? require('../lib/client').parseEndpoint(options.endpoint).socket : null;
      if (socket) {
        const folder = require('path').dirname(socket);
        try { require('fs').mkdirSync(folder, { recursive: true, mode: 0o700 }); } catch (error) {
          console.error(`pw-repl: cannot create ${folder} for the socket (${error.code === 'EEXIST' ? 'a file is there' : error.code || error.message})`);
          process.exit(64);
        }
      }
      if (options.background) process.exit(await require('../lib/background').start(options));
      return require('../lib/start').start(options);
    }
    case 'attach':
    case 'stop': {
      const options = parseSendArgs(args, subcommand);
      if (options.session) usage(`-s is send's tmux session; ${subcommand} takes -e <endpoint>`, subcommand);
      // The same socket send would use when there is no -e: PW_ENDPOINT, then PW_SOCKET.
      const endpoint = options.endpoint || process.env.PW_ENDPOINT || process.env.PW_SOCKET || null;
      process.exit(await require('../lib/background')[subcommand]({ endpoint }));
    }
    // falls through never: process.exit above
    case 'send': {
      const options = parseSendArgs(args, 'send');
      if (!options.command && !options.file) usage('no command given', 'send');
      // help is fixed text, so it needs no browser: answer it here.
      const asksHelp = /^help(?:\s+(.*))?$/.exec(options.command);
      if (asksHelp) return help((asksHelp[1] || '').trim());
      process.exit(await require('../lib/send').send(options));
    }
    // falls through never: process.exit above
    case 'where':
      process.exit(await require('../lib/send').where(parseSendArgs(args, 'where')));
    // falls through never
    case 'help': {
      const topic = args.join(' ').trim();
      if (topic && topic !== '-h' && topic !== '--help') return help(topic);
      return console.log(`${USAGE}\n\n${REPL_HELP}`);
    }
    case 'skill':
      if (args.length) usage(`skill takes no arguments (got ${shellLine(args)})`, 'skill');
      return skill();
    case '-v':
    case '--version':
      return console.log(require('../package.json').version);
    case '-h':
    case '--help':
      return console.log(`${USAGE}\n\n${REPL_HELP}`);
    default: {
      // An option before the subcommand (pw-repl -t 30 send ...): say where it goes, with the line fixed.
      if (subcommand.startsWith('-')) {
        const all = [subcommand, ...args];
        const named = all.find(word => SUBCOMMANDS.includes(word));
        const fixed = named ? shellLine(['pw-repl', named, ...all.filter((word, n) => n !== all.indexOf(named))]) : `pw-repl send ${shellLine(all)} <command>`;
        return usage(`${subcommand} is an option of a subcommand, and goes after it: ${fixed}`, named || 'send');
      }
      const url = /^[a-z][\w+.-]*:/i.test(subcommand) && !looksLikeEndpoint(subcommand) ? `; a start URL goes after run or serve: pw-repl run ${subcommand}` : '';
      return usage(`${subcommand} is not a command (they are ${SUBCOMMANDS.join(', ')})${url}`);
    }
  }
}

main();
