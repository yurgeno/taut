// TAUT core — the flat artifact model (no flow entity: a flow is a documented launch order).
// The framework distributes SIX kinds of elements: skills/ (each SKILL.md declares its
// own wiring in frontmatter `metadata.taut` — delegated agents, required
// capabilities, MCP roles, repo bindings), agents/ (installed only when a selected skill
// names them), the MCP catalog (catalog/mcp.json), deployment runbooks
// (<project>/runbooks/*.md in the pack — frontmatter = index values, body = the recipe
// an agent reads), flow DOCUMENTS (docs/FLOW-*.md — a flow is nothing but a documented
// launch order over installed skills), and the repo map (deployment repos[] + per-
// artifact `repos:` bindings, linted at compile). This module owns the strict
// frontmatter parser, the artifact catalog, its derived views, and the repo-map lint.
import fs from 'node:fs/promises';
import path from 'node:path';

import { requireData } from './constants.mts';
import { exists, fail } from './util.mts';
import { applyMarkers, withLegacyGates } from './markers.mts';
import type { Catalog, Profile, RepoDocFile } from './types.mts';

// Known capability-gate keys — must mirror capabilityGates (lib/install.mts) and the
// verify reconstruction (lib/lock.mts). Catalog metadata is parsed under BOTH extreme
// gate settings and must not vary between them (wiring is capability-independent).
const GATE_KEYS = ['kaut', 'mcp-docs']; // legacy marker key `atlas` = alias of the kaut gate
export const gatesAll = (v: boolean): Record<string, boolean> => withLegacyGates(Object.fromEntries(GATE_KEYS.map((k) => [k, v])));

// ---------------------------------------------------------------- frontmatter (subset)

// Strict SUBSET of YAML — exactly what framework sources use (every source is authored
// in-framework, so the format is ours to constrain): scalar values, inline [a, b] lists,
// block lists of scalars, nested maps by 2-space indentation, quoted strings. Anything
// else fails the compile (lint) instead of parsing wrong — deliberately NOT a general
// YAML parser (zero-dependency compiler). Parsed frontmatter is `any` by design: a
// PARSE BOUNDARY — consumers narrow what they read.
function parseScalar(s: string, id: string, ln: number): string | boolean | string[] {
  s = s.trim();
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) fail(`${id}:${ln}: unterminated inline list`);
    const inner = s.slice(1, -1).trim();
    if (/['"]/.test(inner)) fail(`${id}:${ln}: quoted items in inline lists are not supported — use a block list`);
    return inner ? inner.split(',').map((x) => x.trim()).filter(Boolean) : [];
  }
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replaceAll("''", "'");
  if (/^".*"$/.test(s)) return s.slice(1, -1).replaceAll('\\"', '"');
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

function parseBlock(lines: string[], start: number, indent: number, id: string, base: number): [any, number] {
  let node: any = null; // becomes {} or [] on first content line
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    if (!raw.trim()) { i += 1; continue; }
    const cur = raw.match(/^ */)![0].length;
    if (cur < indent) break;
    const ln = base + i;
    if (cur > indent) fail(`${id}:${ln}: unexpected indent (continuation lines are not supported — keep values single-line)`);
    const t = raw.trim();
    if (t.startsWith('- ')) {
      node ??= [];
      if (!Array.isArray(node)) fail(`${id}:${ln}: list item inside a map block`);
      node.push(parseScalar(t.slice(2), id, ln));
      i += 1;
    } else {
      const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(t);
      if (!m) fail(`${id}:${ln}: unsupported frontmatter line "${t}"`);
      node ??= {};
      if (Array.isArray(node)) fail(`${id}:${ln}: map key inside a list block`);
      if (m[1] in node) fail(`${id}:${ln}: duplicate key "${m[1]}" (a capability branch left ungated?)`);
      const rest = m[2].trim();
      if (rest) { node[m[1]] = parseScalar(rest, id, ln); i += 1; }
      else { const [v, next] = parseBlock(lines, i + 1, indent + 2, id, base); node[m[1]] = v ?? {}; i = next; }
    }
  }
  return [node, i];
}

export function parseFrontmatter(text: string, id = 'artifact'): { fm: any; body: string } {
  if (!text.startsWith('---\n')) return { fm: {}, body: text };
  const lines = text.split('\n');
  const close = lines.indexOf('---', 1);
  if (close === -1) fail(`${id}: unclosed frontmatter`);
  const [fm] = parseBlock(lines.slice(1, close), 0, 0, id, 2);
  if (fm !== null && Array.isArray(fm)) fail(`${id}: frontmatter root must be a map`);
  return { fm: fm ?? {}, body: lines.slice(close + 1).join('\n') };
}

// Frontmatter of a gated SOURCE: apply the capability markers under both extreme gate
// settings, lint that `metadata.taut` (the wiring) is identical in both, and
// return the all-on view (display fields like a gated description legitimately vary).
async function readSourceMeta(abs: string, id: string): Promise<any> {
  const raw = await fs.readFile(abs, 'utf8');
  let on: string; let off: string;
  try {
    on = applyMarkers(raw, gatesAll(true), id);
    off = applyMarkers(raw, gatesAll(false), id);
  } catch (e) { fail(`capability-marker lint: ${(e as Error).message}`); }
  const fmOn = parseFrontmatter(on, id).fm;
  const fmOff = parseFrontmatter(off, id).fm;
  if (fmOn.metadata?.federation !== undefined)
    fail(`${id}: legacy wiring key "metadata.federation" — the framework was renamed, use "metadata.taut"`);
  const wiringOn = JSON.stringify(fmOn.metadata?.taut ?? {});
  if (wiringOn !== JSON.stringify(fmOff.metadata?.taut ?? {}))
    fail(`${id}: metadata.taut must not vary by capability branch (wiring is capability-independent)`);
  return fmOn;
}

// ---------------------------------------------------------------- catalog

// Everything the data pack (+ the selected deployment) can install, resolved by NAME.
// Name collisions between pack and project payload are a lint error — a compiled
// workspace must never depend on iteration order. Content lives in the DATA pack
// (core/data split): skills/, agents/, docs/ under the resolved data root.
export async function loadCatalog(profile: Profile | null): Promise<Catalog> {
  const data = requireData();
  const catalog: Catalog = { skills: new Map(), agents: new Map(), flowDocs: [], laws: null, runbooks: [], docs: [], repoDocs: new Map() };

  const addSkills = async (dir: string, origin: string) => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name, 'SKILL.md');
      if (!await exists(p)) continue;
      if (catalog.skills.has(e.name))
        fail(`skill name collision: "${e.name}" in "${catalog.skills.get(e.name)!.origin}" and "${origin}"`);
      const id = path.relative(data, p);
      const fm = await readSourceMeta(p, id);
      if (fm.name !== e.name) fail(`${id}: frontmatter name "${fm.name}" != directory name "${e.name}"`);
      catalog.skills.set(e.name, {
        path: p, origin, description: fm.description ?? '', meta: fm.metadata?.taut ?? {},
      });
    }
  };
  await addSkills(path.join(data, 'skills'), 'framework');
  if (profile?.dir) await addSkills(path.join(profile.dir, 'skills'), `deployment:${profile.name}`);

  // Agents: pack level + PROJECT level (a project folder
  // carries EVERYTHING project-scoped — agents included). Name collisions fail like
  // skills; a compiled workspace must never depend on iteration order.
  const addAgents = async (dir: string, origin: string) => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name === 'README.md') continue;
      const name = e.name.replace(/\.md$/, '');
      if (catalog.agents.has(name))
        fail(`agent name collision: "${name}" in "${catalog.agents.get(name)!.origin}" and "${origin}"`);
      catalog.agents.set(name, { path: path.join(dir, e.name), origin });
    }
  };
  await addAgents(path.join(data, 'agents'), 'framework');
  if (profile?.dir) await addAgents(path.join(profile.dir, 'agents'), `deployment:${profile.name}`);

  // Docs: pack level + PROJECT level. FLOW/plain names must be unique across levels;
  // a project-level LAWS.md OVERRIDES the pack-level one (the project's laws are the
  // laws of its workspaces).
  const addDocs = async (dir: string, origin: string) => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isFile()) continue;
      const abs = path.join(dir, e.name);
      const id = path.relative(data, abs);
      if (/^FLOW-.+\.md$/.test(e.name)) {
        const fm = await readSourceMeta(abs, id);
        const expect = e.name.slice(5, -3);
        if (fm.name !== expect) fail(`${id}: frontmatter name "${fm.name}" != file name "${expect}"`);
        if (!Array.isArray(fm.sequence) || !fm.sequence.length) fail(`${id}: a flow doc needs a non-empty sequence`);
        if (catalog.flowDocs.some((f) => f.name === fm.name))
          fail(`flow doc name collision: "${fm.name}" appears at both the pack and the project level`);
        catalog.flowDocs.push({ name: fm.name, description: fm.description ?? '', sequence: fm.sequence, path: abs });
      } else if (e.name === 'LAWS.md') {
        const fm = await readSourceMeta(abs, id);
        catalog.laws = { path: abs, summary: fm.summary ?? [] };
      } else if (e.name.endsWith('.md')) {
        // Any other markdown in docs/ is a PLAIN distributable document (docs are just
        // md files) — shipped to every workspace's
        // .taut/docs/, no wiring, browsable from the panel.
        if (catalog.docs.some((d) => d.name === e.name))
          fail(`doc name collision: "${e.name}" appears at both the pack and the project level`);
        catalog.docs.push({ name: e.name, path: abs });
      }
    }
  };
  await addDocs(path.join(data, 'docs'), 'framework');
  if (profile?.dir) await addDocs(path.join(profile.dir, 'docs'), `deployment:${profile.name}`);

  if (profile?.dir) {
    let rbEntries: import('node:fs').Dirent[] = [];
    try { rbEntries = await fs.readdir(path.join(profile.dir, 'runbooks'), { withFileTypes: true }); } catch { rbEntries = []; }
    for (const e of rbEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const abs = path.join(profile.dir, 'runbooks', e.name);
      const id = `${profile.name}/runbooks/${e.name}`;
      const fm = await readSourceMeta(abs, id);
      const expect = e.name.slice(0, -3);
      if (fm.name !== expect) fail(`${id}: frontmatter name "${fm.name}" != file name "${expect}"`);
      catalog.runbooks.push({
        name: fm.name, description: fm.description ?? '', repos: fm.repos ?? [], path: abs,
      });
    }

    // REPO DESCRIPTORS: `<project>/repos/<repo>/*.md` —
    // per-repo working knowledge (CLAUDE.md, Style.md, …) that installs into the
    // workspace as `.taut/repos/<repo>/` for every CONNECTED repo. The repo itself
    // stays untouched; agents read the shadow copies under the L9 precedence. A folder
    // for a repo the deployment does not know = compile error (typo or wrong project).
    const known = new Set([...(profile.repos?.mandatory ?? []), ...Object.keys(profile.repos?.known ?? {})]);
    let rdEntries: import('node:fs').Dirent[] = [];
    try { rdEntries = await fs.readdir(path.join(profile.dir, 'repos'), { withFileTypes: true }); } catch { rdEntries = []; }
    for (const e of rdEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory()) continue;
      if (known.size && !known.has(e.name))
        fail(`${profile.name}/repos/${e.name}: repo is not in the deployment config (repo map) — fix the folder name or the config`);
      const dir = path.join(profile.dir, 'repos', e.name);
      const files: RepoDocFile[] = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((f) => f.isFile() && f.name.endsWith('.md'))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => ({ file: f.name, path: path.join(dir, f.name) }));
      if (files.length) catalog.repoDocs.set(e.name, files);
    }
  }

  return catalog;
}

// ---------------------------------------------------------------- derived views

// The launch-order union over every shipped flow doc — used for checklist hints and
// chain-gap warnings; a flow is never installed, only documented.
export const stageChain = (catalog: Pick<Catalog, 'flowDocs'>): string[] => catalog.flowDocs.flatMap((f) => f.sequence);

// Skills that declare `requires: [kaut]` — filtered out when the workspace has no KAUT.
// The legacy `atlas` requirement is an alias (pre-rename pack skills gate identically).
export const kautRequired = (catalog: Pick<Catalog, 'skills'>): string[] =>
  [...catalog.skills].filter(([, s]) => {
    const req = s.meta.requires ?? [];
    return req.includes('kaut') || req.includes('atlas');
  }).map(([n]) => n);

// Agents are installed only when a selected skill names them in metadata.taut.agents
// — an agent no skill references stays uninstalled (dead payload, by design).
export function neededAgents(skills: string[], catalog: Pick<Catalog, 'skills'>): string[] {
  const out = new Set<string>();
  for (const s of skills) for (const a of catalog.skills.get(s)?.meta.agents ?? []) out.add(a);
  return [...out].sort();
}

// ---------------------------------------------------------------- repo-map lint

// The sixth element: artifacts bind to the landscape by repo NAME.
// A name outside the deployment config = COMPILE ERROR (typo or wrong deployment); a
// binding to a repo not connected in THIS workspace = the artifact is EXCLUDED with a
// warning — never a silently dead artifact. items: [{kind, name, repos}].
export function lintRepoBindings(
  items: { kind: string; name: string; repos?: string[] }[],
  profile: Profile | null,
  connectedNames: Set<string>,
  warnings: string[],
): Set<string> {
  const known = profile
    ? new Set([...(profile.repos?.mandatory ?? []), ...Object.keys(profile.repos?.known ?? {})])
    : null;
  const excluded = new Set<string>();
  for (const it of items) {
    const bound = it.repos ?? [];
    for (const r of bound)
      if (known && !known.has(r))
        fail(`${it.kind} "${it.name}": repo binding "${r}" is not in the deployment config (repo map) — fix the artifact or the config`);
    const missing = bound.filter((r) => !connectedNames.has(r));
    if (missing.length) {
      excluded.add(it.name);
      warnings.push(`${it.kind} "${it.name}" is bound to repo(s) not connected in this workspace: ${missing.join(', ')} — excluded`);
    }
  }
  return excluded;
}
