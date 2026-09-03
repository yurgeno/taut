// Stack specialization surface: detection (deterministic file probes), deployment
// declaration override, the open `stack-*` marker vocabulary, gates → compiled
// branches, lock.stacks + verify --source re-derivation, and the scaffold stamp.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CLI, FW, run, suite } from './helpers.mjs';

const { TMP, PACK, reset, makePack, makeRepo, setup, commitAll } = suite('stacks');

const { detectStacks, normalizeStackList } =
  await import(pathToFileURL(path.join(FW, 'lib', 'stacks.mts')).href);
const { applyMarkers } =
  await import(pathToFileURL(path.join(FW, 'lib', 'markers.mts')).href);

const MARKED = `
<!-- stack-node:on -->
NODE-BRANCH-LINE
<!-- stack-node:end -->
<!-- stack-jvm:on -->
JVM-BRANCH-LINE
<!-- stack-jvm:end -->
<!-- stack-php:on -->
PHP-BRANCH-LINE
<!-- stack-php:end -->
<!-- stack-python:on -->
PYTHON-BRANCH-LINE
<!-- stack-python:end -->
`;

let repoCore; let repoSvc; let repoPy;
before(async () => {
  await reset();
  await makePack();
  // The pack copy is THIS suite's own: give one shared skill stack branches and declare
  // repo-svc's stack in the deployment (declaration must beat detection).
  await fs.appendFile(path.join(PACK, 'skills', 'fx-plan', 'SKILL.md'), MARKED);
  const depPath = path.join(PACK, 'fxdep', 'deployment.json');
  const dep = JSON.parse(await fs.readFile(depPath, 'utf8'));
  dep.repos.known['repo-svc'].stack = 'jvm';
  await fs.writeFile(depPath, JSON.stringify(dep, null, 2) + '\n');
  await commitAll(PACK, 'stack fixtures');
  repoCore = await makeRepo('repo-core', { 'package.json': '{"name":"core"}\n' });
  repoSvc = await makeRepo('repo-svc', { 'composer.json': '{}\n' }); // detection would say php; declaration says jvm
  repoPy = await makeRepo('repo-py', { 'scripts/rotate.py': 'print(1)\n' }); // plain scripts, no manifest
});
after(reset);

test('unit: detection probes, declaration normalization, open marker vocabulary', async () => {
  assert.deepEqual(await detectStacks(repoCore), ['node']);
  assert.deepEqual(await detectStacks(repoSvc), ['php']);
  const empty = await makeRepo('repo-empty');
  assert.deepEqual(await detectStacks(empty), []);

  // Python: every common manifest, variant requirements layouts, and plain-script repos
  assert.deepEqual(await detectStacks(repoPy), ['python'], 'scripts/*.py with no manifest');
  for (const [file, content] of [
    ['setup.cfg', '[metadata]\nname = x\n'], ['Pipfile', '[packages]\n'], ['environment.yml', 'dependencies: []\n'],
    ['uv.lock', ''], ['poetry.lock', ''], ['pdm.lock', ''], ['requirements-dev.txt', 'pytest\n'],
    ['requirements/base.txt', 'flask\n'], ['tool.py', 'print(1)\n'], ['bin/run.py', 'print(1)\n'],
  ]) assert.deepEqual(await detectStacks(await makeRepo(`py-${file.replace(/[^a-z]/g, '')}`, { [file]: content })), ['python'], file);
  assert.deepEqual(await detectStacks(await makeRepo('py-and-node', { 'package.json': '{}\n', 'pyproject.toml': '' })), ['node', 'python'], 'table order');
  assert.deepEqual(await detectStacks(await makeRepo('py-nested-only', { 'src/app/main.py': '' })), [], 'a .py below the probed dirs is not a scripts repo');

  assert.deepEqual(normalizeStackList('jvm', 't'), ['jvm']);
  assert.deepEqual(normalizeStackList(['php', 'node', 'php'], 't'), ['node', 'php']);
  assert.deepEqual(normalizeStackList(undefined, 't'), []);
  assert.throws(() => normalizeStackList('Not Valid!', 't'), /invalid stack name/);

  // stack-* keys are an open vocabulary: absent = OFF (branch compiles out), never a
  // lint failure; capability keys stay strict.
  const text = 'A\n<!-- stack-elixir:on -->\nE\n<!-- stack-elixir:end -->\nB';
  assert.equal(applyMarkers(text, { kaut: true }), 'A\nB');
  assert.throws(() => applyMarkers('<!-- warp:on -->\nx\n<!-- warp:end -->', { kaut: true }), /unknown capability "warp"/);
});

test('e2e: compiled skill carries exactly the connected stacks; declaration beats detection; lock records; verify --source passes', async () => {
  const { ws, stdout } = await setup('stack-ws', {
    deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [],
    repos: [repoCore, repoSvc, repoPy],
  });
  assert.match(stdout, /stacks\s+jvm \+ node \+ python/);

  const skill = await fs.readFile(path.join(ws, '.claude', 'skills', 'fx-plan', 'SKILL.md'), 'utf8');
  assert.match(skill, /NODE-BRANCH-LINE/, 'node branch survives (repo-core detected)');
  assert.match(skill, /JVM-BRANCH-LINE/, 'jvm branch survives (repo-svc declared)');
  assert.ok(!skill.includes('PHP-BRANCH-LINE'), 'php branch compiles out (declaration beats composer.json detection)');
  assert.match(skill, /PYTHON-BRANCH-LINE/, 'python branch survives (repo-py detected as a plain-script repo)');
  assert.ok(!skill.includes('stack-node:on'), 'marker lines never ship');

  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.deepEqual(lock.stacks, ['jvm', 'node', 'python']);

  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  const rows = Object.fromEntries(manifest.repos.map((r) => [r.name, r]));
  assert.deepEqual(rows['repo-core'].stacks, ['node']);
  assert.equal(rows['repo-core'].stack, undefined, 'no declaration for repo-core');
  assert.equal(rows['repo-svc'].stack, 'jvm', 'declaration recorded as input');
  assert.deepEqual(rows['repo-svc'].stacks, ['jvm'], 'resolved outcome recorded');

  // verify --source re-derives the gated artifact from the pinned pack commit using
  // gates rebuilt from the lock (incl. stack-*) — a mismatch would be SOURCE-DRIFT.
  await run(process.execPath, [CLI, 'verify', '--workspace', ws, '--source']);

  // A recompile through repair keeps the same specialization (declaration reconstructed
  // from the manifest, detection re-run live).
  await run(process.execPath, [CLI, 'repair', '--workspace', ws]);
  const lock2 = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.deepEqual(lock2.stacks, ['jvm', 'node', 'python']);
});

test('repo-scaffold stamps the DETECTED toolchain into the skeleton descriptor', async () => {
  const ws = path.join(TMP, 'ws', 'stack-ws');
  await run(process.execPath, [CLI, 'repo-scaffold', '--pack', 'repo-svc', '--workspace', ws]);
  const skeleton = await fs.readFile(path.join(PACK, 'fxdep', 'repos', 'repo-svc', 'CLAUDE.md'), 'utf8');
  assert.match(skeleton, /Detected toolchain\(s\) at scaffold: \*\*php\*\*/, 'scaffold records the scan result (the deployment declaration stays the compile authority)');
});
