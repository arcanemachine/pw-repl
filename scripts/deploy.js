#!/usr/bin/env node
// npm run deploy: pushes the commits and the tag, logs in to npm, then publishes HEAD, which must be the
// tagged release (scripts/check-tagged.js). With --last, publishes the latest release from its tag instead,
// for when commits have landed on top of it: checks the tag out, publishes, and goes back to where it was.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const red = (/** @type {string} */ text) => (process.stderr.isTTY ? `\x1b[1;31m${text}\x1b[0m` : text);

class StepFailed extends Error {}

// Each step's own output shows as it runs; a failure stops the deploy, named by its step.
const run = (/** @type {string} */ command, /** @type {string[]} */ args, name = `${command} ${args.join(' ')}`) => {
  try { execFileSync(command, args, { stdio: 'inherit' }); } catch { throw new StepFailed(name); }
};
const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const checkTagged = () => run(process.execPath, [path.join(__dirname, 'check-tagged.js')], 'the release check (scripts/check-tagged.js)');

/** @param {string} message */
function fail(message) {
  console.error(red(`\n✖ deploy failed: ${message}`));
  process.exit(1);
}

function deploy() {
  checkTagged();
  run('git', ['push', '--follow-tags']);
  run('npm', ['login']);
  run('npm', ['publish']);
}

function deployLast() {
  if (git('status', '--porcelain')) fail('the working tree is not clean, and --last checks out the release tag. Nothing was pushed or published.');
  let tag = '';
  try { tag = git('describe', '--tags', '--abbrev=0', '--match', 'v*'); } catch {}
  if (!tag) fail('there is no release tag (v*) to publish. Nothing was pushed or published.');
  // Back to the branch, or to the commit when not on one.
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const start = branch === 'HEAD' ? git('rev-parse', 'HEAD') : branch;
  // Not on a branch, there is only the tag to push.
  run('git', branch === 'HEAD' ? ['push', 'origin', tag] : ['push', '--follow-tags']);
  run('git', ['checkout', '--quiet', tag]);
  console.log(`Publishing ${tag} from its tag.`);
  try {
    // The tag's own check-tagged.js and package.json: the release as it was cut.
    checkTagged();
    run('npm', ['login']);
    run('npm', ['publish']);
  } finally {
    try {
      git('checkout', '--quiet', start);
      console.log(`Back on ${start}.`);
    } catch {
      console.error(red(`✖ Could not go back to ${start}: still on ${tag}. git checkout ${start} returns there.`));
    }
  }
}

try {
  if (process.argv.includes('--last')) deployLast(); else deploy();
} catch (error) {
  if (error instanceof StepFailed) fail(`${error.message} did not succeed (its output is above).`);
  throw error;
}
