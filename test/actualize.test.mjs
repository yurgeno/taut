// Actualization surface (update != repair): status contract, staleness detection +
// session-start advisory, re-pin via update, "all"-selection payload follow, orphan sweep.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CLI, FW, ensureFrameworkHistory, exists, run, runGate, suite } from './helpers.mjs';

const { TMP, PACK, reset, makePack, makeRepo, setup, commitAll } = suite('actualize');

let repoB;
before(async () => {
  await reset();
  // These tests fabricate an old pin from the framework's own HEAD~1 — guarantee a
  // checkout that HAS one (a release snapshot / shallow clone does not).
  await ensureFrameworkHistory(TMP);
  await makePack();
  repoB = await makeRepo('repo-beta');
});
after(reset);

const status = async (ws) => {
  const r = await run(process.execPath, [CLI, 'status', '--workspace', ws, '--json']).catch((e) => e);
  return { code: r.code ?? 0, ...JSON.parse(r.stdout) };
};
const readManifest = async (ws) => JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
const fakeOldPin = async (ws) => {
  const lockPath = path.join(ws, 'taut.lock');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  const { stdout } = await run('git', ['-C', FW, 'rev-parse', 'HEAD~1']);
  lock.framework.commit = stdout.trim();
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
};

test('update does NOT claim "already current" when the pack has uncommitted content', async () => {
  // The pilot's inner loop writes new files into the pack (repo descriptors, a dropped-in
  // skill) BEFORE they are committed. Judging the data axis by its commit alone made
  // update report "already current" and install nothing.
  const { ws } = await setup('update-dirty-pack', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const first = await run(process.execPath, [CLI, 'update', '--workspace', ws]);
  assert.match(first.stdout, /already current/, 'a clean, unmoved pack still short-circuits');

  await fs.writeFile(path.join(PACK, 'docs', 'EXTRA.md'), '# extra pack doc\n');
  const second = await run(process.execPath, [CLI, 'update', '--workspace', ws]);
  assert.ok(!/already current/.test(second.stdout), 'a dirty pack must recompile, not claim current');
  assert.ok(await exists(path.join(ws, '.taut', 'docs', 'EXTRA.md')), 'the new pack file installs');
  await fs.rm(path.join(PACK, 'docs', 'EXTRA.md')); // back to a clean tree for the next test
});

test('status: a fresh workspace is ACTUAL (json contract, exit 0)', async () => {
  const { ws } = await setup('st-fresh', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const st = await status(ws);
  assert.equal(st.code, 0);
  assert.equal(st.current, true);
  assert.equal(st.framework.behind, 0);
  assert.deepEqual(st.artifacts.drifted, []);
  assert.equal((await readManifest(ws)).skillsSelection, 'all', 'selection INTENT recorded in the manifest');
});

test('staleness: old pin → status BEHIND, gate advises update at session start, update re-pins', async () => {
  const { ws } = await setup('st-stale', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB],
  });
  await fakeOldPin(ws);

  const st = await status(ws);
  assert.equal(st.code, 1, 'stale workspace exits non-zero');
  assert.equal(st.current, false);
  assert.ok(st.framework.behind >= 1, 'behind count reported');

  const g = await runGate(ws, 'sessionstart', {});
  assert.match(g.stdout, /taut update/, 'session-start advisory names the actualization command');
  assert.match(g.stdout, /ahead of this workspace/);

  const u = await run(process.execPath, [CLI, 'update', '--workspace', ws]);
  assert.match(u.stdout, /Updating framework pin|workspace updated/);
  const after = await status(ws);
  assert.equal(after.current, true, 'update re-pins to the framework HEAD');
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);

  const g2 = await runGate(ws, 'sessionstart', {});
  assert.ok(!/taut update|ahead of this workspace/.test(g2.stdout),
    'staleness advisory gone once actual (a NON-CANONICAL dev-build note may remain)');
});

test('update: an "all" selection follows the shipped payload — installs added, sweeps dropped', async () => {
  const kautStub = path.join(TMP, 'kaut-stub'); // enabling KAUT requires a real engine folder
  await fs.mkdir(kautStub, { recursive: true });
  await fs.writeFile(path.join(kautStub, 'kaut.mjs'), '// engine stub\n');
  const { ws } = await setup('all-follow', {
    harness: 'claude-code', kaut: kautStub, skills: 'all', mcp: [], repos: [repoB],
  });
  assert.ok(await exists(path.join(ws, '.claude', 'skills', 'fx-knowledge', 'SKILL.md')));

  // Simulate the selectable payload shrinking (here: the kaut flag drops 3 skills; a new
  // framework version dropping a skill exercises the same path).
  const m = await readManifest(ws);
  m.kaut.enabled = false;
  await fs.writeFile(path.join(ws, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  let out = (await run(process.execPath, [CLI, 'update', '--workspace', ws])).stdout;
  assert.match(out, /no longer shipped — removing:.*fx-knowledge/);
  assert.ok(!await exists(path.join(ws, '.claude', 'skills', 'fx-knowledge')), 'dropped skill files swept');
  const lock1 = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.ok(!lock1.artifacts.some((a) => a.id.includes('fx-knowledge')));
  assert.equal((await readManifest(ws)).skills.length, 10);

  // And growing again (a new version shipping new skills installs them for "all").
  const m2 = await readManifest(ws);
  m2.kaut.enabled = true;
  await fs.writeFile(path.join(ws, 'manifest.json'), JSON.stringify(m2, null, 2) + '\n');
  out = (await run(process.execPath, [CLI, 'update', '--workspace', ws])).stdout;
  assert.match(out, /new in this version — installing:.*fx-knowledge/);
  assert.ok(await exists(path.join(ws, '.claude', 'skills', 'fx-knowledge', 'SKILL.md')));
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);
});

test('update: a custom selection stays fixed and only advertises new skills', async () => {
  const { ws } = await setup('custom-keep', {
    harness: 'claude-code', kaut: false, skills: ['fx-task'], mcp: [], repos: [repoB],
  });
  assert.equal((await readManifest(ws)).skillsSelection, 'custom');
  await fakeOldPin(ws); // make it non-current so update actually runs
  const { stdout } = await run(process.execPath, [CLI, 'update', '--workspace', ws]);
  assert.match(stdout, /available but not installed \(custom selection kept\)/);
  const m = await readManifest(ws);
  assert.deepEqual(m.skills, ['fx-task'], 'custom selection unchanged by update');
  assert.ok(!await exists(path.join(ws, '.claude', 'skills', 'fx-plan')), 'advertised skill not installed');
});

test('memory/ is instance data: setup re-run, update and repair preserve it byte-for-byte', async () => {
  const { ws } = await setup('memory-keep', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const files = {
    'memory/spec/T-1/report.md': '# agent report\nfindings survive reinstalls\n',
    'memory/telemetry/usage.jsonl': '{"event":"invoke","name":"fx-plan"}\n',
    'memory/notes.md': 'owner scratch\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
    await fs.writeFile(path.join(ws, rel), content);
  }

  // Reinstall (setup into the same folder), then a pin-moving update, then a repair.
  await setup('memory-keep', { harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB] });
  await fakeOldPin(ws);
  await run(process.execPath, [CLI, 'update', '--workspace', ws]);
  await fs.appendFile(path.join(ws, 'CLAUDE.md'), '\ndrift\n');
  await run(process.execPath, [CLI, 'repair', '--workspace', ws]);

  for (const [rel, content] of Object.entries(files))
    assert.equal(await fs.readFile(path.join(ws, rel), 'utf8'), content, `${rel} must survive untouched`);
  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.ok(!lock.artifacts.some((a) => a.id.startsWith('memory/')), 'memory/ is never a locked artifact');
  const claudeMd = await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /INSTANCE data/, 'the guarantee is stated in the generated instructions');
  assert.match(claudeMd, /READ-ONLY as prior art/, 'memory doubles as the knowledge base of past ticket runs');

  // Memory lives OUTSIDE the workspace: workspace memory/ is a
  // symlink to the sibling <ws>-memory — deleting the WHOLE workspace and recompiling
  // it must leave every byte of memory in place.
  assert.ok((await fs.lstat(path.join(ws, 'memory'))).isSymbolicLink(), 'workspace memory/ is a symlink');
  const sibling = `${ws}-memory`;
  assert.equal(await fs.readFile(path.join(sibling, 'notes.md'), 'utf8'), files['memory/notes.md'],
    'contents physically live in the sibling folder');
  await fs.rm(ws, { recursive: true, force: true });
  await setup('memory-keep', { harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB] });
  for (const [rel, content] of Object.entries(files))
    assert.equal(await fs.readFile(path.join(ws, rel), 'utf8'), content,
      `${rel} must survive workspace deletion + recompile`);
});

test('memory externalization: legacy in-workspace dir migrates by rename; both layouts = refusal', async () => {
  const ws = path.join(TMP, 'ws', 'legacy-mem');
  await fs.mkdir(path.join(ws, 'memory', 'spec', 'T-9'), { recursive: true });
  await fs.writeFile(path.join(ws, 'memory', 'spec', 'T-9', 'log.md'), 'old layout\n');
  await setup('legacy-mem', { harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB] });
  const root = path.join(TMP, 'ws', 'legacy-mem-memory');
  assert.equal(await fs.readFile(path.join(root, 'spec', 'T-9', 'log.md'), 'utf8'), 'old layout\n',
    'migrated to the sibling by a single rename');
  assert.ok((await fs.lstat(path.join(ws, 'memory'))).isSymbolicLink());
  assert.equal(await fs.readFile(path.join(ws, 'memory', 'spec', 'T-9', 'log.md'), 'utf8'), 'old layout\n',
    'still addressable through the stable workspace-relative path');
  const local = JSON.parse(await fs.readFile(path.join(ws, '.taut', 'local.json'), 'utf8'));
  assert.equal(local.memoryRoot, root);

  const ws2 = path.join(TMP, 'ws', 'conflict-mem');
  await fs.mkdir(path.join(ws2, 'memory'), { recursive: true });
  await fs.writeFile(path.join(ws2, 'memory', 'a.md'), 'x');
  await fs.mkdir(path.join(TMP, 'ws', 'conflict-mem-memory'), { recursive: true });
  await assert.rejects(
    setup('conflict-mem', { harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB] }),
    /merge them manually/,
  );
});

test('update: already-current workspace is a no-op; repair notes when it also moved the pin', async () => {
  const { ws } = await setup('noop', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const { stdout } = await run(process.execPath, [CLI, 'update', '--workspace', ws]);
  assert.match(stdout, /already current/);

  await fakeOldPin(ws);
  const r = await run(process.execPath, [CLI, 'repair', '--workspace', ws]);
  assert.match(r.stdout, /repair recompiled at the CURRENT framework/, 'honest conflation note (§4.5)');
});

test('update --data-only: pack-only actualization — new skill + descriptor flow in; core must be current', async () => {
  // Isolated pack copy: this test MOVES the pack (new content commits).
  const pack2 = path.join(TMP, 'pack-dataonly');
  await makePack(pack2);
  const root = path.join(TMP, 'dataonly-root');
  for (const n of ['repo-core', 'repo-svc']) await fs.mkdir(path.join(root, n, '.git'), { recursive: true });
  const ws = path.join(root, 'ws');
  const answersFile = path.join(TMP, 'dataonly.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [],
    workspace: ws, repos: 'scan', data: pack2,
  }));
  await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']);
  const lock0 = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));

  // The pack moves: a NEW content skill + a descriptor for the previously uncovered repo.
  await fs.mkdir(path.join(pack2, 'skills', 'fx-fresh'), { recursive: true });
  await fs.writeFile(path.join(pack2, 'skills', 'fx-fresh', 'SKILL.md'),
    '---\nname: fx-fresh\ndescription: new content skill shipped by a data update\n---\n\n# fx-fresh\nBody.\n');
  await fs.mkdir(path.join(pack2, 'fxdep', 'repos', 'repo-svc'), { recursive: true });
  await fs.writeFile(path.join(pack2, 'fxdep', 'repos', 'repo-svc', 'CLAUDE.md'),
    '# repo-svc — repo descriptor\n\nFresh from the pack.\n');
  await commitAll(pack2, 'new content');

  const u = await run(process.execPath, [CLI, 'update', '--workspace', ws, '--data-only']);
  assert.match(u.stdout, /Updating data pin/);
  assert.match(u.stdout, /new in this version — installing:.*fx-fresh/, '"all" follows the pack payload');
  assert.ok(await exists(path.join(ws, '.claude', 'skills', 'fx-fresh', 'SKILL.md')), 'new pack skill installed');
  assert.ok(await exists(path.join(ws, '.taut', 'repos', 'repo-svc', 'CLAUDE.md')), 'new repo descriptor installed');
  const lock1 = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.notEqual(lock1.data.commit, lock0.data.commit, 'data pin re-pinned to the pack HEAD');
  assert.equal(lock1.framework.commit, lock0.framework.commit, 'framework pin untouched');
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);

  // Honesty guard: with the core itself behind, a recompile would render (and re-pin)
  // the CURRENT core tree — a "data-only" update must refuse, not lie about the pin.
  await fakeOldPin(ws);
  await assert.rejects(
    run(process.execPath, [CLI, 'update', '--workspace', ws, '--data-only']),
    /--data-only: the framework core is not current/,
  );
});

test('rename migration: a pre-rename .federation workspace migrates in place on update', async () => {
  const { ws } = await setup('legacy-rename', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: ['context7'], repos: [repoB],
  });
  // Convert the fresh workspace to the pre-rename FEDERATION layout: directory name,
  // lock filename, lock artifact ids — exactly what a workspace compiled before
  // 2026-08-15 carries on disk.
  await fs.rename(path.join(ws, '.taut'), path.join(ws, '.federation'));
  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  for (const a of lock.artifacts) a.id = a.id.replace(/^\.taut\//, '.federation/');
  const { stdout: old } = await run('git', ['-C', FW, 'rev-parse', 'HEAD~1']);
  lock.framework.commit = old.trim(); // a legacy workspace always pins a pre-rename commit
  delete lock.data; // pre-split lock v1: single pin, no data axis
  lock.lockVersion = 1;
  await fs.writeFile(path.join(ws, 'federation.lock'), JSON.stringify(lock, null, 2) + '\n');
  await fs.rm(path.join(ws, 'taut.lock'));
  // A filled secret proves instance files MOVE (never regenerated-empty).
  await fs.appendFile(path.join(ws, '.federation', 'local.env'), 'CONTEXT7_API_KEY=secret123\n');

  // Read-only commands must work on the legacy layout unchanged (lock fallback).
  const st = await status(ws);
  assert.equal(st.framework.behind >= 1, true, 'legacy workspace reads as BEHIND, not broken');

  await run(process.execPath, [CLI, 'update', '--workspace', ws]);
  assert.ok(await exists(path.join(ws, 'taut.lock')), 'lock renamed');
  assert.ok(!await exists(path.join(ws, 'federation.lock')), 'legacy lock removed');
  assert.ok(await exists(path.join(ws, '.taut', 'LAWS.md')), 'core docs land under .taut/');
  assert.ok(await exists(path.join(ws, '.taut', 'gate.mjs')), 'gate lands under .taut/');
  assert.ok(!await exists(path.join(ws, '.federation')), 'legacy dir fully swept');
  assert.match(await fs.readFile(path.join(ws, '.taut', 'local.env'), 'utf8'),
    /CONTEXT7_API_KEY=secret123/, 'filled secrets moved, not regenerated');
  const local = JSON.parse(await fs.readFile(path.join(ws, '.taut', 'local.json'), 'utf8'));
  assert.equal(local.workspace, ws, 'machine binding rewritten under .taut/');
  const lock2 = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.ok(lock2.data?.commit, 'migration writes a lock v2 with the data pin');
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);
});
