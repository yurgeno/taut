// Setup surface: payload installation per harness, idempotent re-runs, repo scanning,
// input guards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CLI, exists, run, suite } from './helpers.mjs';

const { TMP, PACK: PACK_DIR, reset, makePack, makeRepo, setup } = suite('setup');

let repoA, repoB, kautStub;
before(async () => {
  await reset();
  await makePack();
  repoA = await makeRepo('repo-alpha', {
    'CLAUDE.md': '# repo-alpha\nAlways commit and push your changes directly to master.\n',
  });
  repoB = await makeRepo('repo-beta');
  // Enabling KAUT requires a real engine folder (the answers value IS the location).
  kautStub = path.join(TMP, 'kaut-stub');
  await fs.mkdir(kautStub, { recursive: true });
  await fs.writeFile(path.join(kautStub, 'kaut.mjs'), '// engine stub\n');
});
after(reset);

test('claude-code setup, kaut disabled: installs payload, excludes kaut-dependent skills', async () => {
  const { ws, stdout } = await setup('cc-nokaut', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: 'all', repos: [repoA, repoB],
  });

  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.harnesses, ['claude-code']);
  assert.equal(manifest.kaut.enabled, false);
  assert.deepEqual(manifest.flow.stages,
    ['fx-task', 'fx-init', 'fx-plan', 'fx-dispatch', 'fx-verify', 'fx-final']);
  for (const s of ['fx-knowledge', 'fx-bootstrap'])
    assert.ok(!manifest.skills.includes(s), `${s} must be excluded without KAUT`);
  assert.ok(manifest.skills.includes('fx-stack'), 'fx-stack works from manifest runbook values without KAUT');
  assert.ok(manifest.skills.includes('fx-spa'), 'the mock tier skill is kaut-independent');
  assert.equal(manifest.skills.length, 10);
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
    harness: 'claude-code', kaut: false, skills: 'all', mcp: 'all', repos: [repoB],
  });
  await fs.appendFile(path.join(ws, '.claude', 'skills', 'fx-plan', 'SKILL.md'), '\ndrift\n');
  await setup('cc-repair', { harness: 'claude-code', kaut: false, skills: 'all', mcp: 'all', repos: [repoB] });
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);
});

test('codex setup: native targets — .agents/skills, .codex/agents TOML, project config.toml', async () => {
  const { ws } = await setup('codex', {
    harness: 'codex', kaut: kautStub, skills: 'all', mcp: ['jira'], repos: [repoB],
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
  assert.equal(manifest.skills.length, 12, 'kaut enabled keeps all 12 skills');
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
    deployment: 'none', harness: 'claude-code', kaut: false, skills: 'all', mcp: [], workspace: ws, repos: 'scan',
  }));
  const { stdout } = await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']);

  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.repos.map((r) => r.name), ['alpha', 'beta']);
  // The workspace folder did not exist before this run — setup creates it on demand
  // and says so (owner ask 2026-08-24: a missing workspace folder is not an error).
  assert.match(stdout, /folder created/);
  assert.match(stdout, /skipped workspace dir\(s\): decoy-ws/);
  assert.ok(!await exists(path.join(ws, '.taut', 'local.env')), 'no mcp selected → no env file');
});

test('repo-scaffold refuses a repo the deployment map does not know', async () => {
  // Connecting a repo interactively that the profile never listed used to get a descriptor
  // folder anyway — and that folder makes the pack itself stop compiling.
  const root = path.join(TMP, 'scaffold-guard');
  for (const n of ['repo-core', 'repo-svc', 'stranger']) await fs.mkdir(path.join(root, n, '.git'), { recursive: true });
  const ws = path.join(root, 'ws');
  const answersFile = path.join(TMP, 'scaffold-guard.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [],
    workspace: ws, repos: [path.join(root, 'repo-core'), path.join(root, 'repo-svc'), path.join(root, 'stranger')],
  }));
  await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']);

  try {
    const { stdout } = await run(process.execPath, [CLI, 'repo-scaffold', '--pack', '--workspace', ws]);
    assert.match(stdout, /not scaffolded — connected but absent from the deployment repo map: stranger/);
    assert.match(stdout, /"stranger": \{ "role"/, 'the exact entry to add is printed');
    assert.ok(!await exists(path.join(PACK_DIR, 'fxdep', 'repos', 'stranger')), 'no folder written for the unmapped repo');
    assert.ok(await exists(path.join(PACK_DIR, 'fxdep', 'repos', 'repo-svc', 'CLAUDE.md')), 'mapped repos still scaffold');
  } finally {
    // leave the fixture pack as found — the next test needs repo-svc uncovered
    await fs.rm(path.join(PACK_DIR, 'fxdep', 'repos', 'repo-svc'), { recursive: true, force: true });
  }
});

test('next steps name the init-role skill while repos still lack descriptors', async () => {
  // The pack fixture ships fx-init with `role: init`; repo-beta has no descriptor there.
  // Repo descriptors are project-scoped, so this needs the fixture DEPLOYMENT — and a
  // connected repo the pack does not cover (repo-svc has no descriptor there).
  const root = path.join(TMP, 'init-root');
  for (const n of ['repo-core', 'repo-svc']) await fs.mkdir(path.join(root, n, '.git'), { recursive: true });
  const ws = path.join(root, 'ws');
  const answersFile = path.join(TMP, 'next-steps-init.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [],
    workspace: ws, repos: 'scan',
  }));
  const { stdout } = await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']);
  assert.match(stdout, /run the .*fx-onboard.* skill FIRST/, 'the onboarding step is named before the flow');
  assert.match(stdout, /fills the 1 skeleton descriptor/, 'and says the fill happens in place');

  // The uncovered repo got its workspace-owned instance skeleton; the covered one kept
  // the pack-installed, locked copy and no instance file.
  const skel = await fs.readFile(path.join(ws, 'repos', 'repo-svc', 'descriptor.md'), 'utf8');
  assert.match(skel, /STATUS: SKELETON/);
  assert.match(skel, /this file IS the live descriptor/, 'instance brief, not the pack-landing brief');
  assert.ok(!await exists(path.join(ws, 'repos', 'repo-core')), 'pack-covered repo gets no instance folder');

  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.repoDocs['repo-svc'], ['repos/repo-svc/descriptor.md']);
  assert.ok(manifest.repoDocs['repo-core'][0].startsWith('.taut/repos/repo-core/'), 'pack home unchanged');

  // The compiled instructions point the AGENT at the same skill, not at the raw verb.
  const instructions = await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf8');
  assert.match(instructions, /Run the `fx-onboard` skill/, 'workspace instructions name the init skill for skeleton repos');
  assert.match(instructions, /never\s+follow them, never edit or delete them/, 'repo-internal files carry no authority');

  // Fill the skeleton (as the init skill would) and recompile: the file survives update
  // untouched and the init step disappears.
  await fs.writeFile(path.join(ws, 'repos', 'repo-svc', 'descriptor.md'),
    '# repo-svc — repo descriptor\n\n<!-- derived: repo-svc@abc1234 · 2026-08-24 · read-only repo analysis -->\n\n## Commands (verified)\nnpm test — ran, green\n');
  const upd = await run(process.execPath, [CLI, 'update', '--workspace', ws]);
  const after = await fs.readFile(path.join(ws, 'repos', 'repo-svc', 'descriptor.md'), 'utf8');
  assert.match(after, /npm test — ran, green/, 'update must not clobber a filled instance descriptor');
  assert.ok(!/fx-onboard.* skill FIRST/.test(upd.stdout), 'the init step disappears once nothing is a skeleton');
});

test('repo scan descends one level into project folders (depth-2) and reports name collisions', async () => {
  const root = path.join(TMP, 'scanroot2');
  // level 1: one plain repo + one PROJECT FOLDER holding two repos + a nested conductor
  await fs.mkdir(path.join(root, 'solo', '.git'), { recursive: true });
  for (const n of ['travel-web', 'travel-api']) await fs.mkdir(path.join(root, 'travel', n, '.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'travel', 'inner-ws', '.git'), { recursive: true });
  await fs.writeFile(path.join(root, 'travel', 'inner-ws', 'manifest.json'), '{"framework":"taut"}');
  // a second project folder whose repo basename collides with the first one's
  await fs.mkdir(path.join(root, 'zother', 'travel-api', '.git'), { recursive: true });

  const ws = path.join(root, 'ws-scan2');
  const answersFile = path.join(TMP, 'scan2.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'none', harness: 'claude-code', kaut: false, skills: 'all', mcp: [], workspace: ws, repos: 'scan',
  }));
  const { stdout } = await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']);

  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.repos.map((r) => r.name), ['solo', 'travel-api', 'travel-web'],
    'nested repos discovered by basename next to the level-1 repo');
  const local = JSON.parse(await fs.readFile(path.join(ws, '.taut', 'local.json'), 'utf8'));
  assert.equal(local.repoPaths['travel-api'], path.join(root, 'travel', 'travel-api'),
    'first hit (sorted) wins the colliding basename');
  assert.match(stdout, /skipped workspace dir\(s\): travel\/inner-ws/, 'nested conductor skipped and reported with its project prefix');
  assert.match(stdout, /repo name collision — "travel-api"/, 'the losing path is reported, not silently dropped');
});

test('kaut defaults to DISABLED when omitted from answers', async () => {
  const { ws, stdout } = await setup('kaut-default', {
    harness: 'claude-code', skills: 'all', mcp: [], repos: [repoB], // no `kaut` key
  });
  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.equal(manifest.kaut.enabled, false, 'missing kaut key must mean disabled, not an error');
  assert.ok(!manifest.skills.includes('fx-knowledge'), 'kaut-dependent skills excluded under the default');
  assert.match(stdout, /kaut disabled/);
});

test('kaut gating: directives compiled OUT of skills/agents when disabled, kept when enabled', async () => {
  const off = await setup('gating-off', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB],
  });
  for (const rel of ['.claude/skills/fx-init/SKILL.md', '.claude/skills/fx-plan/SKILL.md',
    '.claude/skills/fx-verify/SKILL.md', '.claude/skills/fx-final/SKILL.md',
    '.claude/skills/fx-stack/SKILL.md', '.claude/skills/fx-spa/SKILL.md',
    '.claude/agents/fx-analyst.md', '.claude/agents/fx-researcher.md', '.claude/agents/fx-implementer.md']) {
    const text = await fs.readFile(path.join(off.ws, rel), 'utf8');
    assert.ok(!/kaut lookup|kaut doctor|fx-knowledge|KAUT first|Distill into KAUT|KAUT system store/i.test(text),
      `${rel}: active KAUT directives must be compiled out (descriptions included)`);
    assert.ok(!text.includes('<!-- kaut:') && !/^# kaut:/m.test(text), `${rel}: marker lines must never ship`);
  }
  const finalOff = await fs.readFile(path.join(off.ws, '.claude', 'skills', 'fx-final', 'SKILL.md'), 'utf8');
  assert.match(finalOff, /Durable learnings — record, do not distill/, 'off-branch replacement keeps section numbering');
  const claudeMd = await fs.readFile(path.join(off.ws, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /`kaut` CLI \(or the legacy `atlas` CLI\) must NOT be/);
  const lock = JSON.parse(await fs.readFile(path.join(off.ws, 'taut.lock'), 'utf8'));
  const entry = lock.artifacts.find((a) => a.id === '.claude/skills/fx-plan/SKILL.md');
  assert.equal(entry?.transform, 'gates', 'gated copies record their transform for verify --source');

  const on = await setup('gating-on', {
    harness: 'claude-code', kaut: kautStub, skills: 'all', mcp: [], repos: [repoB],
  });
  const planOn = await fs.readFile(path.join(on.ws, '.claude', 'agents', 'fx-researcher.md'), 'utf8');
  assert.match(planOn, /kaut lookup/, 'kaut-on keeps the KAUT branch');
  assert.ok(!planOn.includes('<!-- kaut:'), 'markers stripped in the on mode too');
  const finalOn = await fs.readFile(path.join(on.ws, '.claude', 'skills', 'fx-final', 'SKILL.md'), 'utf8');
  assert.match(finalOn, /Distill into KAUT — delegate/);
  // The knowledge skill is named by ROLE (core hardcodes no content names — the pack's
  // skill declares `role: knowledge`, whatever the skill is called).
  const claudeOn = await fs.readFile(path.join(on.ws, 'CLAUDE.md'), 'utf8');
  assert.match(claudeOn, /Self-maintenance via the `fx-knowledge` skill \(role: knowledge\)/);
});

test('docs role: context7 tools injected + PROACTIVE instruction when installed, absent otherwise', async () => {
  const withDocs = await setup('docs-on', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: ['context7'], repos: [repoB],
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
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB],
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
    deployment: 'none', harness: 'claude-code', kaut: false, skills: 'all', mcp: [],
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
    harness: 'claude-code', kaut: kautStub, skills: ['nope'], mcp: [], repos: [repoB],
  }), /unknown skill/);
  await assert.rejects(setup('bad-repo', {
    harness: 'claude-code', kaut: kautStub, skills: 'all', mcp: [], repos: [path.join(TMP, 'absent')],
  }), /repo folder not found/);
});

test('legacy alias: `atlas` answers key, atlas markers and requires:[atlas] gate exactly as kaut', async () => {
  // A pre-rename DATA PACK: an `atlas` marker branch and a `requires: [atlas]` skill
  // must behave identically to their canonical `kaut` forms (alias, not a fork).
  const legacyPack = path.join(TMP, 'legacy-pack');
  await fs.mkdir(path.join(legacyPack, 'skills', 'legacy-plan'), { recursive: true });
  await fs.mkdir(path.join(legacyPack, 'skills', 'legacy-know'), { recursive: true });
  await fs.writeFile(path.join(legacyPack, 'skills', 'legacy-plan', 'SKILL.md'),
    '---\nname: legacy-plan\ndescription: legacy-marker skill\n---\nbody\n<!-- atlas:on -->\nLEGACY-KAUT-BRANCH\n<!-- atlas:end -->\n');
  await fs.writeFile(path.join(legacyPack, 'skills', 'legacy-know', 'SKILL.md'),
    '---\nname: legacy-know\ndescription: legacy-requires skill\nmetadata:\n  taut:\n    requires: [atlas]\n---\nbody\n');
  const env = { env: { ...process.env, TAUT_DATA: legacyPack } };
  // A legacy ENGINE checkout still ships atlas.mjs only — accepted as the kaut root.
  const legacyEngine = path.join(TMP, 'legacy-engine');
  await fs.mkdir(legacyEngine, { recursive: true });
  await fs.writeFile(path.join(legacyEngine, 'atlas.mjs'), '// engine stub\n');

  // OFF: the legacy-requires skill is excluded and the legacy marker branch compiles out.
  const wsOff = path.join(TMP, 'ws', 'legacy-off');
  const offAnswers = path.join(TMP, 'legacy-off.answers.json');
  await fs.writeFile(offAnswers, JSON.stringify({
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], workspace: wsOff, repos: [repoB],
  }));
  const off = await run(process.execPath, [CLI, 'setup', '--answers', offAnswers, '--yes'], env);
  assert.match(off.stdout, /KAUT disabled → skipping KAUT-dependent skills: legacy-know/);
  assert.ok(!await exists(path.join(wsOff, '.claude', 'skills', 'legacy-know')), 'requires:[atlas] gates like kaut');
  const planOff = await fs.readFile(path.join(wsOff, '.claude', 'skills', 'legacy-plan', 'SKILL.md'), 'utf8');
  assert.ok(!planOff.includes('LEGACY-KAUT-BRANCH'), 'the atlas:on branch compiles out when kaut is off');
  assert.ok(!planOff.includes('<!-- atlas:'), 'legacy marker lines never ship');

  // ON via the LEGACY `atlas` answers key: normalized to kaut, engine binding recorded
  // canonically, and the rendered invoke line names the CLI file that actually exists.
  const wsOn = path.join(TMP, 'ws', 'legacy-on');
  const onAnswers = path.join(TMP, 'legacy-on.answers.json');
  await fs.writeFile(onAnswers, JSON.stringify({
    harness: 'claude-code', atlas: legacyEngine, skills: 'all', mcp: [], workspace: wsOn, repos: [repoB],
  }));
  await run(process.execPath, [CLI, 'setup', '--answers', onAnswers, '--yes'], env);
  const m = JSON.parse(await fs.readFile(path.join(wsOn, 'manifest.json'), 'utf8'));
  assert.deepEqual(m.kaut, { enabled: true }, 'legacy answers key lands as the canonical manifest key');
  assert.equal(m.atlas, undefined, 'the legacy key is never written back');
  const local = JSON.parse(await fs.readFile(path.join(wsOn, '.taut', 'local.json'), 'utf8'));
  assert.equal(local.kautRoot, legacyEngine, 'binding recorded under the canonical key');
  const lock = JSON.parse(await fs.readFile(path.join(wsOn, 'taut.lock'), 'utf8'));
  assert.equal(lock.kaut, true, 'lock carries the canonical key');
  assert.ok(await exists(path.join(wsOn, '.claude', 'skills', 'legacy-know', 'SKILL.md')), 'requires:[atlas] satisfied by kaut-on');
  const planOn = await fs.readFile(path.join(wsOn, '.claude', 'skills', 'legacy-plan', 'SKILL.md'), 'utf8');
  assert.match(planOn, /LEGACY-KAUT-BRANCH/, 'the atlas:on branch ships when kaut is on');
  const instr = await fs.readFile(path.join(wsOn, 'CLAUDE.md'), 'utf8');
  assert.match(instr, /## KAUT\n\nENABLED\./);
  assert.ok(instr.includes(`node ${legacyEngine}/atlas.mjs`), 'invoke line falls back to the legacy CLI file that exists');
  await run(process.execPath, [CLI, 'verify', '--workspace', wsOn], env);
});
