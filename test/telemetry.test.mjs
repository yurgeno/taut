// Telemetry surface: the adapter (daily local files, levels, meta line, never-throws),
// the engine-owned setup choice (answers "telemetry", default extended), the lock/
// manifest stamp, apply --telemetry, gate behavior per level, the legacy-workspace
// migration note, and `taut report` aggregation. Everything is LOCAL-ONLY by law —
// these tests also pin that no event carries repository names.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CLI, FW, run, runGate, suite } from './helpers.mjs';

const { TMP, reset, makePack, makeRepo, setup } = suite('telemetry');

const { createTelemetry, localDay, normalizeLevel, TELEMETRY_LEVELS } =
  await import(pathToFileURL(path.join(FW, 'gate', 'telemetry.mjs')).href);

let repoB;
before(async () => {
  await reset();
  await makePack();
  repoB = await makeRepo('repo-beta');
});
after(reset);

const telDir = (ws) => path.join(ws, 'memory', 'telemetry');
const readDay = async (ws) => {
  const files = (await fs.readdir(telDir(ws))).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const rows = [];
  for (const f of files)
    rows.push(...(await fs.readFile(path.join(telDir(ws), f), 'utf8')).trim().split('\n').map((l) => JSON.parse(l)));
  return { files, rows };
};

test('adapter: daily file, meta first, level filtering, never throws', async () => {
  assert.deepEqual(TELEMETRY_LEVELS, ['basic', 'extended']);
  assert.equal(normalizeLevel('basic'), 'basic');
  assert.equal(normalizeLevel(undefined), 'extended', 'absent level = the default');
  assert.equal(normalizeLevel('bogus'), 'extended');
  assert.match(localDay(new Date(2026, 0, 5)), /^2026-01-05$/);

  const ws = path.join(TMP, 'adapter-ws');
  await fs.mkdir(ws, { recursive: true });
  const ext = createTelemetry({ workspace: ws, level: 'extended', meta: { engine: 'abc1234', mode: 'strict' } });
  ext.log({ event: 'invoke', kind: 'skill', name: 'fx-plan', decision: 'allow', managed: true });
  ext.log({ event: 'apply', counts: { skillsOn: 1 }, detail: { skillsOn: ['fx-plan'] } });
  const { files, rows } = await readDay(ws);
  assert.equal(files.length, 1);
  assert.equal(files[0], `${localDay()}.jsonl`);
  assert.equal(rows[0].event, 'meta');
  assert.equal(rows[0].level, 'extended');
  assert.equal(rows[0].engine, 'abc1234');
  assert.ok(rows.some((r) => r.event === 'invoke' && r.decision === 'allow'), 'extended keeps allow-events');
  assert.deepEqual(rows.find((r) => r.event === 'apply').detail, { skillsOn: ['fx-plan'] }, 'extended keeps detail');

  const ws2 = path.join(TMP, 'adapter-ws-basic');
  await fs.mkdir(ws2, { recursive: true });
  const basic = createTelemetry({ workspace: ws2, level: 'basic' });
  basic.log({ event: 'invoke', kind: 'skill', name: 'fx-plan', decision: 'allow', managed: true });
  basic.log({ event: 'invoke', kind: 'skill', name: 'fx-plan', decision: 'deny', cause: 'drifted' });
  basic.log({ event: 'apply', counts: { skillsOn: 1 }, detail: { skillsOn: ['fx-plan'] } });
  const b = await readDay(ws2);
  assert.ok(!b.rows.some((r) => r.decision === 'allow'), 'basic drops allow-events');
  assert.ok(b.rows.some((r) => r.decision === 'deny'), 'basic keeps denials');
  const applied = b.rows.find((r) => r.event === 'apply');
  assert.equal(applied.detail, undefined, 'basic strips per-name detail');
  assert.deepEqual(applied.counts, { skillsOn: 1 }, 'basic keeps counts');

  // Never throws: unwritable telemetry path (a FILE where memory/ should be) → no-op.
  const ws3 = path.join(TMP, 'adapter-ws-broken');
  await fs.mkdir(ws3, { recursive: true });
  await fs.writeFile(path.join(ws3, 'memory'), 'a file where a dir is expected');
  createTelemetry({ workspace: ws3, level: 'extended' }).log({ event: 'session_start' }); // must not throw
  createTelemetry({}).log({ event: 'x' }); // no workspace — no-op
  createTelemetry({ workspace: ws }).log(null); // bad entry — no-op
});

test('setup: telemetry answer lands in lock + manifest; default is extended; bad value fails', async () => {
  const { ws, stdout } = await setup('tel-basic', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB], telemetry: 'basic',
  });
  assert.match(stdout, /telemetry basic/);
  assert.match(stdout, /never sent anywhere/);
  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.equal(lock.telemetry, 'basic');
  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.telemetry, { level: 'basic', localOnly: true });
  assert.ok(lock.artifacts.some((a) => a.id === '.taut/telemetry.mjs'), 'the adapter ships as a locked artifact');

  const { ws: ws2 } = await setup('tel-default', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const lock2 = JSON.parse(await fs.readFile(path.join(ws2, 'taut.lock'), 'utf8'));
  assert.equal(lock2.telemetry, 'extended', 'non-interactive default is extended');

  await assert.rejects(
    setup('tel-bad', { harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB], telemetry: 'verbose' }),
    (e) => /unknown telemetry level "verbose"/.test(e.stderr ?? `${e}`),
  );
});

test('gate per level: basic logs denials but not allows; extended logs both; session_start carries behind', async () => {
  const { ws } = await setup('tel-gate', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB], telemetry: 'basic',
  });
  await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-plan' }, session_id: 'sb' });
  await fs.appendFile(path.join(ws, '.claude', 'skills', 'fx-plan', 'SKILL.md'), '\nhack\n');
  await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-plan' }, session_id: 'sb' });
  let { rows } = await readDay(ws);
  assert.ok(!rows.some((r) => r.event === 'invoke' && r.decision === 'allow'), 'basic: allow not recorded');
  const deny = rows.find((r) => r.event === 'invoke' && r.decision === 'deny');
  assert.equal(deny.name, 'fx-plan', 'basic: denial carries the name (diagnostics)');
  assert.equal(deny.harness, 'claude-code');
  assert.equal(deny.session_id, 'sb', 'basic: session_id recorded on both levels');

  await run(process.execPath, [CLI, 'repair', '--workspace', ws]);
  await run(process.execPath, [CLI, 'apply', '--workspace', ws, '--telemetry', 'extended']);
  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.equal(lock.telemetry, 'extended');
  await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-plan' }, session_id: 'se' });
  const r = await runGate(ws, 'sessionstart', { session_id: 'se' });
  assert.equal(r.code, 0);
  ({ rows } = await readDay(ws));
  assert.ok(rows.some((x) => x.event === 'invoke' && x.decision === 'allow' && x.managed === true), 'extended: allow recorded');
  const ss = rows.filter((x) => x.event === 'session_start').pop();
  assert.equal(typeof ss.behind?.engine, 'number', 'session_start records the actualization lag (engine axis)');
  const applyRow = rows.find((x) => x.event === 'apply');
  assert.equal(applyRow.counts.telemetry, 'extended', 'the level switch itself is recorded');
  // Universality/privacy: no event carries repository names or paths.
  const flat = JSON.stringify(rows);
  assert.ok(!flat.includes('repo-beta'), 'repository names never enter telemetry');
  assert.ok(!flat.includes(TMP), 'filesystem paths never enter telemetry');
});

test('legacy workspace: a pre-telemetry lock adopts the default on update, surfaced', async () => {
  const { ws } = await setup('tel-legacy', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const lockPath = path.join(ws, 'taut.lock');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  delete lock.telemetry; // simulate a workspace compiled before telemetry existed
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
  const { stdout } = await run(process.execPath, [CLI, 'repair', '--workspace', ws]);
  assert.match(stdout, /adopted the default "extended"/);
  assert.match(stdout, /taut apply --telemetry basic/);
  const healed = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  assert.equal(healed.telemetry, 'extended');
});

test('report: aggregates daily files, honors --since, prints the privacy note; --json is machine-readable', async () => {
  const { ws } = await setup('tel-report', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB],
  });
  await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-plan' }, session_id: 'r1' });
  await runGate(ws, 'sessionstart', { session_id: 'r1' });
  // A second, older day file + a legacy usage.jsonl join the aggregation.
  await fs.writeFile(path.join(telDir(ws), '2026-01-01.jsonl'),
    '{"event":"meta","v":1,"level":"extended"}\n'
    + '{"ts":"2026-01-01T10:00:00.000Z","event":"invoke","kind":"skill","name":"fx-task","decision":"allow","managed":true,"harness":"codex"}\n');
  await fs.writeFile(path.join(telDir(ws), 'usage.jsonl'),
    '{"ts":"2025-12-31T10:00:00.000Z","event":"session_start","drifted":0,"session_id":"old"}\n');

  const all = await run(process.execPath, [CLI, 'report', '--workspace', ws]);
  assert.match(all.stdout, /stored ONLY on this machine/);
  assert.match(all.stdout, /never sent anywhere/);
  assert.match(all.stdout, /skill:fx-plan/);
  assert.match(all.stdout, /skill:fx-task/);
  assert.match(all.stdout, /legacy usage\.jsonl/);

  const sinceOut = await run(process.execPath, [CLI, 'report', '--workspace', ws, '--since', localDay(), '--json']);
  const data = JSON.parse(sinceOut.stdout);
  assert.equal(data.files.daily, 1, '--since excludes the older day file');
  assert.ok(data.usage.byName.some(([k]) => k === 'skill:fx-plan'));
  assert.ok(!data.usage.byName.some(([k]) => k === 'skill:fx-task'), 'filtered day does not leak in');
  assert.ok(data.lifecycle.some((e) => e.event === 'setup'), 'lifecycle chronology present');
  assert.equal(typeof data.lag.engine?.last, 'number', 'lag series aggregated from session_start');
  assert.match(data.note, /never sent anywhere/);

  await assert.rejects(
    run(process.execPath, [CLI, 'report', '--workspace', ws, '--since', 'yesterday']),
    (e) => /expected YYYY-MM-DD/.test(e.stderr ?? `${e}`),
  );
});

// The usage stream is only as good as the paths it observes. Three ways it used to lie:
// a /slash invocation was never recorded (and a `disable-model-invocation` skill has no
// other path, so the skills a human drives by hand all read zero); `taut check`'s own
// enforcement probe was recorded as a real invocation of manifest.skills[0]; and every
// sibling tool caught by the partial matcher wrote a row with no kind and no name.
test('usage stream: the /slash path is counted, self-test probes are marked, nameless rows are not written', async () => {
  const { ws } = await setup('tel-slash', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB], telemetry: 'extended',
  });
  const invokes = async () => (await readDay(ws)).rows.filter((r) => r.event === 'invoke');

  // The payload shape is the harness's own, captured from a live UserPromptExpansion hook:
  // routing arrives as explicit fields, not as text to be guessed at.
  await runGate(ws, 'promptexpansion', {
    session_id: 'sl', expansion_type: 'slash_command', command_name: 'fx-init',
    command_args: 'TICKET-1 auto', prompt: '/fx-init TICKET-1 auto',
  });
  let rows = await invokes();
  assert.equal(rows.length, 1, 'the slash path writes exactly one usage row');
  assert.equal(rows[0].kind, 'skill');
  assert.equal(rows[0].name, 'fx-init');
  assert.equal(rows[0].managed, true);
  assert.equal(rows[0].via, 'slash', 'the row says which path it came from');
  assert.equal(rows[0].session_id, 'sl');

  // Naming a skill is not using one. The integrity check above stays deliberately broad;
  // the counter must not inherit that breadth or it invents usage out of prose.
  await runGate(ws, 'promptexpansion', { session_id: 'sl', prompt: 'remind me what /fx-plan does' });
  assert.equal((await invokes()).length, 1, 'a prompt that merely mentions a skill is not an invocation');

  // Builtin commands share the event but are harness features, not toolchain artifacts.
  await runGate(ws, 'promptexpansion', {
    session_id: 'sl', expansion_type: 'slash_command', command_name: 'model', prompt: '/model opus',
  });
  assert.equal((await invokes()).length, 1, 'builtin slash commands are not artifacts');

  // A plugin skill arrives namespaced; the artifact is still resolved by its bare name.
  await runGate(ws, 'promptexpansion', {
    session_id: 'sl', expansion_type: 'slash_command', command_name: 'someplugin:fx-plan', prompt: '/someplugin:fx-plan',
  });
  rows = await invokes();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].name, 'fx-plan');

  // The claude-code matcher is a partial match: TaskOutput/TaskStop reach the gate too and
  // resolve to nothing worth recording.
  await runGate(ws, 'pretooluse', { session_id: 'sl', tool_name: 'TaskOutput', tool_input: {} });
  assert.equal((await invokes()).length, 2, 'a tool the gate cannot name writes no row');

  // `taut check` runs this same gate out of band — its rows must say so.
  await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-plan' } }, [], { TAUT_PROBE: '1' });
  rows = await invokes();
  assert.equal(rows.length, 3);
  assert.equal(rows[2].via, 'tool', 'the tool path is labelled too — absence of `via` dates a file, it does not mean idle');
  assert.equal(rows[2].probe, true, 'an out-of-band probe is marked, never counted as use');
  assert.ok(rows.slice(0, 2).every((r) => r.probe === undefined), 'real invocations carry no probe flag');

  // Privacy law holds on the new path too.
  const flat = JSON.stringify(await invokes());
  assert.ok(!flat.includes('repo-beta') && !flat.includes(TMP), 'no repository names, no paths');
});

test('check: the live-gate self-test does not inflate the usage of manifest.skills[0]', async () => {
  const { ws } = await setup('tel-probe', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB], telemetry: 'extended',
  });
  await run(process.execPath, [CLI, 'check', '--workspace', ws]);
  const rows = (await readDay(ws)).rows.filter((r) => r.event === 'invoke');
  assert.ok(rows.length > 0, 'the probe still records — enforcement evidence is kept');
  assert.ok(rows.every((r) => r.probe === true), 'every row `taut check` produces is marked as a probe');
});

test('report: self-test probe rows are excluded from usage and friction, old files included', async () => {
  const { ws } = await setup('tel-report-probe', {
    harness: 'claude-code', kaut: false, skills: 'all', mcp: [], repos: [repoB],
  });
  // One real invocation, plus a marked probe pair (v0.7.2+) and an UNMARKED one written
  // the way pre-0.7.2 engines did — recognizable only by the reserved name and the
  // same-second allow-row the self-test always emits beside it.
  await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-plan' }, session_id: 'r1' });
  await runGate(ws, 'pretooluse', { tool_name: 'Skill', tool_input: { skill: 'fx-init' } }, [], { TAUT_PROBE: '1' });
  await fs.appendFile(path.join(telDir(ws), `${localDay()}.jsonl`),
    '{"ts":"2026-01-01T10:00:00.000Z","event":"invoke","kind":"skill","name":"fx-init","decision":"allow","managed":true,"harness":"claude-code"}\n'
    + '{"ts":"2026-01-01T10:00:00.900Z","event":"invoke","kind":"skill","name":"taut-check-foreign-probe","decision":"deny","cause":"strict-foreign","harness":"claude-code"}\n');

  const out = await run(process.execPath, [CLI, 'report', '--workspace', ws, '--json']);
  const d = JSON.parse(out.stdout);
  assert.equal(d.usage.managedInvocations, 1, 'only the real invocation counts as usage');
  assert.ok(d.usage.byName.some(([k]) => k === 'skill:fx-plan'));
  assert.ok(!d.usage.byName.some(([k]) => k === 'skill:fx-init'), 'the probed skill is not credited with use');
  assert.equal(d.usage.probes, 3, 'excluded probe rows are reported, not hidden');
  assert.equal(d.friction.denies, 0, 'the reserved deny-probe is not counted as real friction');

  const human = await run(process.execPath, [CLI, 'report', '--workspace', ws]);
  assert.match(human.stdout, /self-test probe row\(s\) excluded/);
});

// Not every harness has a skill tool. Measured on codex 0.153.0: its hook surface carries
// no prompt-expansion event at all (`pre_tool_use, permission_request, post_tool_use,
// pre_compact, post_compact, session_start, session_end, user_prompt_submit,
// subagent_start, subagent_stop, interrupt`), a slash-prefixed prompt reaches
// UserPromptSubmit as literal text, and a skill is invoked by the model READING its
// SKILL.md through the shell tool. That read is an ordinary tool call, so the whole
// harness's skill usage was invisible.
test('usage stream: a skill invoked by READING its SKILL.md is counted, and detection never bypasses enforcement', async () => {
  const { ws } = await setup('tel-read', {
    harness: 'codex', kaut: false, skills: 'all', mcp: [], repos: [repoB], telemetry: 'extended', mode: 'strict',
  });
  const invokes = async () => (await readDay(ws)).rows.filter((r) => r.event === 'invoke');

  // The real shape, taken from a recorded codex session: a shell call whose command reads
  // the skill file among other things.
  await runGate(ws, 'pretooluse', {
    session_id: 'rd', tool_name: 'exec',
    tool_input: { cmd: "pwd && sed -n '1,240p' .agents/skills/fx-plan/SKILL.md && rg --files .taut/repos" },
  });
  let rows = await invokes();
  assert.equal(rows.length, 1, 'the read is the invocation on a harness with no skill tool');
  assert.equal(rows[0].name, 'fx-plan');
  assert.equal(rows[0].kind, 'skill');
  assert.equal(rows[0].via, 'read', 'weaker evidence than an explicit call — and labelled as such');
  assert.equal(rows[0].managed, true);

  // One call reading two skills counts each once; a bare directory listing counts nothing.
  await runGate(ws, 'pretooluse', {
    session_id: 'rd', tool_name: 'exec',
    tool_input: { cmd: 'cat .agents/skills/fx-init/SKILL.md .agents/skills/fx-task/SKILL.md .agents/skills/fx-init/SKILL.md' },
  });
  rows = await invokes();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.slice(1).map((r) => r.name).sort(), ['fx-init', 'fx-task'], 'each skill once per call');

  await runGate(ws, 'pretooluse', { session_id: 'rd', tool_name: 'exec', tool_input: { cmd: 'rg --files .agents/skills' } });
  assert.equal((await invokes()).length, 3, 'listing the skills directory is not using a skill');

  // The detection must not become a hole in the gate: a FOREIGN skill invoked by name is
  // still denied even when its arguments happen to mention a managed skill's path.
  const r = await runGate(ws, 'pretooluse', {
    session_id: 'rd', tool_name: 'Skill',
    tool_input: { skill: 'rogue-skill', hint: '.agents/skills/fx-plan/SKILL.md' },
  });
  assert.match(r.stdout, /"deny"/, 'strict enforcement is reached, not short-circuited by the read path');
  const denied = (await invokes()).filter((x) => x.decision === 'deny');
  assert.equal(denied.at(-1).name, 'rogue-skill');
});
