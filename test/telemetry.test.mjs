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
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB], telemetry: 'basic',
  });
  assert.match(stdout, /telemetry basic/);
  assert.match(stdout, /never sent anywhere/);
  const lock = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
  assert.equal(lock.telemetry, 'basic');
  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.telemetry, { level: 'basic', localOnly: true });
  assert.ok(lock.artifacts.some((a) => a.id === '.taut/telemetry.mjs'), 'the adapter ships as a locked artifact');

  const { ws: ws2 } = await setup('tel-default', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const lock2 = JSON.parse(await fs.readFile(path.join(ws2, 'taut.lock'), 'utf8'));
  assert.equal(lock2.telemetry, 'extended', 'non-interactive default is extended');

  await assert.rejects(
    setup('tel-bad', { harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB], telemetry: 'verbose' }),
    (e) => /unknown telemetry level "verbose"/.test(e.stderr ?? `${e}`),
  );
});

test('gate per level: basic logs denials but not allows; extended logs both; session_start carries behind', async () => {
  const { ws } = await setup('tel-gate', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB], telemetry: 'basic',
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
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB],
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
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB],
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
