// TAUT compiler — installation into a workspace: copy artifacts (skills, agent
// sources, gate, LAWS.md), generated artifacts (instructions, manifest, MCP/hook
// configs), the per-developer local.env scaffold, and the informational scan of member
// instruction files. Every written artifact is collected for the lock.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';

import { ENV_HELP, FW_ROOT, HARNESSES, MCP_CATALOG, requireData } from './constants.mts';
import { exists, fail, readIfExists, sha256 } from './util.mts';
import { neededAgents } from './artifacts.mts';
import { applyMarkers } from './markers.mts';
import { buildManifest, installedFlowDocs } from './manifest.mts';
import {
  renderClaudeSettings, renderCodexAgentToml, renderCodexConfigToml, renderCodexHooksToml,
  renderInstructions, renderMcpJson, renderMcpServersSpec, renderStackSkill, renderUiShim,
} from './render.mts';
import type { ArtifactRow, Cfg, MemberFile } from './types.mts';

// memory/ is INSTANCE data — ticket memory, agent reports, telemetry: the framework
// NEVER owns, writes, or deletes anything under it, so it
// survives setup re-runs, update, and repair. This guard makes that structural — any
// future artifact accidentally routed there fails the compile instead of landing.
function assertNotInstanceData(rel: string): void {
  if (rel === 'memory' || rel.startsWith('memory/'))
    throw new Error(`refusing to write a framework artifact into instance data: ${rel}`);
}

// The memory ROOT is a SIBLING of the workspace, `<workspace>-memory` (the
// workspace is disposable — delete it and recompile from TAUT; memory is not).
// Named after the workspace, not a bare `memory`, so two workspaces sharing a parent
// folder can never collide into one memory.
export function memoryRootFor(ws: string): string {
  return path.join(path.dirname(ws), `${path.basename(ws)}-memory`);
}

// Pre-rename layout migration (FEDERATION → TAUT): instance files the
// framework must NEVER lose (local.json machine binding, local.env with FILLED secrets)
// move .federation/ → .taut/ by rename; framework-owned files under .federation/ are
// left for the compile sweep (they carry lock ids). Returns whether a legacy layout was
// found so the caller can clean the emptied directories afterwards.
export async function migrateLegacyLayout(ws: string): Promise<boolean> {
  const legacy = path.join(ws, '.federation');
  if (!await exists(legacy)) return false;
  const modern = path.join(ws, '.taut');
  await fs.mkdir(modern, { recursive: true });
  for (const f of ['local.json', 'local.env']) {
    const from = path.join(legacy, f);
    const to = path.join(modern, f);
    if (await exists(from) && !await exists(to)) await fs.rename(from, to);
  }
  return true;
}

// Inside the workspace `memory` is a SYMLINK to that sibling — every artifact (skills,
// laws, the gate) keeps addressing the stable relative path `memory/...` unchanged,
// while the data physically lives outside the workspace lifecycle. A legacy IN-workspace
// memory/ directory is migrated by a single rename (byte-preserving); if both layouts
// exist the compile REFUSES (never merges silently). Contents are never written beyond
// the create-if-missing scaffold.
async function ensureMemory(ws: string): Promise<string> {
  const root = memoryRootFor(ws);
  const link = path.join(ws, 'memory');
  let st: Stats | null = null;
  try { st = await fs.lstat(link); } catch { /* absent */ }
  if (st?.isDirectory()) { // lstat: true only for a REAL directory, not a symlink
    if (await exists(root))
      fail(`both ${link} (legacy in-workspace memory) and ${root} exist — merge them manually, then re-run`);
    await fs.rename(link, root);
    st = null;
  } else if (st && !st.isSymbolicLink()) {
    fail(`${link} exists and is neither a directory nor a symlink — move it away, then re-run`);
  }
  await fs.mkdir(path.join(root, 'spec'), { recursive: true });
  const keep = path.join(root, 'spec', '.gitkeep');
  if (!await exists(keep)) await fs.writeFile(keep, '');
  const target = path.relative(ws, root); // relative: the pair survives moving the parent
  if (st?.isSymbolicLink()) {
    if (await fs.readlink(link) === target) return root;
    await fs.rm(link); // a symlink only — real directories were handled above
  }
  await fs.symlink(target, link, 'dir');
  return root;
}

async function writeArtifact(list: ArtifactRow[], ws: string, rel: string, content: string | Buffer): Promise<void> {
  assertNotInstanceData(rel);
  const target = path.join(ws, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const buf = Buffer.from(content as string);
  await fs.writeFile(target, buf);
  list.push({ id: rel, sha256: sha256(buf) });
}

// Copy artifacts record WHICH repo their source lives in (core/data split): `from:
// 'data'` = the data pack (skills, agents, docs, runbooks), absent = the framework repo
// (the gate) — verify --source re-derives against the matching root and pin. A v1 lock
// (no `from`) reads as framework — backward-compatible.
function srcRef(sourceAbs: string): { source: string; from?: 'data' } {
  const data = requireData();
  return sourceAbs.startsWith(data + path.sep)
    ? { source: path.relative(data, sourceAbs), from: 'data' }
    : { source: path.relative(FW_ROOT, sourceAbs) };
}

async function copyArtifact(list: ArtifactRow[], ws: string, rel: string, sourceAbs: string): Promise<void> {
  assertNotInstanceData(rel);
  const buf = await fs.readFile(sourceAbs);
  const target = path.join(ws, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buf);
  list.push({ id: rel, ...srcRef(sourceAbs), sha256: sha256(buf) });
}

// Skills + agent sources pass through the capability-marker gate: a workspace must not
// receive a directive (or a tool allowlist entry) for a capability it does not have —
// atlas-off workspaces would otherwise keep doing lookups/distillation, and a
// docs-MCP-less workspace must not name context7 tools. The lock entry records
// `transform: 'gates'`; `verify --source` re-applies the same pass at the pinned commit
// (gate values reconstructed from the lock itself).
async function copyGated(list: ArtifactRow[], ws: string, rel: string, sourceAbs: string, gates: Record<string, boolean>): Promise<void> {
  assertNotInstanceData(rel);
  const ref = srcRef(sourceAbs);
  let text: string;
  try { text = applyMarkers(await fs.readFile(sourceAbs, 'utf8'), gates, ref.source); }
  catch (e) { fail(`capability-marker lint: ${(e as Error).message}`); }
  const target = path.join(ws, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const buf = Buffer.from(text);
  await fs.writeFile(target, buf);
  list.push({ id: rel, ...ref, transform: 'gates', sha256: sha256(buf) });
}

// The gate values a config implies. Kept in ONE place — verify derives the same set from
// the lock (lib/lock.mts) and both must stay in step with the keys sources use.
export function capabilityGates(cfg: Cfg): Record<string, boolean> {
  return {
    atlas: Boolean(cfg.atlas),
    'mcp-docs': cfg.mcp.some((id) => MCP_CATALOG[id].role === 'docs'),
  };
}

export async function install(cfg: Cfg): Promise<ArtifactRow[]> {
  const ws = cfg.workspace;
  const artifacts: ArtifactRow[] = [];
  const catalog = cfg.catalog;
  const agents = neededAgents(cfg.skills, catalog);
  // Canonical HARNESSES order (not answers order) keeps the artifact list — and the
  // lock — deterministic.
  const targets = HARNESSES.filter((h) => cfg.harnesses.includes(h));
  await fs.mkdir(ws, { recursive: true });
  // Memory first: the sibling root + the workspace symlink must exist before anything
  // (the gate may log telemetry from the very first session).
  await ensureMemory(ws);
  const gates = capabilityGates(cfg);

  // Runbook references: every `stacks.<n>.runbook` / `runtimeTiers.ladder[].runbook`
  // string must name a runbook the deployment SHIPS (unknown = config bug, fail); one
  // excluded by the repo lint just isn't installed — the consumer is warned below.
  const shipped = new Set(catalog.runbooks.map((r) => r.name));
  const installedRb = new Set((cfg.runbooks ?? []).map((r) => r.name));
  const rbRef = (ref: unknown, where: string): boolean => {
    if (typeof ref !== 'string') return true;
    if (!shipped.has(ref)) fail(`${where} references runbook "${ref}" — no such runbook in the deployment`);
    return installedRb.has(ref);
  };
  for (const rung of cfg.profile?.manifest?.runtimeTiers?.ladder ?? [])
    if (rung.runbook !== undefined && !rbRef(rung.runbook, `runtimeTiers tier "${rung.tier}"`))
      (cfg.warnings ??= []).push(`runtimeTiers tier "${rung.tier}": runbook "${rung.runbook}" excluded by the repo lint — the tier is not runnable in this workspace`);

  // Per-profile stack wrappers (the deployment must bring up its
  // stacks with or without Atlas): one GENERATED `up-<profile>` skill per entry in the
  // deployment config's stacks — project-dependent values, generic mechanism. The engine
  // they delegate to is the installed skill declaring `metadata.taut.role: stack-engine`
  // (core carries no content names — core/data split). A stack whose runbook the repo
  // lint excluded gets NO wrapper — never a silently dead artifact. The set is resolved
  // ONCE (warnings must not repeat per harness); rendering happens per harness below.
  const stackEngine = cfg.skills.find((s) => catalog.skills.get(s)?.meta.role === 'stack-engine') ?? null;
  const wrapperStacks: [string, any][] = [];
  if (stackEngine)
    for (const [sname, stack] of Object.entries<any>(cfg.profile?.manifest?.stacks ?? {})) {
      if (!rbRef(stack.runbook, `stack "${sname}"`)) {
        (cfg.warnings ??= []).push(`stack "${sname}": runbook "${stack.runbook}" excluded by the repo lint — up-${sname} not generated`);
        continue;
      }
      wrapperStacks.push([sname, stack]);
    }

  // Per-harness NATIVE sets — every enabled harness gets its own full toolchain; the
  // trees are disjoint by construction, so the union is conflict-free. Codex targets are
  // its NATIVE mechanisms: skills → .agents/skills (Agent Skills standard), subagents →
  // .codex/agents/*.toml, MCP + gate hooks → project .codex/config.toml (trust-gated).
  for (const h of targets) {
    const forCodex = h === 'codex';
    const skillsBase = forCodex ? '.agents/skills' : '.claude/skills';
    for (const s of cfg.skills) {
      const src = catalog.skills.get(s) ?? fail(`skill "${s}" not found in the framework/deployment catalog`);
      await copyGated(artifacts, ws, `${skillsBase}/${s}/SKILL.md`, src.path, gates);
    }
    for (const [sname, stack] of wrapperStacks)
      await writeArtifact(artifacts, ws, `${skillsBase}/up-${sname}/SKILL.md`, renderStackSkill(sname, stack, cfg, stackEngine!));
    for (const a of agents) {
      const src = catalog.agents.get(a) ?? fail(`agent "${a}" is named by an installed skill but not shipped by the framework`);
      if (forCodex) {
        // Codex agents are RENDERED (TOML), so the capability gate applies to the source
        // body before rendering; the artifact stays lock-checked like every generated file.
        let md: string;
        try { md = applyMarkers(await fs.readFile(src.path, 'utf8'), gates, path.relative(FW_ROOT, src.path)); }
        catch (e) { fail(`capability-marker lint: ${(e as Error).message}`); }
        await writeArtifact(artifacts, ws, `.codex/agents/${a}.toml`, renderCodexAgentToml(a, md, cfg));
      } else await copyGated(artifacts, ws, `.claude/agents/${a}.md`, src.path, gates);
    }
    await writeArtifact(artifacts, ws, forCodex ? 'AGENTS.md' : 'CLAUDE.md', renderInstructions(cfg, { forCodex }));
    if (!forCodex && cfg.mcp.length) await writeArtifact(artifacts, ws, '.mcp.json', renderMcpJson(cfg));
    if (forCodex) await writeArtifact(artifacts, ws, '.codex/config.toml',
      renderCodexConfigToml(cfg) + renderCodexHooksToml());
    if (!forCodex) await writeArtifact(artifacts, ws, '.claude/settings.json', renderClaudeSettings(cfg));
  }

  await writeArtifact(artifacts, ws, 'manifest.json', JSON.stringify(buildManifest(cfg), null, 2) + '\n');
  // The `node ui` launcher — executable so `./ui` works too; non-payload id ⇒ CORE for
  // the gate (a tampered launcher blocks the session).
  await writeArtifact(artifacts, ws, 'ui', renderUiShim());
  await fs.chmod(path.join(ws, 'ui'), 0o755);

  if (cfg.mcp.length) {
    // MCP servers launch through the workspace's own launcher, which reads
    // .taut/local.env at server start — filling the file is all a developer does.
    await writeArtifact(artifacts, ws, '.taut/mcp-servers.json', renderMcpServersSpec(cfg));
    await copyArtifact(artifacts, ws, '.taut/mcp-launch.mjs', path.join(FW_ROOT, 'gate', 'mcp-launch.mjs'));
  }

  // Integrity gate: self-contained gate script + harness hook wiring, both locked.
  await copyArtifact(artifacts, ws, '.taut/gate.mjs', path.join(FW_ROOT, 'gate', 'gate.mjs'));
  // The telemetry adapter ships NEXT to the gate — the SINGLE write path for usage
  // telemetry (local-only daily files under memory/telemetry/); the gate imports it as
  // a sibling, the CLI uses the engine copy. Missing adapter = telemetry no-op.
  await copyArtifact(artifacts, ws, '.taut/telemetry.mjs', path.join(FW_ROOT, 'gate', 'telemetry.mjs'));
  // The law text ships WITH the workspace (the law source is the
  // framework repo, never an external path); non-payload id ⇒ CORE for the gate.
  // Laws are a CORE document of the distribution model — every workspace gets them.
  if (catalog.laws) await copyArtifact(artifacts, ws, '.taut/LAWS.md', catalog.laws.path);
  // Flow DOCUMENTS (a flow = a documented launch order): ship each doc whose sequence
  // touches an installed skill. Plain docs (any other docs/*.md) ship always. Runbooks:
  // the deployment's repo-lint-surviving set.
  for (const f of installedFlowDocs(cfg))
    await copyGated(artifacts, ws, `.taut/docs/FLOW-${f.name}.md`, f.path, gates);
  for (const d of catalog.docs)
    await copyGated(artifacts, ws, `.taut/docs/${d.name}`, d.path, gates);
  for (const r of cfg.runbooks ?? [])
    await copyGated(artifacts, ws, `.taut/runbooks/${r.name}.md`, r.path, gates);

  // REPO DESCRIPTORS: the pack's per-repo working knowledge ships for every
  // repo CONNECTED in this workspace — byte-copied, integrity-locked, swept when the
  // repo leaves. A descriptor for a known-but-unconnected repo is silently skipped
  // (normal: that workspace just does not use the repo).
  const connectedNames = new Set(cfg.repos.map((r) => r.name));
  for (const [rname, files] of catalog.repoDocs) {
    if (!connectedNames.has(rname)) continue;
    for (const f of files)
      await copyArtifact(artifacts, ws, `.taut/repos/${rname}/${f.file}`, f.path);
  }

  // Per-developer secrets: placeholders + format examples only — setup never asks for or
  // stores token values. An existing file is preserved (it may hold filled secrets).
  const envKeys = [...new Set(cfg.mcp.flatMap((id) => MCP_CATALOG[id].env))];
  if (envKeys.length) {
    const envPath = path.join(ws, '.taut', 'local.env');
    if (!await exists(envPath)) {
      const block = (k: string) => [
        ...(ENV_HELP[k] ?? []).map((l, i) => (i === 0 ? `# ${k} — ${l}` : `#   ${l}`)),
        `${k}=`,
        '',
      ].join('\n');
      await fs.mkdir(path.dirname(envPath), { recursive: true });
      await fs.writeFile(envPath,
        '# Per-developer secrets — fill in, never commit, never share.\n' +
        '# Read AUTOMATICALLY by the TAUT MCP launcher when a server starts — nothing to\n' +
        '# export or source. After filling, reconnect MCP servers (or restart the session).\n' +
        '# A filled value here beats the parent environment; an empty line never erases it.\n\n' +
        envKeys.map(block).join(''), { mode: 0o600 });
    }
  }

  return artifacts;
}

// ---------------------------------------------------------------- member instruction files

// Precedence is a LAW, not configuration: tasks launched FROM the
// workspace follow the workspace's laws/skills/agents; tasks launched from inside a
// member repo follow that repo's own files. TAUT never modifies member-repo files
// and never asks the user to rank them. This scan is a purely informational inventory.
const POLICY_SIGNALS = [
  { key: 'git-policy', re: /\b(commit|push|create branch|branch off|merge|rebase)\b/i },
  { key: 'sql', re: /\b(run sql|execute sql|psql|mysql -|database migration)\b/i },
];

export async function scanMemberInstructionFiles(cfg: Cfg): Promise<MemberFile[]> {
  const results: MemberFile[] = [];
  for (const repo of cfg.repos) {
    for (const file of ['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md']) {
      const text = await readIfExists(path.join(repo.path, file));
      if (text === null) continue;
      const signals = POLICY_SIGNALS.filter((s) => s.re.test(text)).map((s) => s.key);
      results.push({ repo: repo.name, file, signals });
    }
  }
  return results;
}
