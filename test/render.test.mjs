// `taut render` — compile-preview of one artifact without a workspace — and the harness
// capability registry it reads from. Exercises the fixture pack directly via --data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLI, FIXTURE_PACK, run } from './helpers.mjs';
import { HARNESSES } from '../lib/constants.mts';
import { HARNESS_CAPS, HARNESS_IDS } from '../lib/harness-caps.mts';
import { emitFrontmatter, FrontmatterEmitError } from '../lib/frontmatter.mts';
import { INSTRUCTIONS_WIDTH, wrapFrom } from '../lib/render.mts';
import { parseFrontmatter } from '../lib/artifacts.mts';

const taut = (...args) => run('node', [CLI, ...args], { env: { ...process.env, TAUT_DATA: FIXTURE_PACK } });

test('harness registry: HARNESSES derives from the caps table; every entry carries its adapter facts', () => {
  assert.deepEqual(HARNESSES, HARNESS_IDS);
  assert.deepEqual(HARNESS_IDS, ['claude-code', 'codex', 'opencode']);
  assert.equal(HARNESS_CAPS['claude-code'].skillAllowlist, 'grant');
  assert.equal(HARNESS_CAPS.codex.agentAllowlist, 'dropped');
  assert.equal(HARNESS_CAPS.opencode.promptGate, 'banner');
  for (const h of Object.values(HARNESS_CAPS)) for (const d of h.degradations) assert.ok(d.id && d.text);
});

test('render --skill: marker pass under default (all-on) and explicit gates', async () => {
  const on = (await taut('render', '--skill', 'fx-init', '--harness', 'codex', '--stdout')).stdout;
  assert.ok(!/^# kaut:(on|off|end)$/m.test(on), 'no marker lines ship');
  assert.match(on, /KAUT system store/);
  const off = (await taut('render', '--skill', 'fx-init', '--harness', 'codex', '--gates', 'kaut=false', '--stdout')).stdout;
  assert.ok(!/KAUT system store/.test(off));
  assert.match(off, /write the intake report/);
  const j = JSON.parse((await taut('render', '--skill', 'fx-init', '--harness', 'claude-code', '--json')).stdout);
  assert.equal(j.id, '.claude/skills/fx-init/SKILL.md');
  assert.equal(j.transform, 'gates');
  assert.deepEqual(j.degradations, []);
  const jc = JSON.parse((await taut('render', '--skill', 'fx-init', '--harness', 'codex', '--json')).stdout);
  assert.equal(jc.id, '.agents/skills/fx-init/SKILL.md');
  assert.ok(jc.degradations.some((d) => d.id === 'codex-skill-allowlist'));
});

test('render --agent: Codex TOML and opencode markdown renders, Claude Code byte-copy', async () => {
  const toml = (await taut('render', '--agent', 'fx-analyst', '--harness', 'codex', '--stdout')).stdout;
  assert.match(toml, /^name = "fx-analyst"$/m);
  assert.match(toml, /developer_instructions = '''/);
  const oc = (await taut('render', '--agent', 'fx-analyst', '--harness', 'opencode', '--stdout')).stdout;
  assert.match(oc, /^mode: subagent$/m);
  const cc = (await taut('render', '--agent', 'fx-analyst', '--harness', 'claude-code', '--stdout')).stdout;
  assert.match(cc, /^name: fx-analyst$/m);
});

test('render errors: unknown harness / artifact / bad gates exit 1 with a message', async () => {
  for (const args of [['--skill', 'fx-init', '--harness', 'nope'], ['--skill', 'ghost', '--harness', 'codex'], ['--skill', 'fx-init', '--harness', 'codex', '--gates', 'Kaut=maybe'], ['--harness', 'codex']]) {
    await assert.rejects(taut('render', ...args), (e) => e.code === 1 && /taut: /.test(e.stderr));
  }
});

test('frontmatter emitter round-trips through the engine parser and refuses the unrepresentable', () => {
  const data = {
    name: 'rt',
    description: "It's here: with [brackets] and colon",
    'argument-hint': '<TASK>',
    'user-invocable': true,
    'disable-model-invocation': false,
    'allowed-tools': ['Read', 'Glob', 'mcp__docs__lookup'],
    metadata: { taut: { agents: ['fx-analyst'], mcp: ['docs'], role: 'init' } },
  };
  const text = emitFrontmatter(data);
  assert.deepEqual(parseFrontmatter(text, 'rt').fm, data);
  assert.throws(() => emitFrontmatter({ name: 'x', 'allowed-tools': ['Bash(git diff *)', 'a,b'] }), FrontmatterEmitError);
  assert.throws(() => emitFrontmatter({ name: 'x', description: 'two\nlines' }), FrontmatterEmitError);
  assert.throws(() => emitFrontmatter({ name: 'x', list: [1, 2] }), FrontmatterEmitError);
  assert.throws(() => emitFrontmatter({ name: 'x', metadata: { taut: {} } }), FrontmatterEmitError);
});

// A sentence composed from the capability table ships inside hard-wrapped prose. These are
// the EXACT lines the instructions carried before the table existed: a recompile must not
// rewrap a file whose content did not change.
test('degradation sentences wrap exactly as the instructions did before the registry', () => {
  const codex = wrapFrom('ladder (unmapped pins inherit the session model). Recorded degradation:', HARNESS_CAPS.codex.degradations[0].text);
  assert.deepEqual(codex.split('\n'), [
    'ladder (unmapped pins inherit the session model). Recorded degradation: Claude-Code',
    'frontmatter tool allowlists are informational here.',
  ]);
  const opencode = wrapFrom('plugin. Recorded degradations (capability mapping, surfaced not hidden):',
    `${HARNESS_CAPS.opencode.degradations.slice(0, 2).map((d) => d.text).join(' — and ')}.`);
  assert.deepEqual(opencode.split('\n'), [
    'plugin. Recorded degradations (capability mapping, surfaced not hidden): there is no',
    'prompt-time integrity sweep — drifted core artifacts are caught at the first managed',
    'tool call instead of the first prompt — and the session-start banner is best-effort.',
  ]);
  for (const line of [...codex.split('\n'), ...opencode.split('\n')]) assert.ok(line.length <= INSTRUCTIONS_WIDTH, `"${line}" is ${line.length} > ${INSTRUCTIONS_WIDTH}`);
  // the wrapper itself: a word longer than the width still gets its own line, never a split
  assert.deepEqual(wrapFrom('x', 'aaaa bbbb cccc', 10).split('\n'), ['x aaaa', 'bbbb cccc']);
  assert.equal(wrapFrom('', 'one two', 100), 'one two');
});
