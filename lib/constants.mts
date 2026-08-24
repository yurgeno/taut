// TAUT compiler — core constants + the DATA-ROOT seam (core/data split): the engine
// (this repo) carries no content; skills/agents/docs/catalog/
// deployments live in a separate DATA PACK repo. `resolveDataRoot` picks the pack,
// `initData` loads its MCP catalog + descriptor ONCE per process before any command
// runs. Everything about ARTIFACTS lives in their frontmatter (lib/artifacts.mts).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { exists, expandHome, readIfExists } from './util.mts';
import type { McpServer } from './types.mts';

// Framework root = the CORE repo root (parent of lib/).
export const FW_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Display names for common session-language codes (setup hints + rendered
// instructions); an unlisted code renders as itself — never a failure.
export const LANG_NAMES: Record<string, string> = {
  en: 'English', ru: 'Russian', cs: 'Czech', de: 'German', fr: 'French',
  es: 'Spanish', it: 'Italian', pl: 'Polish', sk: 'Slovak', uk: 'Ukrainian',
};
export const langName = (c: string): string => LANG_NAMES[c] ?? c;

// ---------------------------------------------------------------- data pack seam

// Resolution chain, first hit wins:
//   1. explicit (--data flag / answers.data)
//   2. the workspace's own binding (.taut/local.json dataRoot — stability)
//   3. TAUT_DATA env (tests, power users)
//   4. <workspace-parent>/taut-data — the SIBLING convention: the
//      pack sits at the same level as the workspace and its `<ws>-memory` folder, so a
//      landscape root reads `{repos…, ws, ws-memory, taut-data}`; ONE pack serves every
//      workspace of that landscape
//   5. ~/taut-data when it exists (global fallback) — where the setup error suggests
//      cloning the community starter pack (github.com/yurgeno/taut-data-community)
//   6. FW_ROOT when it still carries skills/ (pre-split single-repo layout)
// The engine ships NO content of its own: when the chain finds nothing, setup fails
// with the clone instruction (the machine default is returned as the suggested spot).
export async function resolveDataRoot({ explicit = null, ws = null }: { explicit?: string | null; ws?: string | null } = {}): Promise<string> {
  if (explicit) return path.resolve(expandHome(explicit));
  if (ws) {
    try {
      const localRaw = await readIfExists(path.join(ws, '.taut', 'local.json'), 1024 * 1024)
        ?? await readIfExists(path.join(ws, '.federation', 'local.json'), 1024 * 1024);
      const dr = JSON.parse(localRaw ?? '{}').dataRoot;
      if (dr && await exists(dr)) return dr;
    } catch { /* fall through the chain */ }
  }
  if (process.env.TAUT_DATA) return path.resolve(expandHome(process.env.TAUT_DATA));
  if (ws) {
    const sibling = path.join(path.dirname(path.resolve(expandHome(ws))), 'taut-data');
    if (await exists(sibling)) return sibling;
  }
  const machineDefault = path.join(process.env.HOME ?? '', 'taut-data');
  if (await exists(machineDefault)) return machineDefault;
  if (await exists(path.join(FW_ROOT, 'skills'))) return FW_ROOT;
  return machineDefault;
}

// Initialized by initData() before any command dispatch; loud failure otherwise.
// The catalog singletons stay `null` until init ON PURPOSE (a missed init must fail
// loud, not read as an empty catalog) — they are TYPED non-null for consumers, which
// all run post-init. The singleton seam itself is the stage-4b refactor candidate
// (explicit cfg threading instead of live bindings).
export let DATA_ROOT: string | null = null;
export let PACK_NAME: string | null = null;
export let MCP_CATALOG: Record<string, McpServer> = null as never;
export let ENV_HELP: Record<string, string[]> = null as never;

export function initData(root: string): string {
  DATA_ROOT = root;
  let catalog: any = { servers: {}, envHelp: {} };
  try { catalog = JSON.parse(readFileSync(path.join(root, 'catalog', 'mcp.json'), 'utf8')); }
  catch { /* a pack may ship no MCP catalog — no servers offerable */ }
  MCP_CATALOG = catalog.servers ?? {};
  ENV_HELP = catalog.envHelp ?? {};
  try { PACK_NAME = JSON.parse(readFileSync(path.join(root, 'pack.json'), 'utf8')).name ?? null; }
  catch { PACK_NAME = null; }
  return root;
}

export function requireData(): string {
  if (DATA_ROOT === null) throw new Error('internal: data pack not initialized (initData must run before this command)');
  return DATA_ROOT;
}

// PROJECT layer over the pack ("all of it IS the project" — a
// project folder carries EVERYTHING project-scoped, catalog included). Called once the
// selected project is known; merges the project's catalog/mcp.json over the pack-level
// one (project wins per server id / env key). Idempotent — safe on every status poll.
export function initProject(dir: string | null | undefined): void {
  if (!dir) return;
  try {
    const c = JSON.parse(readFileSync(path.join(dir, 'catalog', 'mcp.json'), 'utf8'));
    MCP_CATALOG = { ...MCP_CATALOG, ...(c.servers ?? {}) };
    ENV_HELP = { ...ENV_HELP, ...(c.envHelp ?? {}) };
  } catch { /* the project ships no catalog of its own */ }
}

// Convenience used by commands: resolve + init in one step.
export async function initDataFor({ explicit = null, ws = null }: { explicit?: string | null; ws?: string | null } = {}): Promise<string> {
  return initData(await resolveDataRoot({ explicit, ws }));
}

// Harness ADAPTER REGISTRY — the harnesses this engine currently ships adapters for.
// TAUT itself is harness-agnostic: sources are authored once, harness-neutral, and every
// per-harness surface (render targets, hook wiring, gate routing, panel toggles) derives
// from this list. Supporting a new harness = adding its id here plus its adapter seams —
// packs and workspaces never change shape.
export const HARNESSES = ['claude-code', 'codex'];

// Manifest keys the compiler owns — a deployment config's `manifest` bag cannot override
// them (flow is special: its blocks merge around the computed `flow.stages`). `flows`
// stays reserved defensively: it was the pre-flat-model flow-package record and must never ride
// in from a config again.
export const OWNED_MANIFEST_KEYS = new Set([
  'name', 'framework', 'deployment', 'description', 'harness', 'harnesses', 'atlas', 'mode', 'telemetry', 'flow', 'flows',
  'flowDocs', 'runbooks', 'repoDocs', 'skills', 'skillsSelection', 'skillsExcluded',
  'agents', 'mcp', 'repos', 'laws',
]);

// Files setup owns inside a workspace. Nothing outside this set is ever written.
export const FRAMEWORK_OWNED_NOTE =
  'Framework-owned: manifest.json, taut.lock, CLAUDE.md / AGENTS.md, .claude/skills/*, ' +
  '.claude/agents/*, .claude/settings.json (gate hooks), .agents/skills/*, ' +
  '.codex/agents/*, .codex/config.toml, .taut/*, .mcp.json. ' +
  'Edit the framework source and re-run setup instead. ' +
  'memory/ is a SYMLINK to the sibling `<workspace>-memory` folder — INSTANCE data ' +
  '(ticket memory, agent reports, telemetry) the framework never writes, rewrites, or ' +
  'deletes: it survives setup re-runs, update, repair, and even deleting the whole ' +
  'workspace folder and recompiling it.';
