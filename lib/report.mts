// TAUT telemetry report (`taut report`) — LOCAL aggregation of the workspace's own
// telemetry files (memory/telemetry/YYYY-MM-DD.jsonl + the legacy usage.jsonl).
// Reads and prints ONLY on this machine; there is no send mechanism by construction —
// sharing the output is always the developer's manual, deliberate act. The aggregate
// carries counts and artifact names only (skills/agents/MCP ids — framework artifacts);
// per-harness coverage differs by hook surface and is surfaced, never hidden.
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { bold, dim, expandHome, fail, green, readIfExists, yellow } from './util.mts';
import type { CliOpts } from './types.mts';

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const PRIVACY_NOTE = 'Telemetry is stored ONLY on this machine (memory/telemetry/); files are never sent anywhere. '
  + 'Sharing this report is your manual, deliberate act. No personal data is collected.';

function count<T>(items: T[], key: (x: T) => string | null | undefined): [string, number][] {
  const m = new Map<string, number>();
  for (const x of items) {
    const k = key(x);
    if (k == null || k === '') continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export async function cmdReport(opts: CliOpts): Promise<void> {
  const ws = path.resolve(expandHome(opts.workspace ?? process.cwd()));
  for (const [flag, v] of [['--since', opts.since], ['--to', opts.to]] as const)
    if (v && !DAY.test(v)) fail(`${flag}: expected YYYY-MM-DD, got "${v}"`);
  const since = opts.since ?? null;
  const to = opts.to ?? null;
  const dir = path.join(ws, 'memory', 'telemetry');
  let entries: string[] = [];
  try { entries = await fs.readdir(dir); } catch { entries = []; }
  const dayFiles = entries.filter((f) => DAY_FILE.test(f)).sort()
    .filter((f) => { const d = f.slice(0, 10); return (!since || d >= since) && (!to || d <= to); });

  const rows: any[] = [];
  const readRows = async (file: string, filterByTs: boolean): Promise<void> => {
    const raw = await readIfExists(path.join(dir, file), 64 * 1024 * 1024);
    if (raw === null) return;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let r: any;
      try { r = JSON.parse(line); } catch { continue; }
      if (filterByTs) {
        const d = typeof r.ts === 'string' ? r.ts.slice(0, 10) : null;
        if ((since && (!d || d < since)) || (to && (!d || d > to))) continue;
      }
      rows.push(r);
    }
  };
  for (const f of dayFiles) await readRows(f, false);
  // The legacy pre-daily file joins with per-row date filtering (its rows carry UTC
  // timestamps; the day-boundary approximation is acceptable for legacy data).
  const legacy = entries.includes('usage.jsonl');
  if (legacy) await readRows('usage.jsonl', true);

  const range = `${since ?? (dayFiles[0]?.slice(0, 10) ?? 'start')} … ${to ?? 'today'}`;
  if (!rows.length) {
    if (opts.json) { process.stdout.write(JSON.stringify({ workspace: ws, range, rows: 0 }, null, 2) + '\n'); return; }
    process.stdout.write(`${yellow('!')} ${bold('TAUT telemetry report')} ${dim('·')} ${ws}\n  ${dim(PRIVACY_NOTE)}\n  no telemetry rows in range ${range} (${dir})\n`);
    return;
  }

  const metas = rows.filter((r) => r.event === 'meta');
  const sessions = rows.filter((r) => r.event === 'session_start');
  const invokes = rows.filter((r) => r.event === 'invoke');
  const managedAllows = invokes.filter((r) => r.decision === 'allow' && r.managed === true);
  const foreignAllows = invokes.filter((r) => r.decision === 'allow' && r.managed !== true);
  const denies = invokes.filter((r) => r.decision === 'deny');
  const blocks = rows.filter((r) => (r.event === 'prompt' || r.event === 'expansion') && (r.decision === 'block' || r.decision === 'deny'));
  const lifecycle = rows.filter((r) => ['setup', 'update', 'repair', 'apply', 'check'].includes(r.event));
  const gateErrors = rows.filter((r) => r.cause === 'gate-error').length;
  // Actualization-lag series: the latest observed behind{engine,data} + the worst seen.
  const behinds = sessions.filter((r) => r.behind && typeof r.behind === 'object');
  const lag = (axis: string) => {
    const vals = behinds.map((r) => r.behind[axis]).filter((v: unknown) => typeof v === 'number') as number[];
    if (!vals.length) return null;
    return { last: vals[vals.length - 1], max: Math.max(...vals), samples: vals.length };
  };
  const levels = [...new Set(metas.map((m) => m.level).filter(Boolean))];

  const data = {
    workspace: ws,
    range,
    files: { daily: dayFiles.length, legacy },
    levels: levels.length ? levels : ['extended'],
    rows: rows.length,
    sessions: { total: sessions.length, byDay: count(sessions, (r) => (typeof r.ts === 'string' ? r.ts.slice(0, 10) : null)), byHarness: count(sessions, (r) => r.harness ?? '(unrecorded)') },
    lag: { engine: lag('engine'), data: lag('data') },
    usage: {
      managedInvocations: managedAllows.length,
      byName: count(managedAllows, (r) => `${r.kind ?? '?'}:${r.name ?? '?'}`),
      byHarness: count(managedAllows, (r) => r.harness ?? '(unrecorded)'),
      foreignAllows: foreignAllows.length,
    },
    friction: {
      denies: denies.length,
      byCause: count(denies, (r) => r.cause ?? '?'),
      deniedNames: count(denies, (r) => (r.name ? `${r.kind ?? '?'}:${r.name}` : null)),
      promptBlocks: blocks.length,
      gateErrors,
    },
    lifecycle: lifecycle.slice(-15).map((r) => ({
      ts: r.ts, event: r.event,
      ...(r.pins ? { pins: r.pins } : {}), ...(r.verdict ? { verdict: r.verdict } : {}),
      ...(r.probes ? { probes: r.probes } : {}), ...(r.counts ? { counts: r.counts } : {}),
    })),
    note: PRIVACY_NOTE,
  };

  if (opts.json) { process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return; }

  const p = (s: string) => process.stdout.write(s + '\n');
  const top = (pairs: [string, number][], n = 10) => pairs.slice(0, n).map(([k, c]) => `${k} ×${c}`).join(', ');
  p(`${green('✔')} ${bold('TAUT telemetry report')} ${dim('·')} ${ws}`);
  p(`  ${dim(PRIVACY_NOTE)}`);
  p(`  ${dim('range')}     ${range} · ${dayFiles.length} daily file(s)${legacy ? ' + legacy usage.jsonl' : ''} · ${rows.length} row(s) · level ${data.levels.join('+')}`);
  p(`  ${dim('sessions')}  ${sessions.length} ${sessions.length ? dim(`· by harness: ${top(data.sessions.byHarness)}`) : ''}`);
  for (const axis of ['engine', 'data'] as const) {
    const l = data.lag[axis];
    if (l) p(`  ${dim(`lag:${axis}`)}${axis === 'data' ? '  ' : ''} last ${l.last} commit(s) behind, max ${l.max} ${dim(`(${l.samples} session sample(s))`)}`);
  }
  p(`  ${dim('usage')}     ${managedAllows.length} managed invocation(s)${foreignAllows.length ? ` (+${foreignAllows.length} foreign allowed in normal mode)` : ''}${data.levels.includes('basic') ? dim(' · NOTE: basic level does not record allow-events') : ''}`);
  if (data.usage.byName.length) p(`            ${dim(top(data.usage.byName, 12))}`);
  p(`  ${dim('friction')}  ${denies.length} deny(s)${denies.length ? ` ${dim(`· by cause: ${top(data.friction.byCause)}`)}` : ''}${blocks.length ? ` · ${blocks.length} prompt/expansion block(s)` : ''}${gateErrors ? ` · ${yellow(`${gateErrors} gate error(s)`)}` : ''}`);
  if (data.friction.deniedNames.length) p(`            ${dim(`denied: ${top(data.friction.deniedNames, 8)}`)}`);
  if (lifecycle.length) {
    p(`  ${dim('lifecycle')} ${lifecycle.length} event(s), last ${Math.min(15, lifecycle.length)}:`);
    for (const e of data.lifecycle)
      p(`            ${dim(String(e.ts ?? '?').slice(0, 16))} ${e.event}${e.pins ? dim(` engine ${e.pins.engine?.from ?? '·'}→${e.pins.engine?.to ?? '·'} data ${e.pins.data?.from ?? '·'}→${e.pins.data?.to ?? '·'}`) : ''}${e.verdict ? ` ${e.verdict}` : ''}${e.probes ? dim(` (${e.probes.failed}/${e.probes.total} failed)`) : ''}`);
  }
  p(`  ${dim('coverage note: event completeness differs per harness hook surface; sessions with no session_start hook do not appear here')}`);
}
