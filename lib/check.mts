// TAUT readiness check (`taut check`) — the DETERMINISTIC half of the deployment's
// session-readiness proof: everything a Node process can verify without an agent.
// Answers "is this workspace ready for practical work?": lock/manifest/binding parse,
// artifact integrity, a LIVE gate self-test (spawns the shipped gate), every member
// repo reachable and git-readable, every shipped data file (runbooks, repo descriptors,
// laws, flow docs) readable, memory writable, and a real MCP HANDSHAKE (JSON-RPC
// initialize over stdio) against every server the workspace allows. The agent-side
// twin is the pack's check skill (live MCP tool calls, KAUT lookups, in-session
// proofs) — it starts by running this command. Panel button "Check" runs this too.
// Works WITHOUT the framework/pack repos present — a pure workspace self-test.
import { execFile, execSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import type { ChildProcess, ExecSyncOptionsWithStringEncoding } from 'node:child_process';

import { PROBE_NAME } from './constants.mts';
import { bold, dim, exists, expandHome, fail, green, red, readIfExists, safeJoin, sha256, yellow } from './util.mts';
import { createTelemetry } from '../gate/telemetry.mjs';
import { normalizeLock } from './lock.mts';
import type { CliOpts, Lock } from './types.mts';

const MCP_HANDSHAKE_TIMEOUT = 30_000; // npx cold-start may download the package

async function readJson(p: string): Promise<any> {
  const raw = await readIfExists(p, 8 * 1024 * 1024);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return undefined; } // undefined = unparseable
}

// Parse .taut/local.env (KEY=VALUE lines) — values stay in-process, never printed.
function parseEnvFile(text: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text ?? '').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// One JSON-RPC initialize over stdio: proves the server LAUNCHES and speaks MCP.
function mcpHandshake(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { ok: boolean; detail: string }) => { if (!done) { done = true; try { child?.kill(); } catch { /* gone */ } resolve(r); } };
    let child: ChildProcess | undefined;
    try { child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, detail: `spawn failed: ${(e as Error).message}` }); }
    const timer = setTimeout(() => finish({ ok: false, detail: `no initialize response in ${MCP_HANDSHAKE_TIMEOUT / 1000}s` }), MCP_HANDSHAKE_TIMEOUT);
    let buf = ''; let errBuf = '';
    child.stdout!.on('data', (d) => {
      buf += d.toString();
      for (const line of buf.split('\n')) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result) { clearTimeout(timer); return finish({ ok: true, detail: `server: ${msg.result.serverInfo?.name ?? 'unnamed'}` }); }
          if (msg.id === 1 && msg.error) { clearTimeout(timer); return finish({ ok: false, detail: `initialize error: ${msg.error.message ?? msg.error.code}` }); }
        } catch { /* partial line */ }
      }
    });
    child.stderr!.on('data', (d) => { errBuf = (errBuf + d.toString()).slice(-400); });
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, detail: `spawn failed: ${e.message}` }); });
    child.on('exit', (code) => { clearTimeout(timer); finish({ ok: false, detail: `exited (${code}) before answering${errBuf ? ` — ${errBuf.trim().split('\n').pop()}` : ''}` }); });
    child.stdin!.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'taut-check', version: '1.0' } },
    }) + '\n');
  });
}

function runGateProbe(ws: string, harness: string, input: unknown): Promise<{ code: number | string; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [path.join(ws, '.taut', 'gate.mjs'), 'pretooluse', '--harness', harness],
      // TAUT_PROBE marks the telemetry rows this self-test produces. Without it the probe's
      // allow-row is indistinguishable from a real invocation of manifest.skills[0], and
      // every `taut check` silently inflates that one skill's usage count.
      { env: { ...process.env, CLAUDE_PROJECT_DIR: ws, TAUT_PROBE: '1' } },
      (err, stdout) => resolve({ code: err ? err.code ?? 1 : 0, stdout: stdout ?? '' }));
    child.stdin!.end(JSON.stringify(input));
  });
}

export async function cmdCheck(opts: CliOpts): Promise<void> {
  const ws = path.resolve(expandHome(opts.workspace ?? process.cwd()));
  const results: { area: string; status: 'ok' | 'warn' | 'fail'; detail: string }[] = [];
  const add = (area: string, status: 'ok' | 'warn' | 'fail', detail: string) => results.push({ area, status, detail });

  const lock: Lock | null | undefined = await readJson(path.join(ws, 'taut.lock'));
  if (!lock) fail(`no readable taut.lock in ${ws} — not a TAUT workspace (or setup never ran)`);
  normalizeLock(lock); // legacy `atlas` key folds into `kaut` at the load
  const manifest = await readJson(path.join(ws, 'manifest.json'));
  const local = await readJson(path.join(ws, '.taut', 'local.json'));
  add('config', manifest && local ? 'ok' : 'fail',
    manifest && local ? `manifest + lock + local binding parse (deployment ${manifest.deployment ?? 'generic'}, mode ${lock.mode ?? 'normal'})`
      : `unreadable: ${[!manifest && 'manifest.json', !local && '.taut/local.json'].filter(Boolean).join(', ')}`);

  // Integrity: every locked artifact matches its hash (settings-conformance proof).
  const drifted: string[] = [];
  for (const a of lock.artifacts ?? []) {
    const target = safeJoin(ws, a.id);
    if (!target) { drifted.push(`${a.id} (invalid)`); continue; }
    try { if (sha256(await fs.readFile(target)) !== a.sha256) drifted.push(a.id); }
    catch { drifted.push(`${a.id} (missing)`); }
  }
  add('integrity', drifted.length ? 'fail' : 'ok',
    drifted.length ? `${drifted.length} artifact(s) drifted: ${drifted.slice(0, 5).join(', ')}${drifted.length > 5 ? ', …' : ''} — run \`taut repair\``
      : `${(lock.artifacts ?? []).length} artifacts match the lock`);

  // Gate self-test, once per ENABLED harness (each wiring passes its own identity):
  // allow a managed skill, and (strict) deny a foreign probe. This proves enforcement
  // is live, not assumed.
  const harnesses: string[] = lock.harnesses ?? (lock.harness ? [lock.harness] : ['claude-code']);
  const firstSkill = (manifest?.skills ?? [])[0];
  if (firstSkill) {
    for (const h of harnesses) {
      const r = await runGateProbe(ws, h, { tool_name: 'Skill', tool_input: { skill: firstSkill } });
      const denied = r.stdout.includes('"deny"');
      add('gate', denied ? 'fail' : 'ok', denied
        ? `[${h}] gate DENIES the managed skill "${firstSkill}" — integrity/drift problem above; heal first`
        : `[${h}] live gate allows managed "${firstSkill}"${lock.mode === 'strict' ? '' : ' (normal mode)'}`);
    }
  } else add('gate', 'warn', 'no skills installed — managed-allow probe skipped');
  // Draft skills: ready to run, but a reader of this report must know they are not
  // approved for production — a warning, never a failure.
  const drafts: string[] = manifest?.skillsDraft ?? lock.draft ?? [];
  if (drafts.length) add('draft', 'warn', `${drafts.length} DRAFT skill(s) installed — not approved for production use, run at your own risk: ${drafts.join(', ')}`);
  if (lock.mode === 'strict') {
    for (const h of harnesses) {
      const r = await runGateProbe(ws, h, { tool_name: 'Skill', tool_input: { skill: PROBE_NAME } });
      add('gate-strict', r.stdout.includes('"deny"') ? 'ok' : 'fail',
        r.stdout.includes('"deny"') ? `[${h}] strict regime enforced (foreign probe denied)`
          : `[${h}] STRICT mode recorded but the foreign probe was NOT denied — gate wiring broken (repair)`);
    }
  }

  // Member repos: reachable, git-readable, current branch known. Read-only probes.
  const repoRows = manifest?.repos ?? [];
  const repoFails: string[] = [];
  const repoNotes: string[] = [];
  for (const r of repoRows) {
    const p = local?.repoPaths?.[r.name];
    if (!p || !await exists(p)) { repoFails.push(`${r.name} → ${p ?? 'no path recorded'} (missing)`); continue; }
    try {
      const git: ExecSyncOptionsWithStringEncoding = { cwd: p, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
      // A branch with no commits yet (a freshly inited repo) has an UNBORN HEAD:
      // `rev-parse HEAD` fails there, which must not read as "git unreadable" — the repo
      // is reachable and its branch is known. symbolic-ref answers on an unborn branch;
      // the rev-parse fallback covers a detached HEAD, where symbolic-ref is the one that fails.
      let branch: string;
      try { branch = execSync('git symbolic-ref --short HEAD', git).trim(); }
      catch { branch = execSync('git rev-parse --abbrev-ref HEAD', git).trim(); }
      let unborn = false;
      try { execSync('git rev-parse --verify -q HEAD', git); } catch { unborn = true; }
      const dirty = execSync('git status --porcelain', git).trim().length > 0;
      repoNotes.push(`${r.name}@${branch}${unborn ? ' (no commits yet)' : ''}${dirty ? ' (dirty)' : ''}`);
    } catch { repoFails.push(`${r.name}: git unreadable at ${p}`); }
  }
  add('repos', repoFails.length ? 'fail' : 'ok', repoFails.length
    ? `${repoFails.length} of ${repoRows.length} unreachable: ${repoFails.join('; ')}`
    : `${repoRows.length} repo(s) reachable · ${repoNotes.join(', ')}`);

  // Shipped data files: runbooks, repo descriptors, laws, flow docs — all readable.
  const dataFiles: string[] = [
    ...(manifest?.runbooks ?? []).map((r: any) => r.path),
    ...Object.values(manifest?.repoDocs ?? {}).flat() as string[],
    ...(manifest?.laws?.text ? [manifest.laws.text] : []),
    ...(manifest?.flowDocs ?? []).map((f: any) => f.doc),
  ];
  const unreadable: string[] = [];
  for (const f of dataFiles) if (await readIfExists(path.join(ws, f)) === null) unreadable.push(f);
  add('data', unreadable.length ? 'fail' : 'ok', unreadable.length
    ? `${unreadable.length} shipped file(s) unreadable: ${unreadable.join(', ')} — run \`taut repair\``
    : `${dataFiles.length} data file(s) readable (runbooks ${manifest?.runbooks?.length ?? 0}, descriptors ${Object.values(manifest?.repoDocs ?? {}).flat().length}, laws, flow docs)`);

  // Memory: the instance side must exist and be writable (agents write tickets/telemetry).
  try {
    const memRoot = local?.memoryRoot ?? path.join(ws, 'memory');
    await fs.access(memRoot, fs.constants.W_OK);
    const linked = await exists(path.join(ws, 'memory'));
    add('memory', linked ? 'ok' : 'warn', linked ? `writable · ${memRoot}` : `root writable but workspace memory/ link missing — run \`taut repair\``);
  } catch { add('memory', 'fail', `memory root not writable: ${local?.memoryRoot ?? '(unknown)'}`); }

  // KAUT (when enabled): the MACHINE half only — the recorded engine location still
  // points at an engine. Live proofs (doctor/lookup against real stores) are session
  // work owned by the check skill: the KAUT CLI contract belongs to KAUT, not this
  // engine, so `check` stops at the binding. A legacy engine checkout still shipping
  // atlas.mjs (pre-rename) passes the probe the same; `kautRoot ?? atlasRoot` is the
  // local.json load-point normalization.
  if (lock.kaut) {
    const kRoot = local?.kautRoot ?? local?.atlasRoot;
    if (!kRoot) add('kaut', 'warn', 'enabled, but the engine location is not recorded (legacy workspace) — re-running setup records it');
    else if (await exists(path.join(String(kRoot), 'kaut.mjs')) || await exists(path.join(String(kRoot), 'atlas.mjs'))) add('kaut', 'ok', `engine at ${kRoot}`);
    else add('kaut', 'fail', `engine not found at ${kRoot} (no kaut.mjs or legacy atlas.mjs) — fix kautRoot in .taut/local.json or re-run setup`);
  }

  // MCP: a REAL handshake per allowed server, through the SAME chain the harness uses —
  // .taut/mcp-launch.mjs (which reads local.env itself) → the real server. Identical for
  // every harness. Empty declared env keys are warned, not failed — the handshake is
  // the truth (some servers start without a key); values are never printed.
  const mcpEntries = lock.mcp ?? [];
  if (!mcpEntries.length) add('mcp', 'ok', 'no MCP servers configured');
  else {
    const launcher = path.join(ws, '.taut', 'mcp-launch.mjs');
    const spec = await readJson(path.join(ws, '.taut', 'mcp-servers.json')) ?? {};
    const envMap = parseEnvFile(await readIfExists(path.join(ws, '.taut', 'local.env')));
    // A handshake detail can carry the server's own stderr — redact any filled secret it
    // might echo before it reaches the report (values never crossing this boundary is a
    // law). Only substantial values (≥6 chars) are masked, to avoid trashing the message.
    const secrets = new Set<string>();
    for (const m of mcpEntries) for (const k of spec[m.id]?.env ?? []) {
      const v = envMap[k] || process.env[k];
      if (v && v.length >= 6) secrets.add(v);
    }
    const redact = (s: string): string => { for (const v of secrets) s = s.split(v).join('***'); return s; };
    if (!await exists(launcher)) {
      add('mcp', 'fail', 'MCP launcher .taut/mcp-launch.mjs missing — run `taut repair` (pre-launcher workspace? update first)');
    } else {
      for (const m of mcpEntries) {
        if (!spec[m.id]) { add(`mcp:${m.serverKey}`, 'fail', 'listed in the lock but absent from .taut/mcp-servers.json — run `taut repair`'); continue; }
        const missing = (spec[m.id].env ?? []).filter((k: string) => !(envMap[k] || process.env[k]));
        const hs = await mcpHandshake('node', [launcher, m.id], { ...process.env });
        const envNote = missing.length ? ` (env EMPTY: ${missing.join(', ')} — fill .taut/local.env)` : '';
        add(`mcp:${m.serverKey}`, hs.ok ? (missing.length ? 'warn' : 'ok') : 'fail', redact(`${hs.detail}${envNote}`));
      }
    }
  }

  const failed = results.filter((r) => r.status === 'fail');
  const warned = results.filter((r) => r.status === 'warn');
  const verdict = failed.length ? 'NOT READY' : 'READY';

  // Local-only check telemetry: verdict + probe counts + failed AREA labels (no values).
  createTelemetry({
    workspace: ws,
    level: lock.telemetry,
    meta: { engine: lock.framework?.commit?.slice(0, 7) ?? null, data: lock.data?.commit?.slice(0, 7) ?? null, mode: lock.mode ?? 'normal', harnesses },
  }).log({
    event: 'check', verdict,
    probes: { total: results.length, failed: failed.length, warned: warned.length },
    ...(failed.length ? { failedAreas: failed.map((r) => r.area) } : {}),
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ workspace: ws, verdict, results }, null, 2) + '\n');
    process.exit(failed.length ? 1 : 0);
  }
  const p = (s: string) => process.stdout.write(s + '\n');
  p(`${failed.length ? red('✖') : green('✔')} ${bold('TAUT readiness check')} ${dim('·')} ${ws}`);
  for (const r of results) {
    const mark = r.status === 'ok' ? green('✔') : r.status === 'warn' ? yellow('!') : red('✖');
    p(`  ${mark} ${dim(r.area.padEnd(12))} ${r.detail}`);
  }
  p(failed.length
    ? `\n${red(`NOT READY — ${failed.length} check(s) failed`)}${warned.length ? yellow(` (+${warned.length} warning(s))`) : ''}. Fix the ✖ lines above, then re-run.`
    : `\n${green('READY')} — the workspace can run practical work${warned.length ? yellow(` (${warned.length} warning(s) above)`) : ''}. In-session proofs (live MCP tool calls, KAUT) — run the deployment's check skill.`);
  process.exit(failed.length ? 1 : 0);
}
