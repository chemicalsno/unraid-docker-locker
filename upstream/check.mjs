#!/usr/bin/env node
// Watches the files from unraid/webgui that Docker Locker depends on. For master
// and the newest release branch, it reports files whose version hasn't been
// reviewed, checks that the code the plugin relies on (the "anchors") is still
// there, and runs the tests against that branch's docker.js. If anything needs a
// look, it opens a GitHub issue, or updates the one that's already open.
//
//   node upstream/check.mjs            check, and open or update an issue (needs GITHUB_TOKEN and GITHUB_REPOSITORY)
//   node upstream/check.mjs --dry-run  check and print the report only
//   node upstream/check.mjs --accept   mark the current versions as reviewed in watched.json
//
// GITHUB_TOKEN is optional for --dry-run and --accept, but without it GitHub
// allows only 60 API requests an hour.
import {readFileSync, writeFileSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const watchedPath = join(here, 'watched.json');
const watched = JSON.parse(readFileSync(watchedPath, 'utf8'));
const upstream = watched.repo;
const issueTitle = 'Unraid changed files that Docker Locker depends on';
const dockerJS = 'emhttp/plugins/dynamix.docker.manager/javascript/docker.js';
const args = new Set(process.argv.slice(2));
const token = process.env.GITHUB_TOKEN;

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const err = new Error(`GitHub API ${init.method || 'GET'} ${path}: ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// master plus the newest release branch (named like 7.3), so a new release branch
// is picked up without editing this script
async function branches() {
  const names = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/repos/${upstream}/branches?per_page=100&page=${page}`);
    names.push(...batch.map((b) => b.name));
    if (batch.length < 100) break;
  }
  const releases = names.filter((n) => /^\d+\.\d+$/.test(n)).sort((a, b) => {
    const [a1, a2] = a.split('.').map(Number);
    const [b1, b2] = b.split('.').map(Number);
    return a1 - b1 || a2 - b2;
  });
  return ['master', ...releases.slice(-1)];
}

// a null sha means the file no longer exists on that branch
async function fetchFile(branch, path) {
  let sha;
  try {
    sha = (await api(`/repos/${upstream}/contents/${path}?ref=${encodeURIComponent(branch)}`)).sha;
  } catch (err) {
    if (err.status === 404) return {sha: null, text: ''};
    throw err;
  }
  const res = await fetch(`https://raw.githubusercontent.com/${upstream}/${encodeURIComponent(branch)}/${path}`);
  if (!res.ok) throw new Error(`Download ${branch}/${path}: ${res.status}`);
  return {sha, text: await res.text()};
}

function runTests(text) {
  const dir = mkdtempSync(join(tmpdir(), 'docker-locker-upstream-'));
  const file = join(dir, 'docker.js');
  writeFileSync(file, text);
  const run = spawnSync('npm', ['test'], {
    cwd: join(here, '..', 'test'),
    env: {...process.env, DOCKER_JS: file},
    encoding: 'utf8',
  });
  return run.status === 0;
}

const links = (branch, path) =>
  `[file](https://github.com/${upstream}/blob/${branch}/${path}) · [history](https://github.com/${upstream}/commits/${branch}/${path})`;

const branchList = await branches();
const results = [];
for (const branch of branchList) {
  for (const [path, {anchors, reviewed}] of Object.entries(watched.files)) {
    const {sha, text} = await fetchFile(branch, path);
    results.push({
      branch, path, sha, text,
      changed: !reviewed.includes(sha),
      missingAnchors: sha ? anchors.filter((a) => !text.includes(a)) : anchors,
    });
  }
}

if (args.has('--accept')) {
  let added = 0;
  for (const {path, sha} of results) {
    if (sha && !watched.files[path].reviewed.includes(sha)) {
      watched.files[path].reviewed.push(sha);
      added++;
    }
  }
  writeFileSync(watchedPath, JSON.stringify(watched, null, 2) + '\n');
  console.log(`Marked ${added} file version(s) as reviewed on ${branchList.join(', ')}.`);
  process.exit(0);
}

const tests = branchList.map((branch) => {
  const file = results.find((r) => r.branch === branch && r.path === dockerJS);
  return {branch, passed: file.sha ? runTests(file.text) : false};
});
const changed = results.filter((r) => r.changed);
const broken = results.filter((r) => r.missingAnchors.length);
const failing = tests.filter((t) => !t.passed);

if (!changed.length && !failing.length) {
  console.log(`No changes to the watched files on ${branchList.join(', ')}, and the tests pass.`);
  process.exit(0);
}

const lines = [
  `Docker Locker depends on these files from [${upstream}](https://github.com/${upstream}). Checked branches: ${branchList.map((b) => `\`${b}\``).join(', ')}.`,
  '',
];
if (broken.length) {
  lines.push('## Code the plugin relies on is missing', '');
  lines.push('These need a fix before that branch ships in an Unraid release.', '');
  for (const r of broken) {
    lines.push(`- \`${r.branch}\` \`${r.path}\`${r.sha ? '' : ' (file no longer exists)'}: missing ${r.missingAnchors.map((a) => `\`${a}\``).join(', ')}. ${links(r.branch, r.path)}`);
  }
  lines.push('');
}
const intact = changed.filter((r) => !r.missingAnchors.length);
if (intact.length) {
  lines.push('## Changed, with the code the plugin relies on still present', '');
  lines.push('Review these to confirm the changes don\'t affect the plugin.', '');
  for (const r of intact) lines.push(`- \`${r.branch}\` \`${r.path}\`. ${links(r.branch, r.path)}`);
  lines.push('');
}
lines.push('## Tests against each branch\'s docker.js', '');
for (const t of tests) lines.push(`- \`${t.branch}\`: ${t.passed ? 'pass' : 'fail'}`);
lines.push(
  '',
  '## After reviewing',
  '',
  'When the changes are handled, mark the current versions as reviewed and commit `upstream/watched.json`, then close this issue:',
  '',
  '```bash',
  'node upstream/check.mjs --accept',
  '```',
);
const body = lines.join('\n') + '\n';

if (args.has('--dry-run')) {
  console.log(body);
  process.exit(0);
}

const repo = process.env.GITHUB_REPOSITORY;
if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required to open an issue. Use --dry-run to print the report.');
const open = (await api(`/repos/${repo}/issues?state=open&per_page=100`)).find((i) => !i.pull_request && i.title === issueTitle);
if (open) {
  await api(`/repos/${repo}/issues/${open.number}`, {method: 'PATCH', body: JSON.stringify({body})});
  console.log(`Updated issue #${open.number}.`);
} else {
  const created = await api(`/repos/${repo}/issues`, {method: 'POST', body: JSON.stringify({title: issueTitle, body})});
  console.log(`Opened issue #${created.number}.`);
}
