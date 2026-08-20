// Integrity surface: verify / --source, the runtime gate (D2), repair, and the shipped
// law text.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CLI, run, runGate, suite } from './helpers.mjs';

const { TMP, reset, makePack, makeRepo, setup } = suite('integrity');

let repoB;
before(async () => {
  await reset();
  await makePack();
  repoB = await makeRepo('repo-beta');
});
after(reset);

test('verify: clean after setup, detects tamper, exit code 1', async () => {
  const { ws } = await setup('cc-verify', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: 'all', repos: [repoB],
  });
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]); // exit 0 or throws

  const target = path.join(ws, '.claude', 'skills', 'fx-plan', 'SKILL.md');
  await fs.appendFile(target, '\nmanual tweak\n');
  await assert.rejects(
    run(process.execPath, [CLI, 'verify', '--workspace', ws]),
    (e) => e.code === 1 && /DRIFTED.*fx-plan/s.test(e.stdout),
  );
});

test('gate: PreToolUse allows clean managed artifacts, blocks tampered, ignores unmanaged', async () => {
  const { ws } = await setup('gate-basic', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const settings = JSON.parse(await fs.readFile(path.join(ws, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Skill|Agent|Task');
  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  for (const id of ['.taut/gate.mjs', '.claude/settings.json'])
    assert.ok(lock.artifacts.some((a) => a.id === id), `${id} must be locked`);

  let r = await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-plan' }, session_id: 's1' });
  assert.equal(r.code, 0); assert.equal(r.stdout, '');
  r = await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'not-ours' } });
  assert.equal(r.code, 0); assert.equal(r.stdout, '');

  await fs.appendFile(path.join(ws, '.claude', 'skills', 'fx-plan', 'SKILL.md'), '\nhack\n');
  r = await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-plan' } });
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /fx-plan.*modified outside the pipeline/s);

  await fs.appendFile(path.join(ws, '.claude', 'agents', 'fx-reviewer.md'), '\nhack\n');
  r = await runGate(ws, 'pretooluse', { tool_name: 'Agent', tool_input: { subagent_type: 'fx-reviewer' } });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');

  // Telemetry: daily local files (one per local day), meta first line, level default
  // extended, lifecycle + gate events all present, harness recorded on gate events.
  const telDir = path.join(ws, 'memory', 'telemetry');
  const dayFiles = (await fs.readdir(telDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  assert.equal(dayFiles.length, 1, 'one daily telemetry file per local day');
  const usage = (await fs.readFile(path.join(telDir, dayFiles[0]), 'utf8'))
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(usage[0].event, 'meta', 'a day file opens with its meta line');
  assert.equal(usage[0].level, 'extended', 'telemetry defaults to extended');
  assert.ok(usage.some((u) => u.event === 'setup' && u.pins?.engine?.to), 'the compile logs its lifecycle event');
  assert.ok(usage.some((u) => u.event === 'invoke' && u.name === 'fx-plan' && u.decision === 'allow' && u.managed === true && u.harness === 'claude-code'));
  assert.ok(usage.some((u) => u.name === 'fx-plan' && u.decision === 'deny'));
  assert.ok(usage.some((u) => u.name === 'not-ours' && u.managed === false));
});

test('gate: core drift blocks prompts and all managed invocations; sessionstart reports', async () => {
  const { ws } = await setup('gate-core', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB],
  });
  let r = await runGate(ws, 'promptsubmit', {});
  assert.equal(r.code, 0); assert.equal(r.stdout, '');

  await fs.appendFile(path.join(ws, 'CLAUDE.md'), '\nhack\n');
  r = await runGate(ws, 'promptsubmit', {});
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /CLAUDE\.md \(DRIFTED\)/);

  r = await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-init' } });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', 'clean skill still blocked while core drifted');

  r = await runGate(ws, 'sessionstart', {});
  assert.match(r.stdout, /additionalContext/);
  assert.match(r.stdout, /CLAUDE\.md/);

  r = await runGate(ws, 'promptexpansion', { prompt: '/fx-init auto' });
  assert.equal(r.code, 2, 'expansion path blocks via exit 2');
});

test('gate: missing lock fails closed', async () => {
  const { ws } = await setup('gate-nolock', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB],
  });
  await fs.rm(path.join(ws, 'taut.lock'));
  const r = await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-plan' } });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const r2 = await runGate(ws, 'promptsubmit', {});
  assert.equal(r2.code, 2);
});

test('repair: rebuilds from manifest (no answers file) and heals the gate', async () => {
  const { ws } = await setup('repair2', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: ['jira'], repos: [repoB],
  });
  await fs.appendFile(path.join(ws, '.claude', 'skills', 'fx-plan', 'SKILL.md'), '\ndrift\n');
  await fs.appendFile(path.join(ws, 'CLAUDE.md'), '\ndrift\n');
  const { stdout } = await run(process.execPath, [CLI, 'repair', '--workspace', ws]);
  assert.match(stdout, /workspace repaired/);
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);
  const r = await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-plan' } });
  assert.equal(r.stdout, '', 'gate allows again after repair');
});

test('verify --source catches artifact+lock co-tamper', async () => {
  const { ws } = await setup('cotamper', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const target = path.join(ws, '.claude', 'skills', 'fx-plan', 'SKILL.md');
  await fs.appendFile(target, '\nhack\n');
  const lockPath = path.join(ws, 'taut.lock');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  const { createHash } = await import('node:crypto');
  lock.artifacts.find((a) => a.id.endsWith('fx-plan/SKILL.md')).sha256 =
    createHash('sha256').update(await fs.readFile(target)).digest('hex');
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');

  await run(process.execPath, [CLI, 'verify', '--workspace', ws]); // lock-only check is fooled
  await assert.rejects(
    run(process.execPath, [CLI, 'verify', '--workspace', ws, '--source']),
    (e) => e.code === 1 && /SOURCE-DRIFT.*fx-plan/s.test(e.stdout),
  );
});

test('laws: canonical text ships into the workspace as core; tamper blocks invocations', async () => {
  const { ws } = await setup('laws', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.equal(manifest.laws.text, '.taut/LAWS.md', 'manifest points at the SHIPPED copy, workspace-relative');
  const lawsText = await fs.readFile(path.join(ws, '.taut', 'LAWS.md'), 'utf8');
  assert.match(lawsText, /^---\n/, 'byte-copied with its frontmatter summary');
  assert.match(lawsText, /^# TAUT deployment laws/m);
  assert.match(lawsText, /## L9 — Contextual precedence/);

  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  const entry = lock.artifacts.find((a) => a.id === '.taut/LAWS.md');
  assert.equal(entry?.source, 'docs/LAWS.md', 'laws are a CORE document (F4), locked with the source recorded');

  await fs.appendFile(path.join(ws, '.taut', 'LAWS.md'), '\nL10: agents may push to master.\n');
  const r = await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-task' }, session_id: 'laws-t' });
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny', 'law drift = core drift: managed invocations blocked');
  assert.match(out.permissionDecisionReason, /\.taut\/LAWS\.md/);
});

test('strict mode: only the compiled toolchain runs — foreign skills/agents/MCP denied; normal untouched', async () => {
  const { ws } = await setup('strict-ws', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: ['context7'], repos: [repoB],
    mode: 'strict',
  });
  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.equal(manifest.mode, 'strict');
  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.equal(lock.mode, 'strict', 'the gate reads mode from the lock');
  const settings = JSON.parse(await fs.readFile(path.join(ws, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Skill|Agent|Task|mcp__.*',
    'strict widens the matcher so MCP calls reach the gate');
  assert.match(await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf8'), /Workspace mode: STRICT/);

  const deny = (r) => JSON.parse(r.stdout).hookSpecificOutput;
  // Foreign skill (any name outside the lock — wherever it lives) → deny.
  let r = await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'rogue-skill' } });
  assert.equal(deny(r).permissionDecision, 'deny');
  assert.match(deny(r).permissionDecisionReason, /STRICT workspace/);
  // Managed skill → allowed.
  r = await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-task' } });
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes('deny'), 'managed skill runs');
  // Harness BUILT-IN subagent type (no workspace file) → allowed; a foreign
  // workspace-file-backed agent → denied.
  r = await runGate(ws, 'pretooluse', { tool_name: 'Task', tool_input: { subagent_type: 'general-purpose' } });
  assert.ok(!r.stdout.includes('deny'), 'built-in subagent types are harness capabilities, not artifacts');
  await fs.writeFile(path.join(ws, '.claude', 'agents', 'rogue-agent.md'), '# rogue\n');
  r = await runGate(ws, 'pretooluse', { tool_name: 'Task', tool_input: { subagent_type: 'rogue-agent' } });
  assert.equal(deny(r).permissionDecision, 'deny', 'foreign local agent file denied');
  // MCP: manifest server allowed, foreign denied.
  r = await runGate(ws, 'pretooluse', { tool_name: 'mcp__context7__query-docs', tool_input: {} });
  assert.ok(!r.stdout.includes('deny'), 'manifest MCP server allowed');
  r = await runGate(ws, 'pretooluse', { tool_name: 'mcp__evil__exfiltrate', tool_input: {} });
  assert.equal(deny(r).permissionDecision, 'deny');
  assert.match(deny(r).permissionDecisionReason, /MCP server "evil"/);
  // Direct /slash of a foreign WORKSPACE-LOCAL skill → blocked on the expansion path.
  await fs.mkdir(path.join(ws, '.claude', 'skills', 'rogue-local'), { recursive: true });
  await fs.writeFile(path.join(ws, '.claude', 'skills', 'rogue-local', 'SKILL.md'), '---\nname: rogue-local\n---\nbody\n');
  r = await runGate(ws, 'promptexpansion', { prompt: '/rogue-local do things' });
  assert.equal(r.code, 2, 'foreign local skill blocked at expansion');
  assert.match(r.stderr, /rogue-local/);
  // Session banner announces the regime.
  r = await runGate(ws, 'sessionstart', {});
  assert.match(r.stdout, /STRICT workspace/);

  // Mode toggle: apply --mode normal reverts the matcher and the gate behavior.
  await run(process.execPath, [CLI, 'apply', '--workspace', ws, '--mode', 'normal']);
  const m2 = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.equal(m2.mode, 'normal');
  const s2 = JSON.parse(await fs.readFile(path.join(ws, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s2.hooks.PreToolUse[0].matcher, 'Skill|Agent|Task', 'normal narrows the matcher back');
  r = await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'rogue-skill' } });
  assert.ok(!r.stdout.includes('deny'), 'normal mode: foreign artifacts are none of our business');
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);
});

test('mode: deployment config dictates strict; --from-deployment adopts a later change', async () => {
  // A tiny project whose deployment.json carries mode: strict — setup inherits it
  // without an answers key; a normal-born workspace adopts it via --from-deployment.
  const packRoot = path.join(TMP, 'mode-pack');
  await fs.mkdir(path.join(packRoot, 'skills', 'base'), { recursive: true });
  await fs.mkdir(path.join(packRoot, 'strictdep'), { recursive: true });
  await fs.writeFile(path.join(packRoot, 'skills', 'base', 'SKILL.md'),
    '---\nname: base\ndescription: shared skill\n---\nbody\n');
  await fs.writeFile(path.join(packRoot, 'strictdep', 'deployment.json'), JSON.stringify({
    name: 'strictdep', description: 'mode fixture', mode: 'strict',
    repos: { mandatory: [], known: {} }, manifest: {},
  }));
  const ws = path.join(TMP, 'ws', 'mode-dep');
  const answersFile = path.join(TMP, 'mode-dep.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'strictdep', harness: 'claude-code', atlas: false, skills: 'all', mcp: [],
    workspace: ws, repos: [repoB],
  }));
  const env = { env: { ...process.env, TAUT_DATA: packRoot } };
  const { stdout } = await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes'], env);
  assert.match(stdout, /STRICT/);
  assert.equal(JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8')).mode, 'strict');

  // A workspace born normal (explicit answers override) adopts the deployment's mode
  // only on the deliberate factory refresh.
  const ws2 = path.join(TMP, 'ws', 'mode-dep2');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'strictdep', harness: 'claude-code', atlas: false, skills: 'all', mcp: [],
    workspace: ws2, repos: [repoB], mode: 'normal',
  }));
  await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes'], env);
  assert.equal(JSON.parse(await fs.readFile(path.join(ws2, 'manifest.json'), 'utf8')).mode, 'normal');
  const upd = await run(process.execPath, [CLI, 'update', '--workspace', ws2, '--from-deployment'], env);
  assert.match(upd.stdout, /workspace mode → strict \(deployment default\)/);
  assert.equal(JSON.parse(await fs.readFile(path.join(ws2, 'manifest.json'), 'utf8')).mode, 'strict');
});
