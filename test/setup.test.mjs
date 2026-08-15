// Setup surface: payload installation per harness, idempotent re-runs, repo scanning,
// input guards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CLI, exists, run, suite } from './helpers.mjs';

const { TMP, reset, makePack, makeRepo, setup } = suite('setup');

let repoA, repoB, atlasStub;
before(async () => {
  await reset();
  await makePack();
  repoA = await makeRepo('repo-alpha', {
    'CLAUDE.md': '# repo-alpha\nAlways commit and push your changes directly to master.\n',
  });
  repoB = await makeRepo('repo-beta');
  // Enabling Atlas requires a real engine folder (the answers value IS the location).
  atlasStub = path.join(TMP, 'atlas-stub');
  await fs.mkdir(atlasStub, { recursive: true });
  await fs.writeFile(path.join(atlasStub, 'atlas.mjs'), '// engine stub\n');
});
after(reset);

test('claude-code setup, atlas disabled: installs payload, excludes atlas-dependent skills', async () => {
  const { ws, stdout } = await setup('cc-noatlas', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: 'all', repos: [repoA, repoB],
  });

  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.harnesses, ['claude-code']);
  assert.equal(manifest.atlas.enabled, false);
  assert.deepEqual(manifest.flow.stages,
    ['fx-task', 'fx-init', 'fx-plan', 'fx-dispatch', 'fx-verify', 'fx-final']);
  for (const s of ['fx-knowledge', 'fx-bootstrap'])
    assert.ok(!manifest.skills.includes(s), `${s} must be excluded without Atlas`);
  assert.ok(manifest.skills.includes('fx-stack'), 'fx-stack works from manifest runbook values without Atlas');
  assert.ok(manifest.skills.includes('fx-spa'), 'the mock tier skill is atlas-independent');
  assert.equal(manifest.skills.length, 9);
  assert.equal(manifest.agents.length, 7);

  assert.ok(await exists(path.join(ws, '.claude', 'skills', 'fx-init', 'SKILL.md')));
  assert.ok(await exists(path.join(ws, '.claude', 'agents', 'fx-analyst.md')));
  assert.ok(!await exists(path.join(ws, '.claude', 'skills', 'fx-knowledge')));
  const initSkill = await fs.readFile(path.join(ws, '.claude', 'skills', 'fx-init', 'SKILL.md'), 'utf8');
  assert.match(initSkill, /metadata:\n  taut:\n    agents: \[fx-analyst\]/,
    'skill wiring frontmatter (CC-official metadata map) ships with the compiled skill');
  assert.equal(manifest.flowDocs?.[0]?.name, 'fx', 'the flow DOC rides with its skills');

  // The `node ui` launcher: shipped, executable, locked, and actually working.
  assert.ok(((await fs.stat(path.join(ws, 'ui'))).mode & 0o111) !== 0, 'ui launcher is executable');
  const lockNow = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.ok(lockNow.artifacts.some((a) => a.id === 'ui'), 'ui launcher is gate-managed');
  await run(process.execPath, [path.join(ws, 'ui'), 'verify'], { cwd: ws });

  const mcp = JSON.parse(await fs.readFile(path.join(ws, '.mcp.json'), 'utf8'));
  assert.ok(mcp.mcpServers.atlassian, 'jira server key must be "atlassian" (matches artifact tool names)');
  assert.ok(mcp.mcpServers.context7);
  // Servers launch through the workspace launcher (local.env read at server start —
  // no exports); the real spec incl. fixedEnv lives in .taut/mcp-servers.json.
  assert.equal(mcp.mcpServers.atlassian.command, 'node');
  assert.match(mcp.mcpServers.atlassian.args.join(' '), /mcp-launch\.mjs jira/);
  const mcpSpec = JSON.parse(await fs.readFile(path.join(ws, '.taut', 'mcp-servers.json'), 'utf8'));
  assert.equal(mcpSpec.jira.fixedEnv.READ_ONLY_MODE, 'true');
  assert.equal(mcpSpec.jira.command, 'uvx');

  const claudeMd = await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /\.taut\/LAWS\.md/);
  assert.match(claudeMd, /read-only for agents/i);
  assert.match(claudeMd, /Contextual precedence/);
  assert.match(claudeMd, /NEVER modifies member-repo\s+files/);

  const envStat = await fs.stat(path.join(ws, '.taut', 'local.env'));
  assert.equal(envStat.mode & 0o777, 0o600);
  const envText = await fs.readFile(path.join(ws, '.taut', 'local.env'), 'utf8');
  assert.match(envText, /# JIRA_URL — Base URL of your Jira site\./);
  assert.match(envText, /example: https:\/\/your-company\.atlassian\.net/);
  assert.match(envText, /example: jan\.novak@your-company\.com/);
  assert.match(envText, /id\.atlassian\.com\/manage-profile\/security\/api-tokens/);
  assert.match(envText, /^JIRA_API_TOKEN=$/m);
  assert.match(envText, /context7\.com\/dashboard/);

  const local = JSON.parse(await fs.readFile(path.join(ws, '.taut', 'local.json'), 'utf8'));
  assert.equal(local.repoPaths['repo-alpha'], repoA);
  const entry = local.memberInstructionFiles.find((c) => c.repo === 'repo-alpha');
  assert.ok(entry, 'repo-alpha CLAUDE.md must be inventoried');
  assert.ok(entry.signals.includes('git-policy'));
  assert.equal(entry.precedence, undefined, 'precedence is a LAW now, not a recorded choice');
  assert.match(stdout, /instruction file\(s\) across 1 repo/);
  assert.match(stdout, /precedence law: workspace-launched/);

  assert.ok(!await exists(path.join(repoA, 'AGENTS.md')), 'setup must never write into member repos');
});

test('setup re-run repairs drift (idempotent recompile)', async () => {
  const { ws } = await setup('cc-repair', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: 'all', repos: [repoB],
  });
  await fs.appendFile(path.join(ws, '.claude', 'skills', 'fx-plan', 'SKILL.md'), '\ndrift\n');
  await setup('cc-repair', { harness: 'claude-code', atlas: false, skills: 'all', mcp: 'all', repos: [repoB] });
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);
});

test('codex setup: native targets — .agents/skills, .codex/agents TOML, project config.toml', async () => {
  const { ws } = await setup('codex', {
    harness: 'codex', atlas: atlasStub, skills: 'all', mcp: ['jira'], repos: [repoB],
  });
  assert.ok(await exists(path.join(ws, 'AGENTS.md')));
  assert.ok(await exists(path.join(ws, '.agents', 'skills', 'fx-knowledge', 'SKILL.md')));
  assert.ok(await exists(path.join(ws, '.codex', 'agents', 'fx-analyst.toml')));
  assert.ok(!await exists(path.join(ws, '.claude')));
  assert.ok(!await exists(path.join(ws, '.mcp.json')));

  const toml = await fs.readFile(path.join(ws, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /\[mcp_servers\.atlassian\]/);
  // Servers launch through the workspace launcher: local.env is read at server start —
  // no env_vars forwarding, no sourcing before the harness.
  assert.match(toml, /command = "node"/);
  assert.match(toml, /mcp-launch\.mjs", "jira"/);
  assert.ok(!toml.includes('env_vars'), 'no parent-env forwarding — the launcher owns env');
  assert.ok(!toml.includes('[mcp_servers.context7]'), 'only selected servers rendered');
  const codexSpec = JSON.parse(await fs.readFile(path.join(ws, '.taut', 'mcp-servers.json'), 'utf8'));
  assert.match(codexSpec.jira.fixedEnv.READ_ONLY_MODE ?? '', /true/i, 'fixedEnv rides in the spec');
  assert.deepEqual(codexSpec.jira.env, ['JIRA_URL', 'JIRA_USERNAME', 'JIRA_API_TOKEN']);
  assert.ok(await exists(path.join(ws, '.taut', 'mcp-launch.mjs')), 'launcher shipped for codex too');
  assert.match(toml, /\[\[hooks\.PreToolUse\]\]/);
  assert.ok(await exists(path.join(ws, '.taut', 'gate.mjs')), 'gate installed for codex too');

  const agentToml = await fs.readFile(path.join(ws, '.codex', 'agents', 'fx-analyst.toml'), 'utf8');
  assert.match(agentToml, /^name = "fx-analyst"$/m);
  assert.match(agentToml, /developer_instructions = '''/, 'TOML literal string — no backslash/quote mangling of the body');
  assert.ok(!agentToml.includes('allowed-tools'), 'CC frontmatter must be stripped from the body');

  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.equal(manifest.skills.length, 11, 'atlas enabled keeps all 11 skills');
  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.equal(lock.mcp[0].pin, '0.23.0');
});

test('repos:"scan" discovers git repos in the workspace root, skips conductors and non-git dirs', async () => {
  const root = path.join(TMP, 'scanroot');
  for (const n of ['alpha', 'beta']) await fs.mkdir(path.join(root, n, '.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'gamma'), { recursive: true }); // not a git repo
  await fs.mkdir(path.join(root, 'decoy-ws', '.git'), { recursive: true }); // conductor decoy
  await fs.writeFile(path.join(root, 'decoy-ws', 'manifest.json'), '{"framework":"federation"}');

  const ws = path.join(root, 'ws-scan');
  const answersFile = path.join(TMP, 'scan.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'none', harness: 'claude-code', atlas: false, skills: 'all', mcp: [], workspace: ws, repos: 'scan',
  }));
  const { stdout } = await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']);

  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.repos.map((r) => r.name), ['alpha', 'beta']);
  assert.match(stdout, /skipped workspace dir\(s\): decoy-ws/);
  assert.ok(!await exists(path.join(ws, '.taut', 'local.env')), 'no mcp selected → no env file');
});

test('atlas defaults to DISABLED when omitted from answers', async () => {
  const { ws, stdout } = await setup('atlas-default', {
    harness: 'claude-code', skills: 'all', mcp: [], repos: [repoB], // no `atlas` key
  });
  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.equal(manifest.atlas.enabled, false, 'missing atlas key must mean disabled, not an error');
  assert.ok(!manifest.skills.includes('fx-knowledge'), 'atlas-dependent skills excluded under the default');
  assert.match(stdout, /atlas disabled/);
});

test('atlas gating: directives compiled OUT of skills/agents when disabled, kept when enabled', async () => {
  const off = await setup('gating-off', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB],
  });
  for (const rel of ['.claude/skills/fx-init/SKILL.md', '.claude/skills/fx-plan/SKILL.md',
    '.claude/skills/fx-verify/SKILL.md', '.claude/skills/fx-final/SKILL.md',
    '.claude/skills/fx-stack/SKILL.md', '.claude/skills/fx-spa/SKILL.md',
    '.claude/agents/fx-analyst.md', '.claude/agents/fx-researcher.md', '.claude/agents/fx-implementer.md']) {
    const text = await fs.readFile(path.join(off.ws, rel), 'utf8');
    assert.ok(!/atlas lookup|atlas doctor|fx-knowledge|Atlas first|Distill into Atlas|Atlas system store/i.test(text),
      `${rel}: active Atlas directives must be compiled out (descriptions included)`);
    assert.ok(!text.includes('<!-- atlas:') && !/^# atlas:/m.test(text), `${rel}: marker lines must never ship`);
  }
  const finalOff = await fs.readFile(path.join(off.ws, '.claude', 'skills', 'fx-final', 'SKILL.md'), 'utf8');
  assert.match(finalOff, /Durable learnings — record, do not distill/, 'off-branch replacement keeps section numbering');
  const claudeMd = await fs.readFile(path.join(off.ws, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /`atlas` CLI must NOT be invoked/);
  const lock = JSON.parse(await fs.readFile(path.join(off.ws, 'taut.lock'), 'utf8'));
  const entry = lock.artifacts.find((a) => a.id === '.claude/skills/fx-plan/SKILL.md');
  assert.equal(entry?.transform, 'gates', 'gated copies record their transform for verify --source');

  const on = await setup('gating-on', {
    harness: 'claude-code', atlas: atlasStub, skills: 'all', mcp: [], repos: [repoB],
  });
  const planOn = await fs.readFile(path.join(on.ws, '.claude', 'agents', 'fx-researcher.md'), 'utf8');
  assert.match(planOn, /atlas lookup/, 'atlas-on keeps the Atlas branch');
  assert.ok(!planOn.includes('<!-- atlas:'), 'markers stripped in the on mode too');
  const finalOn = await fs.readFile(path.join(on.ws, '.claude', 'skills', 'fx-final', 'SKILL.md'), 'utf8');
  assert.match(finalOn, /Distill into Atlas — delegate/);
  // The knowledge skill is named by ROLE (core hardcodes no content names — the pack's
  // skill declares `role: knowledge`, whatever the skill is called).
  const claudeOn = await fs.readFile(path.join(on.ws, 'CLAUDE.md'), 'utf8');
  assert.match(claudeOn, /Self-maintenance via the `fx-knowledge` skill \(role: knowledge\)/);
});

test('docs role: context7 tools injected + PROACTIVE instruction when installed, absent otherwise', async () => {
  const withDocs = await setup('docs-on', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: ['context7'], repos: [repoB],
  });
  const plan = await fs.readFile(path.join(withDocs.ws, '.claude', 'agents', 'fx-researcher.md'), 'utf8');
  assert.match(plan, /^tools: .*mcp__context7__resolve-library-id, mcp__context7__query-docs$/m,
    'docs tools must be in the subagent allowlist — without them the agent physically cannot call the server');
  assert.match(plan, /docs MCP FIRST, unprompted/i);
  const impl = await fs.readFile(path.join(withDocs.ws, '.claude', 'agents', 'fx-implementer.md'), 'utf8');
  assert.match(impl, /^tools: .*mcp__context7__query-docs$/m);
  assert.match(impl, /consult current docs UNPROMPTED/);
  const skill = await fs.readFile(path.join(withDocs.ws, '.claude', 'skills', 'fx-plan', 'SKILL.md'), 'utf8');
  assert.match(skill, /^allowed-tools: .*mcp__context7__query-docs\]$/m);
  assert.match(skill, /resolve-library-id/);
  const claudeMd = await fs.readFile(path.join(withDocs.ws, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /FIRST stop for any library\/framework API question/);

  const noDocs = await setup('docs-off', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB],
  });
  for (const rel of ['.claude/agents/fx-researcher.md', '.claude/agents/fx-implementer.md',
    '.claude/skills/fx-plan/SKILL.md']) {
    const text = await fs.readFile(path.join(noDocs.ws, rel), 'utf8');
    assert.ok(!text.includes('context7'), `${rel}: no docs server installed → no context7 names (dead-name class stays dead)`);
    assert.match(text, /web\s+search|web docs/i, `${rel}: web fallback branch must be present`);
  }
});

test('data pack resolves from the workspace SIBLING (landscape-root convention)', async () => {
  const root = path.join(TMP, 'sibroot');
  await fs.mkdir(root, { recursive: true });
  await makePack(path.join(root, 'taut-data')); // the pack sits NEXT TO the workspace
  const repo = path.join(root, 'member');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  const ws = path.join(root, 'ws');
  const answersFile = path.join(TMP, 'sib.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'none', harness: 'claude-code', atlas: false, skills: 'all', mcp: [],
    workspace: ws, repos: [repo],
  }));
  // Empty TAUT_DATA disables the env rung — the sibling rung must win on its own.
  await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes'],
    { env: { ...process.env, TAUT_DATA: '' } });
  const local = JSON.parse(await fs.readFile(path.join(ws, '.taut', 'local.json'), 'utf8'));
  assert.equal(local.dataRoot, path.join(root, 'taut-data'), 'sibling pack found and bound');
  assert.ok(await exists(path.join(ws, '.claude', 'skills', 'fx-init', 'SKILL.md')));
  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.ok(lock.data?.commit, 'sibling pack pinned (it is its own git toplevel)');
});

test('guards: unknown skill fails; missing repo folder fails', async () => {
  await assert.rejects(setup('bad-skill', {
    harness: 'claude-code', atlas: atlasStub, skills: ['nope'], mcp: [], repos: [repoB],
  }), /unknown skill/);
  await assert.rejects(setup('bad-repo', {
    harness: 'claude-code', atlas: atlasStub, skills: 'all', mcp: [], repos: [path.join(TMP, 'absent')],
  }), /repo folder not found/);
});
