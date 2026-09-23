// Deployment-profile surface: full manifest generation, mandatory enforcement,
// per-harness model resolution, selection requirements. Runs against the bundled
// generic pack (taut-data/) — deployment fxdep; core never needs real content.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CLI, FW, commitAll, exists, run, runGate, suite } from './helpers.mjs';

const { TMP, reset, makePack, makeRepo, setup } = suite('deployment');

let repoB, repoUnbound;
before(async () => {
  await reset();
  await makePack();
  repoB = await makeRepo('repo-beta');
  repoUnbound = await makeRepo('repo-unbound');
});
after(reset);

test('a deployment with an EMPTY repo map takes every scanned repo (no curation to apply)', async () => {
  // The community starter ships no repos.known: filtering the scan by an empty map used
  // to connect nothing, leaving the user with a repo-less workspace.
  const pack3 = path.join(TMP, 'pack-emptymap');
  await makePack(pack3);
  // A minimal project alongside the fixture one: no repo map, no repo-bound artifacts —
  // the shape the community starter ships.
  await fs.mkdir(path.join(pack3, 'emptydep'), { recursive: true });
  await fs.writeFile(path.join(pack3, 'emptydep', 'deployment.json'), JSON.stringify({
    name: 'emptydep', description: 'no curation', repos: { mandatory: [], known: {} },
  }, null, 2) + '\n');
  await commitAll(pack3, 'empty repo map project');

  const root = path.join(TMP, 'emptymaproot');
  for (const n of ['alpha', 'beta']) await fs.mkdir(path.join(root, n, '.git'), { recursive: true });
  const ws = path.join(root, 'ws');
  const answersFile = path.join(TMP, 'emptymap.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'emptydep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [],
    workspace: ws, repos: 'scan', data: pack3,
  }));
  const { stdout } = await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']);

  const m = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(m.repos.map((r) => r.name), ['alpha', 'beta'], 'both scanned repos connected');
  assert.ok(!/scan excluded/.test(stdout), 'nothing is excluded when there is no curation');
  assert.ok(await exists(path.join(ws, 'repos', 'alpha', 'descriptor.md')), 'each gets its workspace descriptor');
});

test('deployment profile: full manifest, mandatory enforcement, unknown-repo exclusion in scan', async () => {
  const root = path.join(TMP, 'profroot');
  const mandatoryNames = ['repo-core', 'repo-svc'];
  // repo-pdf connects the pdf stack's runbook binding (repo-map lint) so up-pdf
  // generates in this fixture; extra-repo is unknown to the profile.
  for (const n of [...mandatoryNames, 'repo-pdf', 'repo-opt', 'extra-repo'])
    await fs.mkdir(path.join(root, n, '.git'), { recursive: true });
  const ws = path.join(root, 'ws');
  const answersFile = path.join(TMP, 'prof.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [],
    workspace: ws, repos: 'scan',
  }));
  const { stdout } = await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']);

  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.equal(manifest.deployment, 'fxdep');
  assert.equal(manifest.flow.tracker.ticketPattern, 'FX-\\d+');
  assert.ok(manifest.flow.scm && manifest.flow.branch, 'scm + branch blocks generated');
  assert.ok(manifest.defaults && manifest.runtimeTiers && manifest.modelTiers && manifest.stacks && manifest.launcher,
    'profile blocks carried into the manifest');
  const names = manifest.repos.map((r) => r.name);
  for (const m of mandatoryNames) assert.ok(names.includes(m), `${m} mandatory present`);
  assert.ok(names.includes('repo-opt'), 'profile-known optional included by scan');
  assert.ok(!names.includes('extra-repo'), 'unknown repo excluded in scan mode');
  assert.match(stdout, /not in the deployment profile: extra-repo/);
  assert.equal(manifest.repos.find((r) => r.name === 'repo-svc').mandatory, true);
  assert.match(manifest.repos.find((r) => r.name === 'repo-core').role, /frontend SPA/);

  const frontier = manifest.modelTiers.ladder.find((r) => r.tier === 'frontier');
  assert.equal(frontier.model, 'opus', 'claude-code harness resolves the claude model');
  assert.ok(frontier.models, 'per-harness maps retained in the manifest for repair fidelity');

  // Stack bring-up without KAUT: the stack ENGINE (role: stack-engine — fx-stack here)
  // is installed, per-profile wrappers GENERATED from the config's stacks; recipes are
  // runbook FILES (F4), indexed in the manifest.
  assert.ok(manifest.skills.includes('fx-stack'));
  assert.deepEqual(manifest.runbooks.map((r) => r.name), ['ops-shared', 'spa-mock', 'stack-basic', 'stack-pdf'],
    'the deployment runbooks index, name-sorted');
  assert.equal(manifest.stacks.basic.runbook, 'stack-basic', 'stacks reference runbooks by NAME');
  for (const r of manifest.runbooks) {
    assert.equal(r.path, `.taut/runbooks/${r.name}.md`);
    assert.ok(await exists(path.join(ws, r.path)), `${r.name} runbook installed`);
  }
  const basicRb = await fs.readFile(path.join(ws, '.taut', 'runbooks', 'stack-basic.md'), 'utf8');
  assert.match(basicRb, /repo-svc/);
  assert.match(basicRb, /Started SvcApplication/);
  const engine = await fs.readFile(path.join(ws, '.claude', 'skills', 'fx-stack', 'SKILL.md'), 'utf8');
  assert.match(engine, /\.taut\/runbooks\//);
  assert.ok(!/kaut/i.test(engine), 'no kaut directives in the kaut-off stack engine');
  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  for (const w of ['up-basic', 'up-pdf']) {
    const wrapper = await fs.readFile(path.join(ws, '.claude', 'skills', w, 'SKILL.md'), 'utf8');
    assert.match(wrapper, /fx-stack/);
    assert.match(wrapper, new RegExp(`stacks\\.${w.slice(3)}`));
    assert.match(wrapper, new RegExp(`\\.taut/runbooks/stack-${w.slice(3)}\\.md`), 'wrapper points at its runbook file');
    assert.ok(lock.artifacts.some((a) => a.id === `.claude/skills/${w}/SKILL.md`), `${w} locked (gate-managed)`);
  }
  assert.ok(lock.artifacts.some((a) => a.id === '.taut/runbooks/stack-basic.md'), 'runbooks are locked artifacts');
  assert.equal(lock.data?.pack, 'fx-pack', 'lock v2 records the data pack name');
  assert.ok(lock.data?.commit, 'lock v2 pins the data pack commit');
  // The PROJECT layer carries everything: project skills wire project AGENTS, project
  // plain DOCS ship — all from inside the fxdep folder.
  assert.ok(manifest.skills.includes('fx-projskill'), 'project skill part of "all"');
  assert.ok(await exists(path.join(ws, '.claude', 'agents', 'fx-local.md')), 'project-level agent installed');
  assert.ok(await exists(path.join(ws, '.taut', 'docs', 'GUIDE.md')), 'project-level plain doc shipped');
  // REPO DESCRIPTORS (stage 2): installed for connected repos, locked, indexed, taught.
  assert.ok(await exists(path.join(ws, '.taut', 'repos', 'repo-core', 'CLAUDE.md')));
  assert.ok(await exists(path.join(ws, '.taut', 'repos', 'repo-core', 'Style.md')), 'ALL md files of the folder ship');
  assert.ok(await exists(path.join(ws, '.taut', 'repos', 'repo-pdf', 'CLAUDE.md')), 'connected repo-pdf descriptor ships');
  assert.deepEqual(manifest.repoDocs['repo-core'],
    ['.taut/repos/repo-core/CLAUDE.md', '.taut/repos/repo-core/Style.md'], 'manifest index lists the files');
  assert.ok(lock.artifacts.some((a) => a.id === '.taut/repos/repo-core/CLAUDE.md' && a.from === 'data'),
    'repo descriptors are integrity-locked with a data source');
  // Flow docs: the fx flow doc ships because its sequence touches installed skills.
  assert.equal(manifest.flowDocs.length, 1);
  assert.equal(manifest.flowDocs[0].name, 'fx');
  assert.equal(manifest.flowDocs[0].doc, '.taut/docs/FLOW-fx.md');
  assert.ok(await exists(path.join(ws, '.taut', 'docs', 'FLOW-fx.md')));
  const claudeMd = await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /Stack bring-up: `up-basic`, `up-pdf`/);
  assert.match(claudeMd, /SPA mock tier \(cheapest runnable\): `fx-spa`/);
  assert.match(claudeMd, /## Runbooks/);
  assert.match(claudeMd, /FLOW-fx\.md/);
  assert.match(claudeMd, /## Repo descriptors/);
  assert.match(claudeMd, /read BEFORE working in a repo/);
  assert.match(claudeMd, /repo-core: `\.taut\/repos\/repo-core\/CLAUDE\.md`, `\.taut\/repos\/repo-core\/Style\.md`/);
  // Auto-init flag: connected repos the pack does not cover are named in the summary
  // AND in the instructions (the session offers the owner the scaffold+distill loop).
  assert.match(stdout, /2 still SKELETON: repo-opt, repo-svc/);
  assert.match(claudeMd, /Still SKELETON \(scaffolded, not yet generated\): `repo-opt`, `repo-svc`/);
  const mockRung = manifest.runtimeTiers.ladder.find((r) => r.tier === 'spa-mock');
  assert.equal(mockRung.how, 'skill fx-spa');
  assert.equal(mockRung.runbook, 'spa-mock', 'the rung names its runbook');
  const mockRb = await fs.readFile(path.join(ws, '.taut', 'runbooks', 'spa-mock.md'), 'utf8');
  assert.match(mockRb, /dev:mock/);
  const mockSkill = await fs.readFile(path.join(ws, '.claude', 'skills', 'fx-spa', 'SKILL.md'), 'utf8');
  assert.match(mockSkill, /mock backend/);
  assert.ok(!/kaut/i.test(mockSkill), 'kaut-off fx-spa is kaut-clean');

  await run(process.execPath, [CLI, 'repair', '--workspace', ws]);
  const m2 = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.equal(m2.deployment, 'fxdep');
  assert.equal(m2.flow.tracker.ticketPattern, 'FX-\\d+', 'repair preserves profile blocks from the manifest itself');
  assert.equal(m2.modelTiers.ladder.find((r) => r.tier === 'frontier').model, 'opus', 'repair keeps resolved models');
});

test('codex harness: modelTiers resolve to codex models; agent pins map into subagent TOML', async () => {
  const root = path.join(TMP, 'profroot'); // reuses the fixture from the previous test
  const ws = path.join(root, 'ws-codex');
  const answersFile = path.join(TMP, 'prof-codex.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'fxdep', harness: 'codex', kaut: false, skills: 'all', mcp: [],
    workspace: ws, repos: 'scan',
  }));
  await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']);

  const m = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  const frontier = m.modelTiers.ladder.find((r) => r.tier === 'frontier');
  assert.equal(frontier.model, 'gpt-5.6');
  assert.equal(frontier.reasoningEffort, 'high');

  const impl = await fs.readFile(path.join(ws, '.codex', 'agents', 'fx-implementer.toml'), 'utf8');
  assert.match(impl, /^model = "gpt-5\.6"$/m);
  assert.match(impl, /^model_reasoning_effort = "high"$/m);
  assert.ok(!/kaut lookup/i.test(impl), 'kaut gate applies to the Codex TOML body too (this ws has kaut off)');
  const plan = await fs.readFile(path.join(ws, '.codex', 'agents', 'fx-researcher.toml'), 'utf8');
  assert.match(plan, /^model = "gpt-5\.6-terra"$/m);
  assert.match(plan, /^model_reasoning_effort = "medium"$/m);
});

test('multi-harness: modelTiers stay per-harness maps — no flat pin for one harness to mislead the other', async () => {
  const root = path.join(TMP, 'profroot'); // reuses the fixture from the profile test
  const ws = path.join(root, 'ws-dual');
  const answersFile = path.join(TMP, 'prof-dual.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'fxdep', harnesses: ['claude-code', 'codex'], kaut: false, skills: 'all', mcp: [],
    workspace: ws, repos: 'scan',
  }));
  await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']);

  const m = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(m.harnesses, ['claude-code', 'codex']);
  const frontier = m.modelTiers.ladder.find((r) => r.tier === 'frontier');
  assert.equal(frontier.model, undefined, 'no flat model with several harnesses enabled');
  assert.equal(frontier.models['claude-code'], 'opus');
  assert.equal(frontier.models.codex, 'gpt-5.6');
  // The Codex TOML still maps agent pins through the ladder maps directly.
  const impl = await fs.readFile(path.join(ws, '.codex', 'agents', 'fx-implementer.toml'), 'utf8');
  assert.match(impl, /^model = "gpt-5\.6"$/m);
  // Dual session pin: each harness's OWN config surface carries its OWN column.
  const settings = JSON.parse(await fs.readFile(path.join(ws, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'opus');
  const toml = await fs.readFile(path.join(ws, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /^model = "gpt-5\.6"$/m);
});

test('model profile: sessionTier renders into settings/config/instructions/lock; the gate advises on a live mismatch', async () => {
  const root = path.join(TMP, 'profroot'); // ws + ws-codex compiled by the tests above
  const wsCc = path.join(root, 'ws');
  const settings = JSON.parse(await fs.readFile(path.join(wsCc, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'opus', 'workspace settings pin the session model (project > user)');
  assert.equal(settings.effortLevel, 'high');
  const claudeMd = await fs.readFile(path.join(wsCc, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /## Model policy \(harness: claude-code\)/);
  assert.match(claudeMd, /`frontier` \*\*\(session\)\*\*/);
  assert.match(claudeMd, /quick ops[\s\S]*never escalate/i);
  const lock = JSON.parse(await fs.readFile(path.join(wsCc, 'taut.lock'), 'utf8'));
  assert.deepEqual(lock.session['claude-code'], { model: 'opus', effort: 'high' });

  const wsCx = path.join(root, 'ws-codex');
  const toml = await fs.readFile(path.join(wsCx, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /^model = "gpt-5\.6"$/m);
  assert.match(toml, /^model_reasoning_effort = "high"$/m);
  assert.match(await fs.readFile(path.join(wsCx, 'AGENTS.md'), 'utf8'), /## Model policy \(harness: codex\)/);

  // Advisory: alias-family + [1m] flag comparison, session-start only, never blocking.
  const bad = await runGate(wsCc, 'sessionstart', { model: 'claude-sonnet-5' }, ['--harness', 'claude-code']);
  assert.match(bad.stdout, /model policy/);
  const wide = await runGate(wsCc, 'sessionstart', { model: 'claude-opus-5[1m]' }, ['--harness', 'claude-code']);
  assert.match(wide.stdout, /model policy/, 'the wide-context variant of the pinned family still flags');
  const ok = await runGate(wsCc, 'sessionstart', { model: 'claude-opus-5' }, ['--harness', 'claude-code']);
  assert.doesNotMatch(ok.stdout, /model policy/);
});

test('react-demo (the tutorial project) compiles end-to-end: multi-harness, profile, flow, runbook, descriptor', async () => {
  // Runs against the react-pack fixture (formerly the bundled example pack; the engine
  // ships no content since the community-pack split) — it covers model profiles,
  // runbooks, per-repo pack docs and a flow doc, which the fx fixture does not.
  const reactPack = await makePack(path.join(TMP, 'react-pack'), path.join(FW, 'test', 'fixtures', 'react-pack'));
  const root = path.join(TMP, 'reactland');
  await fs.mkdir(path.join(root, 'react-app', '.git'), { recursive: true });
  const ws = path.join(root, 'ws');
  const answersFile = path.join(TMP, 'react.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'react-demo', harnesses: ['claude-code', 'codex'], kaut: false, mode: 'normal',
    skills: ['analyze', 'implement', 'review'], mcp: ['context7'],
    repos: [path.join(root, 'react-app')], workspace: ws, data: reactPack,
  }));
  await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']);

  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.skills, ['analyze', 'implement', 'review']);
  assert.deepEqual(manifest.agents, ['analyst', 'implementer', 'reviewer']);
  assert.deepEqual(manifest.flow.stages, ['analyze', 'implement', 'review']);
  assert.equal(manifest.flowDocs.length, 1);
  assert.equal(manifest.flowDocs[0].name, 'react');
  for (const p of ['.claude/skills/analyze/SKILL.md', '.agents/skills/analyze/SKILL.md',
    '.claude/agents/analyst.md', '.codex/agents/analyst.toml',
    '.taut/runbooks/dev-server.md', '.taut/repos/react-app/CLAUDE.md',
    '.taut/docs/FLOW-react.md'])
    assert.ok(await exists(path.join(ws, p)), `${p} installed`);
  assert.ok(!await exists(path.join(ws, '.taut', 'docs', 'FLOW-fx.md')),
    'the shared fx flow doc does not ship — its sequence touches nothing installed');

  // Model profile: session pin per harness + agent pin mapped across harnesses.
  const settings = JSON.parse(await fs.readFile(path.join(ws, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'opus');
  assert.equal(settings.effortLevel, 'high');
  const toml = await fs.readFile(path.join(ws, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /^model = "gpt-6-sol"$/m);
  const analystToml = await fs.readFile(path.join(ws, '.codex', 'agents', 'analyst.toml'), 'utf8');
  assert.match(analystToml, /^model = "gpt-6-sol"$/m);
  assert.match(analystToml, /^model_reasoning_effort = "medium"$/m);

  // Project-level LAWS override the pack-level ones in the generated instructions.
  const claudeMd = await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /Git is human-owned/);

  // context7-only wiring; the docs-capability branch stays in the implement skill.
  const mcp = JSON.parse(await fs.readFile(path.join(ws, '.mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['context7']);
  const impl = await fs.readFile(path.join(ws, '.claude', 'skills', 'implement', 'SKILL.md'), 'utf8');
  assert.match(impl, /resolve-library-id/);
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);
});

test('model profile: an unknown sessionTier fails the compile', async () => {
  const badPack = await makePack(path.join(TMP, 'pack-badtier'));
  const depPath = path.join(badPack, 'fxdep', 'deployment.json');
  const dep = JSON.parse(await fs.readFile(depPath, 'utf8'));
  dep.manifest.modelTiers.sessionTier = 'nope';
  await fs.writeFile(depPath, JSON.stringify(dep, null, 2));
  await commitAll(badPack, 'bad tier');
  const root = path.join(TMP, 'profroot');
  await assert.rejects(setup('badtier', {
    deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [],
    repos: [path.join(root, 'repo-core'), path.join(root, 'repo-svc')], data: badPack,
  }), /sessionTier "nope" names no ladder rung/);
});

test('session language: deployment-declared choice — default applies, answers override, apply switches, repair keeps', async () => {
  const langPack = await makePack(path.join(TMP, 'pack-lang'));
  const depPath = path.join(langPack, 'fxdep', 'deployment.json');
  const dep = JSON.parse(await fs.readFile(depPath, 'utf8'));
  dep.manifest.defaults.languages = { documents: 'en', chat: { options: ['ru', 'en', 'cs'], default: 'en' }, tracker: 'cs' };
  await fs.writeFile(depPath, JSON.stringify(dep, null, 2));
  await commitAll(langPack, 'lang choice');
  const root = path.join(TMP, 'profroot');
  const repos = [path.join(root, 'repo-core'), path.join(root, 'repo-svc')];
  const base = { deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos, data: langPack };

  // No answer → the declared default compiles to the FLAT manifest value; fixed keys ride untouched.
  const { ws } = await setup('lang-default', base);
  let m = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.equal(m.defaults.languages.chat, 'en', 'default resolved to the flat code');
  assert.equal(m.defaults.languages.tracker, 'cs', 'fixed keys pass through untouched');
  const instr = await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf8');
  assert.match(instr, /Session language: English/);
  assert.match(instr, /chosen at setup/);

  // Explicit answer wins; an unknown code fails the setup.
  const { ws: wsRu } = await setup('lang-ru', { ...base, chatLanguage: 'ru' });
  m = JSON.parse(await fs.readFile(path.join(wsRu, 'manifest.json'), 'utf8'));
  assert.equal(m.defaults.languages.chat, 'ru');
  assert.match(await fs.readFile(path.join(wsRu, 'CLAUDE.md'), 'utf8'), /Session language: Russian/);
  await assert.rejects(setup('lang-bad', { ...base, chatLanguage: 'de' }), /unknown session language "de"/);

  // apply --chat-language recompiles to the new choice; unknown code refused; repair keeps it.
  await run(process.execPath, [CLI, 'apply', '--workspace', wsRu, '--chat-language', 'cs']);
  m = JSON.parse(await fs.readFile(path.join(wsRu, 'manifest.json'), 'utf8'));
  assert.equal(m.defaults.languages.chat, 'cs');
  assert.match(await fs.readFile(path.join(wsRu, 'CLAUDE.md'), 'utf8'), /Session language: Czech/);
  await assert.rejects(run(process.execPath, [CLI, 'apply', '--workspace', wsRu, '--chat-language', 'de']),
    /unknown session language "de"/);
  await run(process.execPath, [CLI, 'repair', '--workspace', wsRu]);
  m = JSON.parse(await fs.readFile(path.join(wsRu, 'manifest.json'), 'utf8'));
  assert.equal(m.defaults.languages.chat, 'cs', 'repair keeps the chosen language');
  await run(process.execPath, [CLI, 'verify', '--workspace', wsRu]);
});

test('session language: a FLAT declaration never asks and cannot be overridden', async () => {
  const flatPack = await makePack(path.join(TMP, 'pack-langflat'));
  const depPath = path.join(flatPack, 'fxdep', 'deployment.json');
  const dep = JSON.parse(await fs.readFile(depPath, 'utf8'));
  dep.manifest.defaults.languages = { documents: 'en', chat: 'en', tracker: 'cs' };
  await fs.writeFile(depPath, JSON.stringify(dep, null, 2));
  await commitAll(flatPack, 'flat lang');
  const root = path.join(TMP, 'profroot');
  const repos = [path.join(root, 'repo-core'), path.join(root, 'repo-svc')];
  const base = { deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos, data: flatPack };
  const { ws } = await setup('lang-flat', base);
  const m = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.equal(m.defaults.languages.chat, 'en', 'flat value passes through');
  assert.match(await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf8'), /fixed by the deployment/);
  await assert.rejects(setup('lang-flat2', { ...base, chatLanguage: 'ru' }), /declares no session-language choice/);
  await assert.rejects(run(process.execPath, [CLI, 'apply', '--workspace', ws, '--chat-language', 'ru']),
    /declares no session-language choice/);
});

test('session language: the "auto" sentinel renders the mirror-the-developer instruction, asks nothing', async () => {
  const autoPack = await makePack(path.join(TMP, 'pack-langauto'));
  const depPath = path.join(autoPack, 'fxdep', 'deployment.json');
  const dep = JSON.parse(await fs.readFile(depPath, 'utf8'));
  dep.manifest.defaults.languages = { documents: 'en', chat: 'auto', tracker: 'cs' };
  await fs.writeFile(depPath, JSON.stringify(dep, null, 2));
  await commitAll(autoPack, 'auto lang');
  const root = path.join(TMP, 'profroot');
  const repos = [path.join(root, 'repo-core'), path.join(root, 'repo-svc')];
  // No chatLanguage key needed — auto is a flat value, setup never asks.
  const { ws } = await setup('lang-auto', {
    deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos, data: autoPack,
  });
  const m = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.equal(m.defaults.languages.chat, 'auto', 'sentinel passes through as the flat value');
  const instr = await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf8');
  assert.match(instr, /Session language: mirror the developer/);
  assert.match(instr, /Mirror the\n?\s*person, not the data/);
  await assert.rejects(run(process.execPath, [CLI, 'apply', '--workspace', ws, '--chat-language', 'en']),
    /declares no session-language choice/);
});

test('kaut: the enabling value IS the engine folder — bare true and a wrong path abort setup', async () => {
  await assert.rejects(setup('kaut-bare', {
    harness: 'claude-code', kaut: true, skills: 'all', mcp: [], repos: [repoB],
  }), /enabling KAUT requires its folder/);
  await assert.rejects(setup('kaut-bad', {
    harness: 'claude-code', kaut: path.join(TMP, 'no-such-kaut'), skills: 'all', mcp: [], repos: [repoB],
  }), /KAUT folder not usable/);

  const engineDir = path.join(TMP, 'kaut-engine');
  await fs.mkdir(engineDir, { recursive: true });
  await fs.writeFile(path.join(engineDir, 'kaut.mjs'), '// engine stub\n');
  const { ws } = await setup('kaut-on', {
    harness: 'claude-code', kaut: engineDir, skills: 'all', mcp: [], repos: [repoB],
  });
  const local = JSON.parse(await fs.readFile(path.join(ws, '.taut', 'local.json'), 'utf8'));
  assert.equal(local.kautRoot, engineDir, 'engine folder recorded as a machine binding');
  const m = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(m.kaut, { enabled: true }, 'manifest keeps the flag only — paths stay machine-local');
  const instr = await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf8');
  assert.match(instr, /## KAUT\n\nENABLED\. Engine: `[^`]*kaut-engine`/);
  assert.ok(instr.includes(`node ${engineDir}/kaut.mjs`), 'instructions carry the invocation');
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);
});

test('deployment profile: missing mandatory repo fails (explicit list and scan)', async () => {
  await assert.rejects(setup('prof-missing', {
    deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB],
  }), /requires repo/);
  const emptyRoot = path.join(TMP, 'prof-empty');
  await fs.mkdir(path.join(emptyRoot, 'lonely', '.git'), { recursive: true });
  const answersFile = path.join(TMP, 'prof-empty.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [],
    workspace: path.join(emptyRoot, 'ws'), repos: 'scan',
  }));
  await assert.rejects(
    run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']),
    /requires repo folder\(s\) not found/,
  );
});

test('flat model: a skills subset carries no flow doc, no agents, no stages — laws still ship (core doc)', async () => {
  const ws = path.join(TMP, 'ws', 'ops-only');
  const answersFile = path.join(TMP, 'ops-only.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'none', harness: 'claude-code', kaut: false,
    skills: ['fx-stack', 'fx-spa'], mcp: [], workspace: ws, repos: [repoB],
  }));
  await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']);

  const m = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.equal(m.flows, undefined, 'the pre-F4 flow-package key never appears');
  assert.deepEqual([...m.skills].sort(), ['fx-spa', 'fx-stack'], 'only the requested skills');
  assert.deepEqual(m.agents, [], 'no installed skill names an agent');
  assert.deepEqual(m.flow.stages, [], 'no chain skill installed');
  assert.deepEqual(m.flowDocs, [], 'no flow doc matches the installed skills');
  assert.ok(!await exists(path.join(ws, '.taut', 'docs', 'FLOW-fx.md')));
  assert.equal(m.laws.text, '.taut/LAWS.md', 'laws are a CORE document — they ship regardless of selection');
  assert.ok(await exists(path.join(ws, '.taut', 'LAWS.md')));
  const claudeMd = await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /no flow-chain skills installed/);
  assert.match(claudeMd, /\*\*Contextual precedence/, 'the precedence law renders');
  assert.match(claudeMd, /Member-repo git is READ-ONLY for agents/, 'law summary from docs/LAWS.md frontmatter');
});

test('repo-map lint: a runbook bound to unconnected repos is excluded, its stack wrapper skipped', async () => {
  const root = path.join(TMP, 'lintroot');
  for (const n of ['repo-core', 'repo-svc', 'repo-opt'])
    await fs.mkdir(path.join(root, n, '.git'), { recursive: true });
  const ws = path.join(root, 'ws');
  const answersFile = path.join(TMP, 'lint.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [],
    workspace: ws, repos: 'scan',
  }));
  const { stdout } = await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']);

  assert.match(stdout, /runbook "stack-pdf" is bound to repo\(s\) not connected.*repo-pdf/);
  assert.match(stdout, /stack "pdf": runbook "stack-pdf" excluded by the repo lint — up-pdf not generated/);
  const m = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(m.runbooks.map((r) => r.name), ['ops-shared', 'spa-mock', 'stack-basic']);
  assert.ok(await exists(path.join(ws, '.claude', 'skills', 'up-basic', 'SKILL.md')));
  assert.ok(!await exists(path.join(ws, '.claude', 'skills', 'up-pdf')), 'no silently dead wrapper');
  assert.ok(!await exists(path.join(ws, '.taut', 'runbooks', 'stack-pdf.md')));
  // Repo descriptors follow connection: repo-pdf is NOT connected here → not installed,
  // not indexed; repo-core is → installed.
  assert.ok(await exists(path.join(ws, '.taut', 'repos', 'repo-core', 'CLAUDE.md')));
  assert.ok(!await exists(path.join(ws, '.taut', 'repos', 'repo-pdf')), 'unconnected repo descriptor skipped');
  assert.equal(m.repoDocs['repo-pdf'], undefined);
});

test('artifact lints fail the compile: unknown repo binding, branch-varying metadata, bad frontmatter', async () => {
  // Each case is its own tiny DATA PACK (deployments/ + project skills inside),
  // pointed at via TAUT_DATA — deployments always live inside the pack now.
  const packRoot = path.join(TMP, 'lint-pack');
  const mk = async (name, files) => {
    const dep = path.join(packRoot, name);
    await fs.mkdir(path.join(dep, 'runbooks'), { recursive: true });
    await fs.mkdir(path.join(dep, 'skills', 'proj-x'), { recursive: true });
    await fs.writeFile(path.join(dep, 'deployment.json'), JSON.stringify({
      name, description: 'lint fixture', repos: { mandatory: [], known: { 'repo-beta': { role: 'member' } } }, manifest: {},
    }));
    for (const [rel, content] of Object.entries(files))
      await fs.writeFile(path.join(dep, rel), content);
  };
  const env = { env: { ...process.env, TAUT_DATA: packRoot } };
  const answers = async (name) => {
    const f = path.join(TMP, `${name}.answers.json`);
    await fs.writeFile(f, JSON.stringify({
      deployment: name, harness: 'claude-code', kaut: false, skills: 'all', mcp: [],
      workspace: path.join(TMP, 'ws', `lint-${name}`), repos: [repoB],
    }));
    return f;
  };

  // (a) a runbook naming a repo outside the deployment config = compile ERROR.
  await mk('unknownrepo', {
    'runbooks/rb.md': '---\nname: rb\ndescription: "x"\nrepos: [ghost-repo]\n---\nbody\n',
    'skills/proj-x/SKILL.md': '---\nname: proj-x\ndescription: ok\n---\nbody\n',
  });
  await assert.rejects(
    run(process.execPath, [CLI, 'setup', '--answers', await answers('unknownrepo'), '--yes'], env),
    /repo binding "ghost-repo" is not in the deployment config/,
  );

  // (b) metadata.taut differing between capability branches = lint error.
  await mk('varymeta', {
    'skills/proj-x/SKILL.md': '---\nname: proj-x\ndescription: ok\n# kaut:on\nmetadata:\n  taut:\n    requires: [kaut]\n# kaut:off\nmetadata:\n  taut: {}\n# kaut:end\n---\nbody\n',
  });
  await assert.rejects(
    run(process.execPath, [CLI, 'setup', '--answers', await answers('varymeta'), '--yes'], env),
    /metadata\.taut must not vary by capability branch/,
  );

  // (c) frontmatter outside the supported subset = lint error, not a silent misparse.
  await mk('badfm', {
    'skills/proj-x/SKILL.md': '---\nname: proj-x\ndescription: >\n  folded scalars are not supported\n---\nbody\n',
  });
  await assert.rejects(
    run(process.execPath, [CLI, 'setup', '--answers', await answers('badfm'), '--yes'], env),
    /unexpected indent|unsupported frontmatter/,
  );

  // (d) a skill bound to an unconnected repo is EXCLUDED with a warning (not installed).
  await mk('skillbind', {
    'skills/proj-x/SKILL.md': '---\nname: proj-x\ndescription: ok\nmetadata:\n  taut:\n    repos: [repo-beta]\n---\nbody\n',
  });
  const wsOk = path.join(TMP, 'ws', 'lint-skillbind');
  await run(process.execPath, [CLI, 'setup', '--answers', await answers('skillbind'), '--yes'], env);
  assert.ok(await exists(path.join(wsOk, '.claude', 'skills', 'proj-x', 'SKILL.md')),
    'binding satisfied when the repo IS connected');
  const f2 = path.join(TMP, 'skillbind2.answers.json');
  await fs.writeFile(f2, JSON.stringify({
    deployment: 'skillbind', harness: 'claude-code', kaut: false, skills: 'all', mcp: [],
    workspace: path.join(TMP, 'ws', 'lint-skillbind2'), repos: [repoUnbound],
  }));
  const r2 = await run(process.execPath, [CLI, 'setup', '--answers', f2, '--yes'], env);
  assert.match(r2.stdout, /skill "proj-x" is bound to repo\(s\) not connected.*repo-beta.*excluded/);
  assert.ok(!await exists(path.join(TMP, 'ws', 'lint-skillbind2', '.claude', 'skills', 'proj-x')));

  // (e) the pre-rename wiring key is refused with a rename hint, never silently ignored.
  await mk('legacykey', {
    'skills/proj-x/SKILL.md': '---\nname: proj-x\ndescription: ok\nmetadata:\n  federation:\n    mcp: [docs]\n---\nbody\n',
  });
  await assert.rejects(
    run(process.execPath, [CLI, 'setup', '--answers', await answers('legacykey'), '--yes'], env),
    /legacy wiring key "metadata\.federation"/,
  );

  // (f) a repo-descriptor folder for a repo the deployment does not know = compile error.
  await mk('ghostdocs', {
    'skills/proj-x/SKILL.md': '---\nname: proj-x\ndescription: ok\n---\nbody\n',
  });
  await fs.mkdir(path.join(packRoot, 'ghostdocs', 'repos', 'ghost-repo'), { recursive: true });
  await fs.writeFile(path.join(packRoot, 'ghostdocs', 'repos', 'ghost-repo', 'CLAUDE.md'), '# ghost\n');
  await assert.rejects(
    run(process.execPath, [CLI, 'setup', '--answers', await answers('ghostdocs'), '--yes'], env),
    /ghostdocs\/repos\/ghost-repo: repo is not in the deployment config/,
  );
});

test('project payload: a deployment dir ships its own skills, compiled and locked', async () => {
  const packRoot = path.join(TMP, 'proj-pack');
  await fs.mkdir(path.join(packRoot, 'demo', 'skills', 'proj-hello'), { recursive: true });
  await fs.writeFile(path.join(packRoot, 'demo', 'deployment.json'), JSON.stringify({
    name: 'demo', description: 'project-payload fixture', repos: { mandatory: [], known: {} }, manifest: {},
  }));
  await fs.writeFile(path.join(packRoot, 'demo', 'skills', 'proj-hello', 'SKILL.md'),
    '---\nname: proj-hello\ndescription: project-specific skill\n---\n\n# proj-hello\nProject payload.\n');
  const ws = path.join(TMP, 'ws', 'proj');
  const answersFile = path.join(TMP, 'proj.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'demo', harness: 'claude-code', kaut: false, skills: 'all', mcp: [],
    workspace: ws, repos: [repoB],
  }));
  await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes'],
    { env: { ...process.env, TAUT_DATA: packRoot } });

  const m = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.ok(m.skills.includes('proj-hello'), 'project skill part of the "all" selection');
  assert.ok(await exists(path.join(ws, '.claude', 'skills', 'proj-hello', 'SKILL.md')));
  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.ok(lock.artifacts.some((a) => a.id === '.claude/skills/proj-hello/SKILL.md'), 'project skill gate-managed');
  assert.equal(lock.data?.commit, null, 'a non-git pack pins commit null (currency not judged)');
});

test('project layer: a project catalog overrides MCP pins; a project LAWS.md overrides the shared laws', async () => {
  const packRoot = path.join(TMP, 'layer-pack');
  // Pack root = the SHARED layer: one skill, laws, a context7 pin the project will beat.
  await fs.mkdir(path.join(packRoot, 'skills', 'base'), { recursive: true });
  await fs.mkdir(path.join(packRoot, 'docs'), { recursive: true });
  await fs.mkdir(path.join(packRoot, 'catalog'), { recursive: true });
  await fs.writeFile(path.join(packRoot, 'skills', 'base', 'SKILL.md'),
    '---\nname: base\ndescription: shared skill\n---\nbody\n');
  await fs.writeFile(path.join(packRoot, 'docs', 'LAWS.md'),
    '---\nsummary:\n  - "Shared law."\n---\n# SHARED laws\n');
  await fs.writeFile(path.join(packRoot, 'catalog', 'mcp.json'), JSON.stringify({
    servers: { context7: { role: 'docs', serverKey: 'context7', package: '@upstash/context7-mcp', pin: '1.0.0', command: 'npx', args: ['-y', '@upstash/context7-mcp@1.0.0'], env: [], fixedEnv: {} } },
    envHelp: {},
  }));
  // The project layer: its own catalog pin + its own LAWS.
  const dep = path.join(packRoot, 'proj');
  await fs.mkdir(path.join(dep, 'catalog'), { recursive: true });
  await fs.mkdir(path.join(dep, 'docs'), { recursive: true });
  await fs.writeFile(path.join(dep, 'deployment.json'), JSON.stringify({
    name: 'proj', description: 'layered fixture', repos: { mandatory: [], known: {} }, manifest: {},
  }));
  await fs.writeFile(path.join(dep, 'catalog', 'mcp.json'), JSON.stringify({
    servers: { context7: { role: 'docs', serverKey: 'context7', package: '@upstash/context7-mcp', pin: '2.0.0', command: 'npx', args: ['-y', '@upstash/context7-mcp@2.0.0'], env: [], fixedEnv: {} } },
    envHelp: {},
  }));
  await fs.writeFile(path.join(dep, 'docs', 'LAWS.md'),
    '---\nsummary:\n  - "Project law wins."\n---\n# PROJECT laws\n');

  const ws = path.join(TMP, 'ws', 'layered');
  const answersFile = path.join(TMP, 'layered.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'proj', harness: 'claude-code', kaut: false, skills: 'all', mcp: ['context7'],
    workspace: ws, repos: [repoB],
  }));
  await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes'],
    { env: { ...process.env, TAUT_DATA: packRoot } });

  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.equal(lock.mcp[0].pin, '2.0.0', 'project catalog pin beats the shared one');
  assert.match(await fs.readFile(path.join(ws, '.taut', 'LAWS.md'), 'utf8'), /PROJECT laws/,
    'project LAWS.md overrides the shared laws');
  const claudeMd = await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /Project law wins\./, 'the summary rendered is the project one');
});

test('deployment selection is required non-interactively when configs exist', async () => {
  const answersFile = path.join(TMP, 'nodepl.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [],
    workspace: path.join(TMP, 'ws', 'nodepl'), repos: [repoB],
  }));
  await assert.rejects(
    run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']),
    /missing config "deployment"/,
  );
});

test('repo-scaffold: auto-init of missing descriptors — skeleton into the pack, fill → update installs', async () => {
  // Isolated pack copy: this test WRITES into the pack (the whole point of scaffold);
  // the suite-shared pack must stay pristine for the other tests.
  const pack2 = path.join(TMP, 'pack-scaffold');
  await makePack(pack2);
  const root = path.join(TMP, 'scafroot');
  for (const n of ['repo-core', 'repo-svc']) await fs.mkdir(path.join(root, n, '.git'), { recursive: true });
  const ws = path.join(root, 'ws');
  const answersFile = path.join(TMP, 'scaf.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'fxdep', harness: 'claude-code', kaut: false, skills: 'all', mcp: [],
    workspace: ws, repos: 'scan', data: pack2,
  }));
  const first = await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']);
  assert.match(first.stdout, /1 still SKELETON: repo-svc/, 'compile flags the not-yet-generated instance descriptor');
  assert.match(await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf8'), /Still SKELETON \(scaffolded, not yet generated\): `repo-svc`/);

  // PACK MODE writes the skeleton INTO THE PACK (project folder), never the repo.
  const s1 = await run(process.execPath, [CLI, 'repo-scaffold', '--pack', '--workspace', ws]);
  assert.match(s1.stdout, /scaffolded 1 repo descriptor skeleton/);
  const scafPath = path.join(pack2, 'fxdep', 'repos', 'repo-svc', 'CLAUDE.md');
  const scaf = await fs.readFile(scafPath, 'utf8');
  assert.match(scaf, /STATUS: SKELETON/);
  assert.match(scaf, /derived: PENDING/);
  assert.match(scaf, /## Distillation brief/);
  assert.match(scaf, /repoPaths/, 'the brief resolves the repo path portably via local.json');
  assert.ok(!await exists(path.join(root, 'repo-svc', 'CLAUDE.md')), 'the member repo itself stays untouched');
  // Idempotent: the fresh skeleton now covers repo-svc; nothing is overwritten.
  const s2 = await run(process.execPath, [CLI, 'repo-scaffold', '--pack', '--workspace', ws]);
  assert.match(s2.stdout, /nothing to scaffold/);
  assert.equal(await fs.readFile(scafPath, 'utf8'), scaf, 'existing file never overwritten');
  await assert.rejects(run(process.execPath, [CLI, 'repo-scaffold', '--pack', 'ghost', '--workspace', ws]), /not connected/);

  // Fill (simulated agent analysis), owner commits the pack, update installs + flag clears.
  await fs.writeFile(scafPath, '# repo-svc — repo descriptor\n\nFilled by analysis.\n');
  await commitAll(pack2, 'repo-svc descriptor');
  const upd = await run(process.execPath, [CLI, 'update', '--workspace', ws]);
  assert.ok(!/still SKELETON/.test(upd.stdout), 'skeleton flag cleared: the pack now covers the repo');
  assert.match(await fs.readFile(path.join(ws, '.taut', 'repos', 'repo-svc', 'CLAUDE.md'), 'utf8'), /Filled by analysis/);
  const m = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(m.repoDocs['repo-svc'], ['.taut/repos/repo-svc/CLAUDE.md'],
    'a pack-covered repo is indexed to the locked home even if a leftover instance file exists');

  // PACK MODE is project-scoped: a `deployment: none` workspace refuses it — but the
  // DEFAULT (workspace instance) mode works everywhere.
  const { ws: wsNone } = await setup('scaf-none', {
    harness: 'claude-code', kaut: false, skills: ['fx-stack'], mcp: [], repos: [repoB],
  });
  await assert.rejects(run(process.execPath, [CLI, 'repo-scaffold', '--pack', '--workspace', wsNone]), /project-scoped/);
  const sNone = await run(process.execPath, [CLI, 'repo-scaffold', '--workspace', wsNone]);
  assert.match(sNone.stdout, /nothing to scaffold|scaffolded/, 'default mode needs no deployment');
});

test('agentSandbox: a declared agent renders sandbox_mode into its Codex TOML; undeclared agents inherit', async () => {
  const sbxPack = await makePack(path.join(TMP, 'pack-sandbox'));
  const depPath = path.join(sbxPack, 'fxdep', 'deployment.json');
  const dep = JSON.parse(await fs.readFile(depPath, 'utf8'));
  dep.manifest.agentSandbox = { $comment: 'values only', 'fx-qa': 'read-only' };
  await fs.writeFile(depPath, JSON.stringify(dep, null, 2));
  // A description over the Agent Skills limit compiles, with a warning naming the skill.
  const initPath = path.join(sbxPack, 'skills', 'fx-init', 'SKILL.md');
  const init = await fs.readFile(initPath, 'utf8');
  await fs.writeFile(initPath, init.replace(
    "description: 'Stage 1 of the fx flow: read the tracker issue and write the intake report.'",
    `description: 'Stage 1 of the fx flow: read the tracker issue and write the intake report. ${'x'.repeat(1100)}'`));
  await commitAll(sbxPack, 'agent sandbox + long description');
  const root = path.join(TMP, 'profroot');
  const repos = [path.join(root, 'repo-core'), path.join(root, 'repo-svc')];
  const { ws, stdout } = await setup('sandbox-codex', {
    deployment: 'fxdep', harnesses: ['claude-code', 'codex'], kaut: false, skills: 'all', mcp: [], repos, data: sbxPack,
  });
  const qa = await fs.readFile(path.join(ws, '.codex', 'agents', 'fx-qa.toml'), 'utf8');
  assert.match(qa, /^sandbox_mode = "read-only"$/m);
  const impl = await fs.readFile(path.join(ws, '.codex', 'agents', 'fx-implementer.toml'), 'utf8');
  assert.doesNotMatch(impl, /sandbox_mode/, 'an undeclared agent keeps inheriting the session sandbox');
  const ccQa = await fs.readFile(path.join(ws, '.claude', 'agents', 'fx-qa.md'), 'utf8');
  assert.doesNotMatch(ccQa, /sandbox/, 'the Claude Code agent source is untouched');
  const { stdout: st } = await run(process.execPath, [CLI, 'status', '--workspace', ws, '--json']);
  const ids = JSON.parse(st).degradations.codex.map((d) => d.id);
  assert.ok(ids.includes('codex-agent-tools') && ids.includes('codex-hook-trust'), 'the registry surfaces both codex records');
  assert.match(stdout, /skill "fx-init": description is \d{4} characters — the Agent Skills limit is 1024/);
  assert.equal((stdout.match(/skill "fx-init": description is/g) ?? []).length, 1, 'warned once, not per harness tree');
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);

  // A rewired gate hook is announced: Codex skips a changed hook until it is re-approved.
  const cfgPath = path.join(ws, '.codex', 'config.toml');
  await fs.writeFile(cfgPath, (await fs.readFile(cfgPath, 'utf8')).replace('pretooluse --harness codex', 'pretooluse --harness codex --old'));
  const { stdout: again } = await run(process.execPath, [CLI, 'repair', '--workspace', ws]);
  assert.match(again, /gate hooks in \.codex\/config\.toml changed — Codex skips changed project hooks until approved/);
  const { stdout: quiet } = await run(process.execPath, [CLI, 'repair', '--workspace', ws]);
  assert.doesNotMatch(quiet, /gate hooks in \.codex\/config\.toml changed/, 'no warning when the hooks are unchanged');
});

test('agentSandbox: an unknown agent or a widening mode fails the compile', async () => {
  const root = path.join(TMP, 'profroot');
  const repos = [path.join(root, 'repo-core'), path.join(root, 'repo-svc')];
  for (const [name, decl, err] of [
    ['sbx-unknown', { 'no-such-agent': 'read-only' }, /agentSandbox names unknown agent "no-such-agent"/],
    ['sbx-wide', { 'fx-qa': 'danger-full-access' }, /"danger-full-access" is not one of read-only \| workspace-write/],
  ]) {
    const pack = await makePack(path.join(TMP, `pack-${name}`));
    const depPath = path.join(pack, 'fxdep', 'deployment.json');
    const dep = JSON.parse(await fs.readFile(depPath, 'utf8'));
    dep.manifest.agentSandbox = decl;
    await fs.writeFile(depPath, JSON.stringify(dep, null, 2));
    await commitAll(pack, name);
    await assert.rejects(setup(name, {
      deployment: 'fxdep', harness: 'codex', kaut: false, skills: 'all', mcp: [], repos, data: pack,
    }), err);
  }
});
