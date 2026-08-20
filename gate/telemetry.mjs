// TAUT telemetry adapter — the SINGLE write path for usage telemetry, compiled into a
// workspace by `taut setup` as .taut/telemetry.mjs (next to the gate) and imported by
// both the shipped gate and the engine CLI. Self-contained (node builtins only) and
// UNIVERSAL by design: it knows nothing about packs, harnesses, or repositories —
// every payload value is an opaque string the caller passes.
//
// PRIVACY LAW (engine-owned): telemetry is stored ONLY on this machine, under the
// workspace's memory/telemetry/ (instance data — the framework never rewrites or
// deletes it). One file per LOCAL day (YYYY-MM-DD.jsonl); nothing is ever sent
// anywhere — sharing a file is always the developer's manual, deliberate act.
// No personal data: no prompt content, no tool arguments, no file paths, no machine or
// user identities, no git identities, no env values, no repository names.
//
// Levels: 'basic' = the diagnostic minimum (errors, denials, lifecycle);
// 'extended' (the default) additionally records usage — allow-decisions and
// per-name apply detail — for evaluating the framework itself.
// A write failure never breaks the caller: every path is wrapped, errors are swallowed.
import fs from 'node:fs';
import path from 'node:path';

export const TELEMETRY_LEVELS = ['basic', 'extended'];

// Unknown/absent level reads as the default — a legacy lock (no telemetry key) must
// keep logging exactly as before the level existed.
export function normalizeLevel(v) {
  return v === 'basic' ? 'basic' : 'extended';
}

// The local calendar day — developers think in their own days, so the file boundary
// follows the machine clock; each row still carries a full ISO (UTC) timestamp.
export function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Factory: one adapter per (workspace, level). `meta` (optional) is stamped once as
// the FIRST line of every day file — build context (pins, mode, harnesses) recorded
// one time instead of on every row. Meta values are caller-provided opaque strings.
export function createTelemetry({ workspace, level, meta } = {}) {
  const lvl = normalizeLevel(level);
  return {
    level: lvl,
    log(entry) {
      try {
        if (!workspace || !entry || typeof entry.event !== 'string') return;
        let row = entry;
        if (lvl === 'basic') {
          // basic drops the usage stream: allow-decisions are extended-only…
          if (row.event === 'invoke' && row.decision === 'allow') return;
          // …and per-name detail bags (apply toggles) are stripped down to the counts
          // the caller placed outside `detail`.
          if (row.detail !== undefined) { row = { ...row }; delete row.detail; }
        }
        const dir = path.join(workspace, 'memory', 'telemetry');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${localDay()}.jsonl`);
        if (!fs.existsSync(file)) {
          fs.appendFileSync(file, JSON.stringify({
            event: 'meta', v: 1, ts: new Date().toISOString(), level: lvl, ...(meta ?? {}),
          }) + '\n');
        }
        fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
      } catch { /* telemetry must never break the caller */ }
    },
  };
}
