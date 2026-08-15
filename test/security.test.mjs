// Security regressions: a taut.lock / local.json is an ordinary workspace file the
// integrity gate cannot vouch for, so every value read from one is untrusted. These
// tests prove a TAMPERED lock cannot escalate to code execution (git pins go to argv,
// never a shell) or to data loss outside the workspace (sweep ids are path-contained).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CLI, run, runGate, exists, suite } from './helpers.mjs';

const { TMP, reset, makePack, makeRepo, setup } = suite('security');

let repoB;
before(async () => {
  await reset();
  await makePack();
  repoB = await makeRepo('repo-beta');
});
after(reset);

// S1 — a shell-injection payload in a git pin must never reach a shell. Old code did
// `execSync(\`git rev-list --count ${pin}..HEAD\`)`; a pin of "; touch MARKER; " would run.
test('S1: an injected git pin is rejected, never shell-executed (status)', async () => {
  const { ws } = await setup('inj-status', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const marker = path.join(TMP, 'PWNED_STATUS');
  const lockPath = path.join(ws, 'taut.lock');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  lock.framework.commit = `x; touch ${marker}; echo`;
  if (lock.data) lock.data.commit = `y\`touch ${marker}\``;
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));

  // status exits 1 (not current) — that is fine; the point is it does NOT crash and does
  // NOT run the payload. The bogus pins are reported as unknown, not executed.
  await assert.rejects(
    run(process.execPath, [CLI, 'status', '--workspace', ws]),
    (e) => e.code === 1 && /not found in the framework clone history/.test(e.stdout),
  );
  assert.equal(await exists(marker), false, 'the injected pin must never reach a shell');
});

// S2 — a sweep id that escapes the workspace must not aim the recursive rm outside it.
// Old code did `fs.rm(path.dirname(path.join(ws, id)), { recursive: true })` on any
// payload-shaped id; a traversal id resolved to a sibling dir and wiped it.
test('S2: a traversal artifact id cannot make the sweep delete outside the workspace (repair)', async () => {
  const { ws } = await setup('trav-repair', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const victim = path.join(TMP, 'victim');
  await fs.mkdir(victim, { recursive: true });
  await fs.writeFile(path.join(victim, 'keep.txt'), 'precious instance data');

  // Payload-shaped id (passes the sweep's PAYLOAD prefix) that resolves to victim/SKILL.md,
  // so the pre-fix recursive rm would target dirname === victim.
  const rel = path.relative(path.join(ws, '.claude', 'skills'), path.join(victim, 'SKILL.md'));
  const evilId = path.posix.join('.claude/skills', rel.split(path.sep).join('/'));
  assert.equal(path.resolve(ws, evilId), path.join(victim, 'SKILL.md'), 'test id must resolve into victim');

  const lockPath = path.join(ws, 'taut.lock');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  lock.artifacts.push({ id: evilId, sha256: 'deadbeef' });
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));

  await run(process.execPath, [CLI, 'repair', '--workspace', ws]); // recompiles → runs the sweep
  assert.equal(await exists(path.join(victim, 'keep.txt')), true, 'the sweep must never delete outside the workspace');
});

// S1 (gate) — the shipped gate's sessionstart advisory execs git with a lock pin too.
test('S1: the gate rejects an injected pin in its sessionstart advisory', async () => {
  const { ws } = await setup('inj-gate', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const marker = path.join(TMP, 'PWNED_GATE');
  const lockPath = path.join(ws, 'taut.lock');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  lock.framework.commit = `z; touch ${marker}; echo`;
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));
  // Point the advisory at a real git repo (the pack) so it would run git if unguarded.
  const localPath = path.join(ws, '.taut', 'local.json');
  const local = JSON.parse(await fs.readFile(localPath, 'utf8'));
  local.frameworkRoot = process.env.TAUT_DATA;
  await fs.writeFile(localPath, JSON.stringify(local, null, 2));

  const r = await runGate(ws, 'sessionstart', { session_id: 's-sec' });
  assert.equal(r.code, 0, 'sessionstart is advisory — still exits 0');
  assert.equal(await exists(marker), false, 'the gate must never shell-execute a lock pin');
});
