// Artifact maturity: a pack marks a skill (metadata.taut.maturity: draft) or a flow doc
// (frontmatter maturity: draft) as DRAFT — shipped and runnable, not approved for
// production. The compiler must make that visible on every surface it owns (banner in
// the compiled body, manifest, lock, instructions, check) and the gate must print a
// user-facing notice on each invocation — while a stable skill stays byte-identical.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CLI, run, runGate, suite } from './helpers.mjs';

const { PACK, reset, makePack, makeRepo, setup, commitAll } = suite('maturity');

const DRAFT_SKILL = `---
name: fx-draft
description: Fixture DRAFT skill — under evaluation.
user-invocable: true
allowed-tools: [Read]
metadata:
  taut:
    maturity: draft
---

# fx-draft

Body of the draft skill.
`;

const DRAFT_FLOW = `---
name: trial
description: "Fixture draft flow"
sequence: [fx-draft, fx-init]
maturity: draft
---

# FLOW-trial

A draft flow: fx-draft then fx-init.
`;

let repo;
before(async () => {
  await reset();
  await makePack();
  // The suite's own pack copy gets the draft artifacts (the shared fixture stays as is).
  await fs.mkdir(path.join(PACK, 'skills', 'fx-draft'), { recursive: true });
  await fs.writeFile(path.join(PACK, 'skills', 'fx-draft', 'SKILL.md'), DRAFT_SKILL);
  await fs.writeFile(path.join(PACK, 'docs', 'FLOW-trial.md'), DRAFT_FLOW);
  await commitAll(PACK, 'draft fixtures');
  repo = await makeRepo('repo-alpha');
});
after(reset);

test('draft skill: banner in every harness tree, manifest/lock/instructions mark it, stable skills untouched', async () => {
  const { ws, stdout } = await setup('draft', {
    harnesses: ['claude-code', 'codex'], kaut: false, skills: 'all', mcp: 'all', repos: [repo],
  });

  for (const tree of ['.claude/skills', '.agents/skills']) {
    const text = await fs.readFile(path.join(ws, tree, 'fx-draft', 'SKILL.md'), 'utf8');
    assert.match(text, /^---\n[\s\S]*?\n---\n\n> \*\*DRAFT — not approved for production use\.\*\*/, `${tree}: banner right after the frontmatter`);
    assert.match(text, /print this line to the user verbatim: `⚠ fx-draft is a DRAFT skill/);
    assert.match(text, /\n# fx-draft\n/, 'the body follows the banner intact');
    const stable = await fs.readFile(path.join(ws, tree, 'fx-init', 'SKILL.md'), 'utf8');
    assert.ok(!/DRAFT/.test(stable), `${tree}: a stable skill carries no banner`);
  }

  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.skillsDraft, ['fx-draft']);
  const trial = manifest.flowDocs.find((f) => f.name === 'trial');
  assert.equal(trial?.maturity, 'draft', 'the flow doc carries its maturity into the manifest');
  assert.equal(manifest.flowDocs.find((f) => f.name === 'fx').maturity, undefined, 'a stable flow has no maturity key');

  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.deepEqual(lock.draft, ['fx-draft']);
  const row = lock.artifacts.find((a) => a.id === '.claude/skills/fx-draft/SKILL.md');
  assert.equal(row.transform, 'gates+draft');
  assert.equal(lock.artifacts.find((a) => a.id === '.claude/skills/fx-init/SKILL.md').transform, 'gates');

  const claudeMd = await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /`fx-draft` \(draft\)/, 'the stage table tags the draft skill');
  assert.match(claudeMd, /FLOW-trial\.md` \(draft\)/, 'the flow definition is tagged');
  assert.match(claudeMd, /DRAFT skills — shipped for evaluation, NOT approved for production use/);
  const agentsMd = await fs.readFile(path.join(ws, 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /`fx-draft` \(draft\)/);

  // The consistency lint: the draft flow sequences the stable fx-init — said once, as a warning.
  assert.match(stdout, /warning: flow "trial" is marked draft but installs stable skill\(s\) fx-init/);
  assert.match(stdout, /draft\s+1 · fx-draft — not approved for production use/, 'status line names the draft');

  // verify (hash) and verify --source (re-derivation of the banner from the pinned source).
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);
  // --source re-derives every copy artifact from the PINNED commit. On a dev checkout with
  // uncommitted engine files (gate.mjs mid-change) the engine's own copies may drift —
  // that is the dirty tree, not the banner: judge the draft rows, not the exit code.
  const src = await run(process.execPath, [CLI, 'verify', '--workspace', ws, '--source']).catch((e) => e);
  assert.ok(!/SOURCE-DRIFT .*fx-draft/.test(src.stdout), `verify --source must re-derive the banner:\n${src.stdout}`);
  assert.match(src.stdout, /source-check: \d+\/\d+ copy artifact\(s\) match the pin/);

  // `check` surfaces the drafts as a warning, never a failure.
  const chk = await run(process.execPath, [CLI, 'check', '--workspace', ws]);
  assert.match(chk.stdout, /DRAFT skill\(s\) installed — not approved for production use, run at your own risk: fx-draft/);
  assert.match(chk.stdout, /READY/);

  // `render` previews the same bytes the installer wrote.
  const prev = await run(process.execPath, [CLI, 'render', '--skill', 'fx-draft', '--harness', 'claude-code', '--json', '--data', PACK]);
  const rendered = JSON.parse(prev.stdout);
  assert.equal(rendered.transform, 'gates+draft');
  assert.equal(rendered.content, await fs.readFile(path.join(ws, '.claude', 'skills', 'fx-draft', 'SKILL.md'), 'utf8'));
});

test('gate: a user-facing notice on every invocation of a draft skill, silence for a stable one', async () => {
  const { ws } = await setup('draft-gate', {
    harnesses: ['claude-code', 'codex'], kaut: false, skills: 'all', mcp: 'all', repos: [repo],
  });
  const tool = await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-draft' } }, ['--harness', 'claude-code']);
  assert.equal(tool.code, 0);
  const out = JSON.parse(tool.stdout);
  assert.match(out.systemMessage, /"fx-draft" is a DRAFT skill — not yet approved for production use/);
  assert.equal(out.hookSpecificOutput, undefined, 'a notice, never a permission decision');

  const slash = await runGate(ws, 'promptexpansion', { expansion_type: 'slash_command', command_name: 'fx-draft', prompt: '/fx-draft' }, ['--harness', 'claude-code']);
  assert.equal(slash.code, 0);
  assert.match(JSON.parse(slash.stdout).systemMessage, /DRAFT skill/);

  const codex = await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-draft' } }, ['--harness', 'codex']);
  assert.match(JSON.parse(codex.stdout).systemMessage, /DRAFT skill/, 'the shared .agents/skills tree is draft too');

  const stable = await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-init' } }, ['--harness', 'claude-code']);
  assert.equal(stable.code, 0);
  assert.equal(stable.stdout, '', 'a stable managed skill is allowed without a word');

  // The usage row carries the flag so a reader can tell draft runs from the rest.
  const files = await fs.readdir(path.join(ws, 'memory', 'telemetry'));
  const rows = (await Promise.all(files.filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFile(path.join(ws, 'memory', 'telemetry', f), 'utf8')))).join('')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.event === 'invoke' && r.name === 'fx-draft' && r.draft === true), 'invoke row flagged draft');
  assert.ok(rows.every((r) => !(r.name === 'fx-init' && r.draft)), 'stable rows unflagged');
});

test('lint: a maturity value other than draft fails the compile', async () => {
  const bad = path.join(PACK, 'skills', 'fx-beta');
  await fs.mkdir(bad, { recursive: true });
  await fs.writeFile(path.join(bad, 'SKILL.md'), DRAFT_SKILL.replace('name: fx-draft', 'name: fx-beta').replace('maturity: draft', 'maturity: beta'));
  await commitAll(PACK, 'bad maturity');
  await assert.rejects(
    setup('bad-maturity', { harnesses: ['claude-code'], kaut: false, skills: 'all', mcp: 'all', repos: [repo] }),
    (e) => /fx-beta\/SKILL\.md: maturity must be one of draft \(or absent = stable\), got "beta"/.test(e.stderr ?? e.message),
  );
  await fs.rm(bad, { recursive: true, force: true });
  await commitAll(PACK, 'drop bad maturity');
});
