// TAUT compiler — taut.lock (per-artifact sha256 + framework commit pin +
// canonical flag) and `verify` (lock check; --source re-derives copy artifacts from the
// pinned commit). The runtime twin of this check is the shipped gate (gate/gate.mjs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { FW_ROOT, MCP_CATALOG, PACK_NAME, requireData } from './constants.mts';
import { dim, fail, gitInfo, gitInfoOwn, green, red, readIfExists, sha256, yellow } from './util.mts';
import { applyMarkers } from './markers.mts';
import { rungEffort, sessionRung } from './manifest.mts';
import type { ArtifactRow, Cfg, Lock } from './types.mts';

export async function writeLock(cfg: Cfg, artifacts: ArtifactRow[]): Promise<Lock> {
  const fw = gitInfo(FW_ROOT);
  // Lock v2 (core/data split): TWO pins — the framework (engine) commit and the data
  // pack commit. A non-git pack pins `commit: null` — the data axis is then judged for
  // NEITHER currency NOR canonicality (canonical: null = "not judged", never "dirty").
  const dt = gitInfoOwn(requireData());
  // Lock v3: `harnesses` is a SET (multi-harness workspaces) — readers accept the
  // legacy v1/v2 scalar as a one-element set.
  const lock: Lock = {
    lockVersion: 3,
    framework: { commit: fw.commit, canonical: fw.dirty === false },
    data: { commit: dt.commit, canonical: dt.commit === null ? null : dt.dirty === false, pack: PACK_NAME },
    generatedAt: new Date().toISOString(),
    harnesses: cfg.harnesses,
    // Model profile's session pin per enabled harness — the trust root the gate's
    // session-start advisory compares the live model against.
    ...((): Partial<Lock> => {
      const rung = sessionRung(cfg);
      if (!rung) return {};
      const session: NonNullable<Lock['session']> = {};
      for (const h of cfg.harnesses) {
        const model = rung.models?.[h];
        if (!model) continue;
        const effort = rungEffort(rung, h);
        session[h] = { model, ...(effort ? { effort } : {}) };
      }
      return Object.keys(session).length ? { session } : {};
    })(),
    atlas: cfg.atlas,
    // Strict/normal mode: the gate reads the MODE from the lock — the same
    // tamper-anchored root it verifies artifacts against. Absent (legacy lock) = normal.
    mode: cfg.mode ?? 'normal',
    artifacts,
    mcp: cfg.mcp.map((id) => {
      const c = MCP_CATALOG[id];
      return { id, role: c.role, serverKey: c.serverKey, package: c.package, pin: c.pin, runner: c.command };
    }),
  };
  await fs.writeFile(path.join(cfg.workspace, 'taut.lock'), JSON.stringify(lock, null, 2) + '\n');
  // Pre-rename workspaces carried federation.lock — remove it once the new lock exists
  // (a stale one would shadow the truth for legacy-reading tools and the conductor scan).
  await fs.rm(path.join(cfg.workspace, 'federation.lock'), { force: true });
  return lock;
}

export async function verify(ws: string, { json = false, source = false }: { json?: boolean; source?: boolean } = {}): Promise<boolean> {
  // Legacy fallback: pre-rename workspaces carry federation.lock until their first
  // recompile — verify must still judge them.
  const raw = await readIfExists(path.join(ws, 'taut.lock'), 8 * 1024 * 1024)
    ?? await readIfExists(path.join(ws, 'federation.lock'), 8 * 1024 * 1024);
  if (raw === null) fail(`no taut.lock in ${ws} — not a TAUT workspace (or setup never ran)`);
  const lock: Lock = JSON.parse(raw);
  const rows: { id: string; state: string }[] = [];
  for (const a of lock.artifacts) {
    const target = path.join(ws, a.id);
    let state: string;
    try {
      state = sha256(await fs.readFile(target)) === a.sha256 ? 'ok' : 'DRIFTED';
    } catch { state = 'MISSING'; }
    rows.push({ id: a.id, state });
  }

  // --source: re-derive copy artifacts from the PINNED commit of their OWNING repo
  // (`from: 'data'` = the data pack; absent = the framework — v1-lock compatible) and
  // compare the installed files against that — catches a tampered artifact whose lock
  // entry was re-hashed to match. Generated artifacts stay lock-checked (re-render
  // needs the generator at the pin — D1b).
  const srcRows: { id: string; state: string }[] = [];
  if (source) {
    let fwRoot: string | null = null;
    let dataRoot: string | null = null;
    try {
      const localRaw = await readIfExists(path.join(ws, '.taut', 'local.json'), 1024 * 1024)
        ?? await readIfExists(path.join(ws, '.federation', 'local.json'), 1024 * 1024);
      if (localRaw === null) throw new Error('no workspace binding');
      const local = JSON.parse(localRaw);
      fwRoot = local.frameworkRoot;
      dataRoot = local.dataRoot ?? local.frameworkRoot; // pre-split binding: one repo
    } catch { /* no binding — copy artifacts stay SOURCE-UNCHECKED */ }
    for (const a of lock.artifacts.filter((x) => x.source)) {
      let state: string;
      try {
        const root = a.from === 'data' ? dataRoot : fwRoot;
        const pin = a.from === 'data' ? (lock.data?.commit ?? lock.framework.commit) : lock.framework.commit;
        if (!root) throw new Error('no source-repo binding'); // → SOURCE-UNCHECKED, as before
        let atPin = execFileSync('git', ['-C', root, 'show', `${pin}:${a.source}`], { maxBuffer: 16 * 1024 * 1024 });
        // A transformed copy artifact is re-derived by re-applying the SAME deterministic
        // pass to the pinned source; the gate values are reconstructed from the lock
        // itself (must mirror capabilityGates in lib/install.mts).
        if (a.transform) {
          const gates = { atlas: Boolean(lock.atlas), 'mcp-docs': (lock.mcp ?? []).some((m) => m.role === 'docs') };
          atPin = Buffer.from(applyMarkers(atPin.toString('utf8'), gates, a.source!));
        }
        let actual: string | null = null;
        try { actual = sha256(await fs.readFile(path.join(ws, a.id))); } catch { actual = null; }
        state = actual === sha256(atPin) ? 'ok' : 'SOURCE-DRIFT';
      } catch { state = 'SOURCE-UNCHECKED'; }
      srcRows.push({ id: a.id, state });
    }
  }
  const bad = rows.filter((r) => r.state !== 'ok');
  const srcBad = srcRows.filter((r) => r.state === 'SOURCE-DRIFT');
  const unchecked = srcRows.filter((r) => r.state === 'SOURCE-UNCHECKED').length;
  // Canonical = every SOURCE repo was clean at compile (framework + data pack).
  const canonical = lock.framework.canonical && lock.data?.canonical !== false;

  if (json) {
    process.stdout.write(JSON.stringify({
      canonical, artifacts: rows,
      ...(source ? { sourceCheck: srcRows } : {}),
    }, null, 2) + '\n');
  } else {
    for (const r of rows) process.stdout.write(`${r.state === 'ok' ? green('  ok   ') : red(r.state.padEnd(7))} ${r.id}\n`);
    if (source) {
      for (const r of srcBad) process.stdout.write(`${red('SOURCE-DRIFT')} ${r.id} ${dim('(installed file ≠ source at pinned commit — lock tampering?)')}\n`);
      process.stdout.write(dim(`source-check: ${srcRows.length - srcBad.length - unchecked}/${srcRows.length} copy artifact(s) match the pin${unchecked ? `, ${unchecked} unchecked (framework clone/commit unavailable)` : ''}; generated artifacts are lock-checked only`) + '\n');
    }
    const totalBad = bad.length + srcBad.length;
    process.stdout.write(totalBad
      ? `\n${red(`${totalBad} artifact(s) out of sync`)} — run \`taut repair\` or investigate.\n`
      : `\n${green(`All ${rows.length} artifacts verified`)}${canonical ? '' : yellow(` (NON-CANONICAL build: ${[!lock.framework.canonical ? 'framework' : null, lock.data?.canonical === false ? 'data pack' : null].filter(Boolean).join(' + ')} tree was dirty at compile)`)}.\n`);
  }
  return bad.length === 0 && srcBad.length === 0;
}
