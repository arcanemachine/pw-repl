#!/usr/bin/env node
// Refuses unless HEAD is exactly the tag v<package.json version> and the tree is clean,
// so what is pushed and published is the commit `npm run release` checked and tagged.
const { execFileSync } = require('node:child_process');
const { version } = require('../package.json');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const tag = `v${version}`;
const problems = [];

if (git('status', '--porcelain')) problems.push('the working tree is not clean');
let tagged = '';
try { tagged = git('rev-parse', '--verify', '--quiet', `${tag}^{commit}`); } catch {}
if (!tagged) problems.push(`there is no tag ${tag}`);
else if (tagged !== git('rev-parse', 'HEAD')) problems.push(`HEAD is not the commit tagged ${tag}`);

if (problems.length) {
  console.error(`Refusing: ${problems.join('; ')}. Cut the release with \`npm run release <patch|minor>\`.`);
  process.exit(1);
}
