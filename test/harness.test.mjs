// Multi-harness surface: union install (every enabled native set side by side), panel-driven
// toggles (apply --enable-harness/--disable-harness), gate identity routing +
// disabled-identity fail-close, legacy scalar-lock compatibility.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CLI, exists, run, runGate, suite } from './helpers.mjs';
import { startPanel } from '../lib/panel.mts';

const { TMP, reset, makePack, makeRepo, setup } = suite('harness');

let repoB;
before(async () => {
  await reset();
  await makePack();
  repoB = await makeRepo('repo-beta');
});
after(reset);

const skillInput = (name) => ({ tool_name: 'Skill', tool_input: { skill: name } });

test('dual setup: both native sets install side by side; one lock/manifest records the set', async () => {
  const { ws } = await setup('dual', {
    harnesses: ['claude-code', 'codex'], kaut: false, skills: 'all', mcp: ['jira'], repos: [repoB],
  });

  // claude-code set, with its identity-carrying hook wiring
  assert.ok(await exists(path.join(ws, 'CLAUDE.md')));
  assert.ok(await exists(path.join(ws, '.claude', 'skills', 'fx-init', 'SKILL.md')));
  assert.ok(await exists(path.join(ws, '.claude', 'agents', 'fx-analyst.md')));
  assert.ok(await exists(path.join(ws, '.mcp.json')));
  const settings = JSON.parse(await fs.readFile(path.join(ws, '.claude', 'settings.json'), 'utf8'));
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /--harness claude-code/);

  // codex set, same skills as native Agent Skills + rendered subagent TOML
  assert.ok(await exists(path.join(ws, 'AGENTS.md')));
  assert.ok(await exists(path.join(ws, '.agents', 'skills', 'fx-init', 'SKILL.md')));
  assert.ok(await exists(path.join(ws, '.codex', 'agents', 'fx-analyst.toml')));
  const toml = await fs.readFile(path.join(ws, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /\[mcp_servers\.atlassian\]/);
  assert.match(toml, /pretooluse --harness codex/);

  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.harnesses, ['claude-code', 'codex']);
  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.equal(lock.lockVersion, 3);
  assert.deepEqual(lock.harnesses, ['claude-code', 'codex']);
  assert.ok(lock.artifacts.some((a) => a.id === '.claude/skills/fx-init/SKILL.md'));
  assert.ok(lock.artifacts.some((a) => a.id === '.agents/skills/fx-init/SKILL.md'));
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);
});

test('toggle OFF sweeps the harness set (no empty skeletons); toggle ON restores; secrets survive', async () => {
  const { ws } = await setup('toggle', {
    harnesses: 'claude-code,codex', kaut: false, skills: 'all', mcp: ['jira'], repos: [repoB],
  });
  const envPath = path.join(ws, '.taut', 'local.env');
  await fs.writeFile(envPath, 'JIRA_API_TOKEN=secret-stays\n');

  await run(process.execPath, [CLI, 'apply', '--workspace', ws, '--disable-harness', 'codex']);
  assert.ok(!await exists(path.join(ws, 'AGENTS.md')));
  assert.ok(!await exists(path.join(ws, '.agents')));
  assert.ok(!await exists(path.join(ws, '.codex')));
  assert.ok(await exists(path.join(ws, 'CLAUDE.md')), 'the other harness is untouched');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8')).harnesses, ['claude-code']);
  assert.equal(await fs.readFile(envPath, 'utf8'), 'JIRA_API_TOKEN=secret-stays\n', 'filled secrets survive the toggle');
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);

  await run(process.execPath, [CLI, 'apply', '--workspace', ws, '--enable-harness', 'codex']);
  assert.ok(await exists(path.join(ws, 'AGENTS.md')));
  assert.ok(await exists(path.join(ws, '.codex', 'config.toml')));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8')).harnesses, ['claude-code', 'codex']);
  assert.equal(await fs.readFile(envPath, 'utf8'), 'JIRA_API_TOKEN=secret-stays\n');
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);
});

test('the last enabled harness cannot be disabled', async () => {
  const { ws } = await setup('last', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB],
  });
  await assert.rejects(
    run(process.execPath, [CLI, 'apply', '--workspace', ws, '--disable-harness', 'claude-code']),
    /at least one must stay enabled/);
});

test('gate identity: per-harness artifact routing; a disabled identity is fail-closed', async () => {
  const { ws } = await setup('gateid', {
    harnesses: ['claude-code', 'codex'], kaut: false, skills: 'all', mcp: [], repos: [repoB],
  });
  // Drift ONLY the codex copy: claude identity must still pass, codex identity must deny.
  await fs.appendFile(path.join(ws, '.agents', 'skills', 'fx-plan', 'SKILL.md'), '\ndrift\n');
  const cc = await runGate(ws, 'pretooluse', skillInput('fx-plan'), ['--harness', 'claude-code']);
  assert.doesNotMatch(cc.stdout, /"deny"/, 'claude copy is intact — allowed');
  const cx = await runGate(ws, 'pretooluse', skillInput('fx-plan'), ['--harness', 'codex']);
  assert.match(cx.stdout, /"deny"/, 'codex copy drifted — denied for the codex caller');

  // Stale wiring for a since-disabled harness: identity outside the enabled set → deny.
  await run(process.execPath, [CLI, 'repair', '--workspace', ws]);
  await run(process.execPath, [CLI, 'apply', '--workspace', ws, '--disable-harness', 'codex']);
  const stale = await runGate(ws, 'pretooluse', skillInput('fx-plan'), ['--harness', 'codex']);
  assert.match(stale.stdout, /"deny"/);
  assert.match(stale.stdout, /not enabled in this workspace/);
});

test('legacy scalar lock (v2): the gate still governs through the fallback read', async () => {
  const { ws } = await setup('legacy', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const lockPath = path.join(ws, 'taut.lock');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  lock.harness = lock.harnesses[0];
  delete lock.harnesses;
  lock.lockVersion = 2;
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');

  const bare = await runGate(ws, 'pretooluse', skillInput('fx-plan'));
  assert.doesNotMatch(bare.stdout, /"deny"/, 'legacy wiring (no identity) resolves from the scalar');
  const withId = await runGate(ws, 'pretooluse', skillInput('fx-plan'), ['--harness', 'claude-code']);
  assert.doesNotMatch(withId.stdout, /"deny"/);
  await fs.appendFile(path.join(ws, '.claude', 'skills', 'fx-plan', 'SKILL.md'), '\ndrift\n');
  const drifted = await runGate(ws, 'pretooluse', skillInput('fx-plan'));
  assert.match(drifted.stdout, /"deny"/, 'enforcement intact on the legacy lock');
});

test('panel: state exposes the harness set; /api/apply maps the harness payload', async () => {
  const { ws } = await setup('panelh', {
    harnesses: ['claude-code', 'codex'], kaut: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const p = await startPanel(ws, { port: 0 });
  try {
    const base = `http://127.0.0.1:${p.port}`;
    const st = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(st.harnesses, ['claude-code', 'codex']);
    assert.deepEqual(st.harnessesAvailable, ['claude-code', 'codex', 'opencode']);
    assert.deepEqual(st.status.harnesses, ['claude-code', 'codex']);

    const r = await fetch(`${base}/api/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-taut-token': p.token },
      body: JSON.stringify({ harness: { disable: ['codex'] } }),
    });
    const body = await r.json();
    assert.ok(body.ok, body.log);
    const st2 = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(st2.harnesses, ['claude-code']);
    assert.ok(!await exists(path.join(ws, 'AGENTS.md')), 'the toggle really swept the set');
  } finally { await p.close(); }
});
