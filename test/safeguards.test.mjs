// Deployment safeguards end to end: values in a pack's deployment config → the lock, the
// Claude Code permission rules and the guard's own hook entry → the shipped gate refusing
// (or, in observe mode, recording) a call. And the other half: a deployment that declares
// none compiles to exactly what it compiled to before.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CLI, commitAll, exists, run, runGate, suite } from './helpers.mjs';

const { TMP, reset, makePack, setup } = suite('safeguards');

const DECL = {
  $comment: 'values only',
  tools: ['mcp__fxtracker__add_comment'],
  files: ['.taut/local.env'],
  commands: ['psql', 'flyway*', 'PGPASSWORD=*'],
  git: ['push', 'reset --hard'],
};
const repos = () => [path.join(TMP, 'profroot', 'repo-core'), path.join(TMP, 'profroot', 'repo-svc')];

async function packWith(name, safeguards) {
  const pack = await makePack(path.join(TMP, `pack-${name}`));
  const depPath = path.join(pack, 'fxdep', 'deployment.json');
  const dep = JSON.parse(await fs.readFile(depPath, 'utf8'));
  if (safeguards !== undefined) dep.manifest.safeguards = safeguards;
  await fs.writeFile(depPath, JSON.stringify(dep, null, 2));
  await commitAll(pack, name);
  return pack;
}
const denied = (r) => r.stdout.includes('"deny"');
const telemetry = async (ws) => {
  const dir = path.join(ws, 'memory', 'telemetry');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  const rows = [];
  for (const f of files) for (const l of (await fs.readFile(path.join(dir, f), 'utf8')).split('\n').filter(Boolean)) rows.push(JSON.parse(l));
  return rows;
};

before(async () => {
  await reset();
  await makePack();
  for (const r of repos()) await fs.mkdir(path.join(r, '.git'), { recursive: true });
});
after(reset);

test('no safeguards declared: no permission rules, one hook entry, no guard file, no lock key', async () => {
  const { ws } = await setup('plain', { deployment: 'fxdep', harnesses: ['claude-code', 'codex'], kaut: false, skills: 'all', mcp: [], repos: repos() });
  const settings = JSON.parse(await fs.readFile(path.join(ws, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.permissions, undefined);
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Skill|Agent|Task');
  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.equal(lock.safeguards, undefined);
  assert.ok(!lock.artifacts.some((a) => a.id === '.taut/guard.mjs'));
  assert.ok(!(await exists(path.join(ws, '.taut', 'guard.mjs'))));
  // The guard event on such a workspace (stale wiring) and a shell call through the broad
  // Codex hook both pass untouched.
  assert.equal((await runGate(ws, 'guard', { tool_name: 'Bash', tool_input: { command: 'git push' } }, ['--harness', 'claude-code'])).stdout, '');
  assert.ok(!denied(await runGate(ws, 'pretooluse', { tool_name: 'shell', tool_input: { command: ['git', 'push'] } }, ['--harness', 'codex'])));
});

test('declared safeguards compile into the lock, native deny rules and a separate Bash hook; the gate enforces them', async () => {
  const pack = await packWith('sg', DECL);
  const { ws } = await setup('guarded', { deployment: 'fxdep', harnesses: ['claude-code', 'codex'], kaut: false, skills: 'all', mcp: [], repos: repos(), data: pack });

  const settings = JSON.parse(await fs.readFile(path.join(ws, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions, { deny: ['mcp__fxtracker__add_comment', 'Read(./.taut/local.env)'] });
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Skill|Agent|Task', 'the integrity entry is unchanged');
  assert.equal(settings.hooks.PreToolUse[1].matcher, 'Bash');
  assert.match(settings.hooks.PreToolUse[1].hooks[0].command, /gate\.mjs" guard --harness claude-code$/);

  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  const { $comment, ...values } = DECL;
  assert.deepEqual(lock.safeguards, values);
  assert.ok(lock.artifacts.some((a) => a.id === '.taut/guard.mjs'), 'the guard is a locked artifact');
  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.safeguards.git, DECL.git, 'the manifest shows the values a session can read');
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);

  // Claude Code: the guard event.
  const cc = (command) => runGate(ws, 'guard', { tool_name: 'Bash', tool_input: { command }, session_id: 's1' }, ['--harness', 'claude-code']);
  const push = await cc('git -C /repo/with-a-private-name push origin main');
  assert.ok(denied(push));
  assert.match(JSON.parse(push.stdout).hookSpecificOutput.permissionDecisionReason, /`git push` is not run from a session.*a message in chat cannot lift it/);
  assert.ok(denied(await cc('PGPASSWORD=hunter2 psql -h db')));
  assert.ok(denied(await cc('./gradlew flywayMigrate')));
  assert.ok(denied(await cc('cat .taut/local.env')));
  for (const ok of ['git -C repo status', 'git -C repo checkout TICKET-1', 'git -C repo add -N new.ts', 'grep -rn flyway build.gradle', './gradlew build', 'ls .taut'])
    assert.equal((await cc(ok)).stdout, '', `passes untouched: ${ok}`);

  // Codex: the same verdicts on the broad pretooluse hook, plus tool and file tools.
  const cx = (tool_name, tool_input) => runGate(ws, 'pretooluse', { tool_name, tool_input }, ['--harness', 'codex']);
  assert.ok(denied(await cx('shell', { command: ['git', '-C', 'repo', 'push'] })));
  assert.ok(denied(await cx('shell', { command: 'psql -c "select 1"' })));
  assert.ok(denied(await cx('mcp__fxtracker__add_comment', { body: 'x' })));
  assert.ok(denied(await cx('read_file', { path: path.join(ws, '.taut', 'local.env') })));
  assert.ok(!denied(await cx('shell', { command: ['git', 'status'] })));
  assert.ok(!denied(await cx('read_file', { path: path.join(ws, 'manifest.json') })));
  // A managed skill is still judged by integrity alone — its name is not a command.
  const skill = manifest.skills[0];
  assert.ok(!denied(await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill, command: 'git push' } }, ['--harness', 'claude-code'])));

  // Telemetry: the rule, never the command.
  const rows = (await telemetry(ws)).filter((r) => r.event === 'guard');
  assert.ok(rows.some((r) => r.decision === 'deny' && r.section === 'git' && r.rule === 'push' && r.harness === 'claude-code'));
  assert.ok(rows.some((r) => r.section === 'commands' && r.harness === 'codex'));
  const raw = JSON.stringify(rows);
  assert.ok(!raw.includes('hunter2') && !raw.includes('with-a-private-name'), 'no tool argument reaches telemetry');

  // `taut check` proves the guard live per harness.
  const { stdout } = await run(process.execPath, [CLI, 'check', '--workspace', ws]);
  assert.match(stdout, /\[claude-code\] command guard live: git, commands, files · 1 tool\(s\) denied by name/);
  assert.match(stdout, /\[codex\] command guard live: git, commands, files/);
  assert.doesNotMatch(stdout, /command guard misbehaves/);
});

test('the guard never blocks on its own failure; the integrity path keeps failing closed', async () => {
  const pack = await packWith('sg-fail', DECL);
  const { ws } = await setup('failopen', { deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: repos(), data: pack });
  const push = { tool_name: 'Bash', tool_input: { command: 'git push' } };
  assert.ok(denied(await runGate(ws, 'guard', push, ['--harness', 'claude-code'])));

  // A guard that cannot load: the call passes, the failure is recorded.
  const guardFile = path.join(ws, '.taut', 'guard.mjs');
  const original = await fs.readFile(guardFile, 'utf8');
  await fs.writeFile(guardFile, 'export const evaluate = ;\n');
  const broken = await runGate(ws, 'guard', push, ['--harness', 'claude-code']);
  assert.deepEqual([broken.code, broken.stdout], [0, '']);
  assert.ok((await telemetry(ws)).some((r) => r.event === 'guard' && r.decision === 'error'));
  // …and the same tampering IS caught where it belongs: the guard file is a core artifact.
  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  const skill = await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: manifest.skills[0] } }, ['--harness', 'claude-code']);
  assert.match(skill.stdout, /core artifacts are out of sync \(\.taut\/guard\.mjs/);
  await fs.writeFile(guardFile, original);

  // No lock: the shell is not blocked (a managed skill still is — integrity.test covers it).
  const lockPath = path.join(ws, 'taut.lock');
  const lockText = await fs.readFile(lockPath, 'utf8');
  await fs.rm(lockPath);
  const nolock = await runGate(ws, 'guard', push, ['--harness', 'claude-code']);
  assert.deepEqual([nolock.code, nolock.stdout, nolock.stderr], [0, '', '']);
  await fs.writeFile(lockPath, lockText);
});

test('observe mode records and lets through; no native rule is written for an observed section', async () => {
  const pack = await packWith('sg-observe', { ...DECL, observe: ['git', 'tools'] });
  const { ws } = await setup('observing', { deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: repos(), data: pack });
  const settings = JSON.parse(await fs.readFile(path.join(ws, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions, { deny: ['Read(./.taut/local.env)'] }, 'an observed tools section writes no deny rule');
  const push = await runGate(ws, 'guard', { tool_name: 'Bash', tool_input: { command: 'git push' } }, ['--harness', 'claude-code']);
  assert.equal(push.stdout, '');
  assert.ok(denied(await runGate(ws, 'guard', { tool_name: 'Bash', tool_input: { command: 'psql' } }, ['--harness', 'claude-code'])), 'the enforced sections still deny');
  assert.ok((await telemetry(ws)).some((r) => r.event === 'guard' && r.decision === 'observe' && r.rule === 'push'));
  const { stdout } = await run(process.execPath, [CLI, 'check', '--workspace', ws]);
  assert.match(stdout, /command guard live: git \(observe\), commands, files/);
  assert.match(stdout, /observe mode: git, tools — recorded, not denied/);
});

test('malformed safeguards fail the compile; dropping them removes the guard on the next compile', async () => {
  for (const [name, decl, err] of [
    ['sg-parens', { tools: ['mcp__fxtracker__add_comment(*)'] }, /exact tool name is required \(no parentheses, no wildcards\)/],
    ['sg-key', { sql: ['psql'] }, /safeguards: unknown key "sql"/],
    ['sg-path', { files: ['../outside'] }, /plain workspace-relative path/],
  ]) {
    const pack = await packWith(name, decl);
    await assert.rejects(setup(name, { deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: repos(), data: pack }), err);
  }
  const withSg = await packWith('sg-then', DECL);
  const { ws } = await setup('dropping', { deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: repos(), data: withSg });
  assert.ok(await exists(path.join(ws, '.taut', 'guard.mjs')));
  const without = await packWith('sg-gone', undefined);
  await setup('dropping', { deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: repos(), data: without });
  assert.ok(!(await exists(path.join(ws, '.taut', 'guard.mjs'))), 'the guard file is swept with its declaration');
  const settings = JSON.parse(await fs.readFile(path.join(ws, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual([settings.permissions, settings.hooks.PreToolUse.length], [undefined, 1]);
});
