#!/usr/bin/env node
// Helpers for releasing docker.locker.plg, used by the GitHub Actions workflows.
//
//   node release/plg.mjs version <plg>               print the plugin version
//   node release/plg.mjs check-bump <base> <head>    fail unless head's version is valid, newer, and has a changelog entry
//   node release/plg.mjs notes <plg> [<since>]       print release notes covering every version after <since>
import {readFileSync} from 'node:fs';

// Unraid's convention for plugin versions: a date, plus a letter for later releases that day
const versionFormat = /^\d{4}\.\d{2}\.\d{2}[a-z]?$/;

export function version(plg) {
  const match = plg.match(/<!ENTITY\s+version\s+"([^"]+)"/);
  if (!match) throw new Error('No version entity found in the .plg');
  return match[1];
}

// every "###<version>" entry in the <CHANGES> section, newest first, with its bullet lines
export function entries(plg) {
  const section = plg.match(/<CHANGES>([\s\S]*?)<\/CHANGES>/);
  const result = [];
  for (const line of section ? section[1].split('\n') : []) {
    if (line.startsWith('###')) result.push({version: line.slice(3).trim(), lines: []});
    else if (line.trim() && result.length) result.at(-1).lines.push(line.trim());
  }
  return result;
}

export function changes(plg, ver) {
  return entries(plg).find((e) => e.version === ver)?.lines ?? [];
}

// Unraid's installer compares versions with strcmp, so "newer" means sorting
// after the old version as plain text
export function checkBump(basePlg, headPlg) {
  const problems = [];
  const before = version(basePlg);
  const after = version(headPlg);
  if (!versionFormat.test(after)) problems.push(`Version ${after} doesn't match YYYY.MM.DD with an optional letter, such as 2026.10.25c.`);
  if (!(after > before)) problems.push(`Version ${after} must sort after ${before}, or Unraid won't offer it as an update.`);
  if (!changes(headPlg, after).length) problems.push(`The <CHANGES> section has no entry for ###${after}.`);
  return problems;
}

// covers every version after `since` (the previous release), so versions that
// were merged without their own release still have their changes listed
export function notes(plg, since = '') {
  const ver = version(plg);
  const repo = plg.match(/<!ENTITY\s+repo\s+"([^"]+)"/)?.[1];
  const name = plg.match(/<!ENTITY\s+name\s+"([^"]+)"/)?.[1];
  const min = plg.match(/<PLUGIN[^>]*\bmin="([^"]+)"/)?.[1];
  const included = entries(plg).filter((e) => e.version <= ver && e.version > since);
  const changeLines = included.length > 1
    ? included.flatMap((e) => [`### ${e.version}`, '', ...e.lines, ''])
    : [...changes(plg, ver), ''];
  return [
    since ? `## Changes since ${since}` : '## Changes',
    '',
    ...changeLines,
    '## Install or update',
    '',
    'If Docker Locker is already installed, update it from **Plugins > Installed Plugins**.',
    '',
    'To install it, go to **Plugins > Install Plugin**, paste the following URL, and click **Install**:',
    '',
    '```text',
    `https://raw.githubusercontent.com/${repo}/main/${name}.plg`,
    '```',
    ...(min ? ['', `Requires Unraid ${min} or later.`] : []),
    '',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...files] = process.argv.slice(2);
  const read = (f) => readFileSync(f, 'utf8');
  if (command === 'version') {
    console.log(version(read(files[0])));
  } else if (command === 'check-bump') {
    const problems = checkBump(read(files[0]), read(files[1]));
    for (const p of problems) console.error(p);
    if (problems.length) process.exit(1);
    console.log(`Version ${version(read(files[1]))} is valid.`);
  } else if (command === 'notes') {
    process.stdout.write(notes(read(files[0]), files[1]));
  } else {
    console.error('Usage: node release/plg.mjs version|check-bump|notes <plg> [<plg>]');
    process.exit(2);
  }
}
