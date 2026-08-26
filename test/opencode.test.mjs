// opencode adapter surface: native-set install (shared .agents/skills tree with codex —
// one copy, one lock row), opencode.json (MCP through the launcher, strict skill
// permissions), rendered .opencode/agents/*.md, the gate plugin artifact, gate identity
// routing for the opencode caller (lowercase native tool names, serverKey-prefixed MCP
// tools), and the harness toggle sweep.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CLI, exists, run, runGate, suite } from './helpers.mjs';

const { TMP, reset, makePack, makeRepo, setup } = suite('opencode');

let repoB;
before(async () => {
  await reset();
  await makePack();
  repoB = await makeRepo('repo-beta');
});
after(reset);

test('opencode setup: native set installs; skills tree is SHARED with codex (single lock row)', async () => {
  const { ws } = await setup('triple', {
    harnesses: ['claude-code', 'codex', 'opencode'], kaut: false, skills: 'all', mcp: ['jira'], repos: [repoB],
  });

  // opencode set
  assert.ok(await exists(path.join(ws, 'opencode.json')));
  assert.ok(await exists(path.join(ws, '.opencode', 'agents', 'fx-analyst.md')));
  assert.ok(await exists(path.join(ws, '.opencode', 'plugins', 'taut-gate.js')));
  const oc = JSON.parse(await fs.readFile(path.join(ws, 'opencode.json'), 'utf8'));
  assert.equal(oc.mcp.atlassian.type, 'local');
  assert.equal(oc.mcp.atlassian.command[0], 'node');
  assert.match(oc.mcp.atlassian.command[1], /mcp-launch\.mjs$/);
  assert.equal(oc.permission, undefined, 'normal mode renders no permission block');

  // rendered opencode agent: frontmatter + the source body
  const agentMd = await fs.readFile(path.join(ws, '.opencode', 'agents', 'fx-analyst.md'), 'utf8');
  assert.match(agentMd, /^---\ndescription: TAUT fx-analyst subagent/);
  assert.match(agentMd, /mode: subagent/);

  // ONE shared .agents/skills copy for codex + opencode: no duplicate lock rows
  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.deepEqual(lock.harnesses, ['claude-code', 'codex', 'opencode']);
  const shared = lock.artifacts.filter((a) => a.id === '.agents/skills/fx-init/SKILL.md');
  assert.equal(shared.length, 1, 'shared tree must produce exactly one lock row');
  assert.equal(new Set(lock.artifacts.map((a) => a.id)).size, lock.artifacts.length, 'no duplicate artifact ids');

  // AGENTS.md is rendered ONCE for the codex+opencode pair and mentions both
  const agentsMd = await fs.readFile(path.join(ws, 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /\$skill-name/, 'codex phrasing present');
  assert.match(agentsMd, /taut-gate\.js/, 'opencode note present');
  assert.equal(lock.artifacts.filter((a) => a.id === 'AGENTS.md').length, 1);

  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);
});

test('gate, opencode identity: lowercase native tools route to the shared/own trees', async () => {
  const { ws } = await setup('gate', {
    harnesses: ['claude-code', 'opencode'], kaut: false, skills: 'all', mcp: ['jira'], repos: [repoB],
  });

  // opencode invokes skills through its native lowercase `skill` tool with {name}
  const ok = await runGate(ws, 'pretooluse', { tool_name: 'skill', tool_input: { name: 'fx-plan' } }, ['--harness', 'opencode']);
  assert.doesNotMatch(ok.stdout, /"deny"/);

  // drift the SHARED copy → denied for the opencode caller, claude copy stays clean
  await fs.appendFile(path.join(ws, '.agents', 'skills', 'fx-plan', 'SKILL.md'), '\ndrift\n');
  const denied = await runGate(ws, 'pretooluse', { tool_name: 'skill', tool_input: { name: 'fx-plan' } }, ['--harness', 'opencode']);
  assert.match(denied.stdout, /"deny"/);
  const cc = await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-plan' } }, ['--harness', 'claude-code']);
  assert.doesNotMatch(cc.stdout, /"deny"/, 'claude copy is intact — allowed');

  // agent routing: drift the opencode agent file → task-tool deny for opencode identity
  await run(process.execPath, [CLI, 'repair', '--workspace', ws]);
  await fs.appendFile(path.join(ws, '.opencode', 'agents', 'fx-analyst.md'), '\ndrift\n');
  const agentDenied = await runGate(ws, 'pretooluse', { tool_name: 'task', tool_input: { subagentType: 'fx-analyst' } }, ['--harness', 'opencode']);
  assert.match(agentDenied.stdout, /"deny"/);
});

test('strict mode: opencode.json carries the native skill allowlist; gate denies foreign artifacts; serverKey-prefixed MCP tools are recognized', async () => {
  const { ws } = await setup('strict', {
    harnesses: ['opencode'], kaut: false, skills: 'all', mcp: ['jira'], repos: [repoB], mode: 'strict',
  });

  const oc = JSON.parse(await fs.readFile(path.join(ws, 'opencode.json'), 'utf8'));
  assert.equal(oc.permission.skill['*'], 'deny');
  assert.equal(oc.permission.skill['fx-init'], 'allow');

  const foreign = await runGate(ws, 'pretooluse', { tool_name: 'skill', tool_input: { name: 'not-ours' } }, ['--harness', 'opencode']);
  assert.match(foreign.stdout, /"deny"/);
  assert.match(foreign.stdout, /not part of the compiled toolchain/);

  // lock-listed MCP server, opencode naming (serverKey_tool) → managed allow
  const mcpOk = await runGate(ws, 'pretooluse', { tool_name: 'atlassian_jira_get_issue', tool_input: {} }, ['--harness', 'opencode']);
  assert.doesNotMatch(mcpOk.stdout, /"deny"/);

  // built-ins stay ungated even in strict
  const builtin = await runGate(ws, 'pretooluse', { tool_name: 'read', tool_input: {} }, ['--harness', 'opencode']);
  assert.doesNotMatch(builtin.stdout, /"deny"/);
});

test('toggle OFF sweeps the opencode set; codex keeps the shared skills tree and AGENTS.md', async () => {
  const { ws } = await setup('toggle', {
    harnesses: ['codex', 'opencode'], kaut: false, skills: 'all', mcp: [], repos: [repoB],
  });
  assert.ok(await exists(path.join(ws, 'opencode.json')));

  await run(process.execPath, [CLI, 'apply', '--workspace', ws, '--disable-harness', 'opencode']);
  assert.ok(!await exists(path.join(ws, 'opencode.json')));
  assert.ok(!await exists(path.join(ws, '.opencode')));
  assert.ok(await exists(path.join(ws, '.agents', 'skills', 'fx-init', 'SKILL.md')), 'codex still owns the shared tree');
  assert.ok(await exists(path.join(ws, 'AGENTS.md')), 'codex still reads AGENTS.md');
  assert.doesNotMatch(await fs.readFile(path.join(ws, 'AGENTS.md'), 'utf8'), /taut-gate\.js/, 'opencode note gone from the re-render');
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);

  // and dropping codex too removes the shared tree with the last reader
  await run(process.execPath, [CLI, 'apply', '--workspace', ws, '--enable-harness', 'claude-code']);
  await run(process.execPath, [CLI, 'apply', '--workspace', ws, '--disable-harness', 'codex']);
  assert.ok(!await exists(path.join(ws, '.agents')));
  assert.ok(!await exists(path.join(ws, 'AGENTS.md')));
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);
});

test('plugin artifact is CORE for the gate: tampering it blocks managed invocations', async () => {
  const { ws } = await setup('plugcore', {
    harnesses: ['opencode'], kaut: false, skills: 'all', mcp: [], repos: [repoB],
  });
  await fs.appendFile(path.join(ws, '.opencode', 'plugins', 'taut-gate.js'), '\n// tamper\n');
  const r = await runGate(ws, 'pretooluse', { tool_name: 'skill', tool_input: { name: 'fx-plan' } }, ['--harness', 'opencode']);
  assert.match(r.stdout, /"deny"/);
  assert.match(r.stdout, /core artifacts are out of sync/);
});
