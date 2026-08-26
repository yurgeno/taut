// TAUT compiler — configuration gathering: deployment profiles, member-repo
// scanning, the interactive/non-interactive `setup` questionnaire (gatherConfig), and
// the manifest-driven reconstruction used by `repair` (cfgFromWorkspace).
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  HARNESSES, MCP_CATALOG, OWNED_MANIFEST_KEYS, initProject, langName, requireData,
} from './constants.mts';
import { TELEMETRY_LEVELS } from '../gate/telemetry.mjs';
import { bold, dim, exists, expandHome, fail, green, readIfExists, yellow } from './util.mts';
import { chatChoice } from './manifest.mts';
import { kautRequired, lintRepoBindings, loadCatalog, stageChain } from './artifacts.mts';
import { askText, tuiSelect } from './tui.mts';
import type { Cfg, Profile, Repo } from './types.mts';

// ---------------------------------------------------------------- deployment profiles

// Values-only instance configs shipped with the DATA PACK — the sanctioned home for
// instance names. PROJECT FOLDERS live at the PACK ROOT (a `<project>/` folder makes it
// obvious the data belongs to that project only — other projects may sit next to it):
// every top-level `<name>/` carrying a `deployment.json` is one
// project's home — its values, project skills/, runbooks/ (and later per-repo material)
// all live inside it; the shared dirs (skills/agents/docs/catalog) can never be
// projects. The generated manifest = profile × connected repos; repos.mandatory cannot
// be deselected.
const SHARED_DIRS = new Set(['skills', 'agents', 'docs', 'catalog']);
export async function listDeployments(): Promise<Profile[]> {
  const root = requireData();
  const out: Profile[] = [];
  let entries: import('node:fs').Dirent[] = [];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const cfgPath = path.join(root, e.name, 'deployment.json');
    if (!await exists(cfgPath)) continue;
    if (SHARED_DIRS.has(e.name))
      fail(`pack layout: "${e.name}/" is a shared content dir — it cannot carry a deployment.json`);
    let parsed: any = null;
    try { parsed = JSON.parse(await fs.readFile(cfgPath, 'utf8')); }
    catch { process.stderr.write(`taut: warning: broken deployment profile ${e.name} skipped\n`); continue; }
    if ((parsed.name ?? e.name) !== e.name)
      fail(`${e.name}/deployment.json: name "${parsed.name}" != project folder name "${e.name}"`);
    out.push({ ...parsed, dir: path.join(root, e.name) });
  }
  return out.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}

// ---------------------------------------------------------------- repo scanning

export async function isConductorDir(p: string): Promise<boolean> {
  // A TAUT workspace (live or compiled) must never be offered as a member repo. The
  // legacy markers stay checked forever: pre-rename FEDERATION workspaces exist in the
  // wild and must be skipped by the scan just the same.
  if (await exists(path.join(p, 'taut.lock')) || await exists(path.join(p, 'federation.lock'))) return true;
  const m = await readIfExists(path.join(p, 'manifest.json'), 64 * 1024);
  if (m !== null) {
    try { if (['taut', 'federation'].includes(JSON.parse(m).framework)) return true; }
    catch { /* not a manifest */ }
  }
  return false;
}

// Depth-2 scan: level 1 finds git repos directly in the landscape root; a level-1 dir
// that is NOT a git repo and NOT a workspace is treated as a possible PROJECT FOLDER and
// searched one level deeper (grouping a project's repos in a folder is common — both
// pilot projects have that shape). Names stay basenames; a basename claimed twice keeps
// the first hit (sorted order = deterministic) and reports the loser in `collisions` —
// connect the other one by path (apply --connect-repo <path>) if it was the wanted one.
export async function scanRepos(root: string, excludeAbs: string[] = []): Promise<{ repos: Repo[]; skippedConductors: string[]; collisions: string[] }> {
  const repos: Repo[] = [];
  const skippedConductors: string[] = [];
  const collisions: string[] = [];
  const seen = new Map<string, string>();
  const consider = async (name: string, abs: string, via: string | null) => {
    if (await isConductorDir(abs)) { skippedConductors.push(via ? `${via}/${name}` : name); return; }
    const kept = seen.get(name);
    if (kept) { collisions.push(`"${name}": kept ${kept}, skipped ${abs}`); return; }
    seen.set(name, abs);
    repos.push({ name, path: abs });
  };
  const listDirs = async (dir: string): Promise<import('node:fs').Dirent[]> => {
    try {
      return (await fs.readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
  };
  for (const e of await listDirs(root)) {
    const abs = path.join(root, e.name);
    if (excludeAbs.includes(abs)) continue;
    if (await exists(path.join(abs, '.git'))) { await consider(e.name, abs, null); continue; }
    if (await isConductorDir(abs)) { skippedConductors.push(e.name); continue; }
    for (const sub of await listDirs(abs)) {
      const subAbs = path.join(abs, sub.name);
      if (excludeAbs.includes(subAbs)) continue;
      if (!await exists(path.join(subAbs, '.git'))) continue;
      await consider(sub.name, subAbs, e.name);
    }
  }
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return { repos, skippedConductors, collisions };
}

// ---------------------------------------------------------------- config gathering

// The KAUT engine folder an ENABLED integration must carry: resolved absolute, and it
// must actually hold the engine — a wrong path fails setup rather than compiling a
// workspace whose instructions point at nothing. The engine CLI is kaut.mjs; a legacy
// engine checkout still shipping atlas.mjs (pre-rename) is accepted the same.
async function resolveKautRoot(dir: unknown): Promise<string> {
  const root = path.resolve(expandHome(String(dir)));
  if (!(await exists(path.join(root, 'kaut.mjs'))) && !(await exists(path.join(root, 'atlas.mjs'))))
    fail(`KAUT folder not usable: ${root} — expected the KAUT engine there (kaut.mjs, or legacy atlas.mjs); point at the engine checkout`);
  return root;
}

// Canonical harness set from answers/manifest/CLI input: array or comma string in,
// deduped HARNESSES-ordered array out (deterministic compiles); unknown or empty fails.
export function normalizeHarnesses(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map(String) : String(v).split(',').map((s) => s.trim()).filter(Boolean);
  for (const h of list) if (!HARNESSES.includes(h)) fail(`unknown harness "${h}" (expected: ${HARNESSES.join(', ')})`);
  const set = new Set(list);
  const out = HARNESSES.filter((h) => set.has(h));
  if (!out.length) fail('at least one harness must be enabled');
  return out;
}

// (Re-)run the repo-map lint against cfg's CURRENT repos, replacing every derived piece:
// exclusions, the installed runbook set, the skills pool (when already chosen), and the
// lint warnings (a fresh bag each pass — a relint after apply's repo toggles must not
// stack stale duplicates). Shared by gatherConfig, cfgFromWorkspace and cmdApply.
export function relintRepoBindings(cfg: Cfg): void {
  const connected = new Set(cfg.repos.map((r) => r.name));
  cfg.lintWarnings = [];
  cfg.repoExcludedSkills = lintRepoBindings(
    [...cfg.catalog.skills].map(([n, s]) => ({ kind: 'skill', name: n, repos: s.meta.repos })),
    cfg.profile, connected, cfg.lintWarnings);
  const excludedRunbooks = lintRepoBindings(
    cfg.catalog.runbooks.map((r) => ({ kind: 'runbook', name: r.name, repos: r.repos })),
    cfg.profile, connected, cfg.lintWarnings);
  cfg.runbooks = cfg.catalog.runbooks.filter((r) => !excludedRunbooks.has(r.name));
  if (cfg.skills) cfg.skills = cfg.skills.filter((s) => !cfg.repoExcludedSkills!.has(s));
}

export async function gatherConfig(answers: any, interactive: boolean): Promise<Cfg> {
  // Rename normalization (Atlas → KAUT): a legacy answers file may still say `atlas` —
  // folded into the canonical `kaut` key ONCE here, at the answers parse boundary.
  if (answers.kaut === undefined && answers.atlas !== undefined) answers.kaut = answers.atlas;
  const deployments = await listDeployments();
  // Filled step by step below, exactly in questionnaire order — typed as the final
  // shape (every required field is assigned before return; the checker cannot follow
  // the incremental protocol, the suite does).
  const cfg = {} as Cfg;
  const warnings: string[] = [];
  const need = (k: string) => fail(`missing config "${k}" (non-interactive run needs it in --answers)`);
  let totalSteps = 8 + (deployments.length ? 1 : 0);
  let stepNo = 0;
  const step = (t: string) => `Step ${++stepNo}/${totalSteps} · ${t}`;

  // Deployment config — the PROJECT layer over the flat artifact catalog (values, repo
  // map, project skills + runbooks). Selection is REQUIRED whenever configs exist; a
  // single config is auto-selected and cannot be deselected.
  // `deployment: "none"` in answers is a service escape (tests / a framework clone that
  // ships no project folders).
  if (answers.deployment !== undefined) {
    cfg.profile = answers.deployment === 'none' ? null
      : deployments.find((d) => d.name === answers.deployment)
        ?? fail(`unknown deployment "${answers.deployment}" (available: ${deployments.map((d) => d.name).join(', ') || 'none'})`);
  } else if (!deployments.length) {
    cfg.profile = null; // no configs shipped — generic framework mode
  } else if (!interactive) {
    need('deployment');
  } else if (deployments.length === 1) {
    cfg.profile = deployments[0];
    process.stdout.write(`${green('✔')} ${bold(step('Deployment config'))} ${dim('·')} ${cfg.profile.name} ${dim('(the only config — selected)')}\n`);
  } else {
    cfg.profile = await tuiSelect(step('Deployment config'), deployments.map((d) => ({
      label: d.name, value: d, hint: d.description,
    })), { summary: (v) => v.name });
  }
  if (deployments.length && stepNo === 0) stepNo = 1; // keep numbering when the step was answered
  // A deployment-declared session-language choice adds ONE questionnaire step (asked
  // exactly when declared — see the block after mode). Malformed declarations fail here,
  // before any question runs.
  const langChoice = chatChoice(cfg.profile?.manifest);
  if (langChoice) totalSteps += 1;
  for (const k of Object.keys(cfg.profile?.manifest ?? {}))
    if (OWNED_MANIFEST_KEYS.has(k) && k !== 'flow')
      warnings.push(`deployment config "${cfg.profile!.name}": manifest.${k} is compiler-owned — ignored`);
  const mandatory = cfg.profile?.repos?.mandatory ?? [];
  const known = cfg.profile?.repos?.known ?? {};

  // The artifact catalog — everything the framework (+ this deployment) can install,
  // resolved from the flat sources' own frontmatter (no flow entity; a flow is a
  // documented launch order, see docs/FLOW-*.md).
  initProject(cfg.profile?.dir); // project catalog (MCP pins/env) joins before any use
  cfg.catalog = await loadCatalog(cfg.profile);
  if (!cfg.catalog.skills.size) fail('no skills found (skills/<name>/SKILL.md) — the framework ships at least one');

  // Workspace folder. Assumed to sit in the ROOT that holds the member repos.
  if (answers.workspace === undefined && !interactive) need('workspace');
  cfg.workspace = path.resolve(expandHome(
    answers.workspace ?? await askText(step('Workspace folder (inside the root with your repos; created if missing)'))));

  // Member repos: explicit list | "scan" | interactive checklist over the scan.
  // Deployment-mandatory repos are locked (cannot be deselected); repos unknown to the
  // profile default to unchecked interactively and are excluded in "scan" mode.
  if (answers.repos !== undefined && answers.repos !== 'scan') {
    let repos = answers.repos;
    if (typeof repos === 'string') repos = repos.split(',').map((s: string) => s.trim()).filter(Boolean);
    cfg.repos = [];
    for (const r of repos) {
      const abs = path.resolve(expandHome(r));
      if (!await exists(abs)) fail(`repo folder not found: ${abs}`);
      if (!await exists(path.join(abs, '.git'))) warnings.push(`${abs} is not a git repository (kept, but guards assume git)`);
      cfg.repos.push({ name: path.basename(abs), path: abs });
    }
    stepNo += 1;
  } else {
    let root = path.dirname(cfg.workspace);
    let scan = await scanRepos(root, [cfg.workspace]);
    const missingMandatory = () => mandatory.filter((n) => !scan.repos.some((r) => r.name === n));
    if (answers.repos === 'scan') {
      if (!scan.repos.length) fail(`no git repositories found in ${root}`);
      const missing = missingMandatory();
      if (missing.length) fail(`deployment "${cfg.profile!.name}" requires repo folder(s) not found in ${root}: ${missing.join(', ')}`);
      // A deployment that CURATES its landscape (a non-empty repo map) filters the scan
      // to what it knows. A deployment that declares no repos at all curates nothing —
      // taking every scanned repo is the only reading that leaves the user with a
      // workspace instead of an empty one (the community starter ships exactly that).
      const curated = Boolean(cfg.profile) && (mandatory.length > 0 || Object.keys(known).length > 0);
      cfg.repos = curated
        ? scan.repos.filter((r) => (r.name in known) || mandatory.includes(r.name))
        : scan.repos;
      const unknown = scan.repos.filter((r) => !cfg.repos.includes(r));
      if (unknown.length) warnings.push(`scan excluded ${unknown.length} repo(s) not in the deployment profile: ${unknown.map((r) => r.name).join(', ')} (list explicitly or pick interactively to include)`);
      if (scan.skippedConductors.length)
        warnings.push(`repo scan skipped workspace dir(s): ${scan.skippedConductors.join(', ')}`);
      for (const c of scan.collisions)
        warnings.push(`repo name collision — ${c} (connect the skipped one by path: apply --connect-repo <path>)`);
      stepNo += 1;
    } else if (!interactive) {
      need('repos');
    } else {
      while (!scan.repos.length) {
        process.stdout.write(`${yellow('!')} no git repositories found in ${root}\n`);
        root = path.resolve(expandHome(await askText('Path to the root folder with the member repos')));
        scan = await scanRepos(root, [cfg.workspace]);
      }
      const missing = missingMandatory();
      if (missing.length) fail(`deployment "${cfg.profile!.name}" requires repo folder(s) not found in ${root}: ${missing.join(', ')}`);
      if (scan.skippedConductors.length)
        process.stdout.write(dim(`  skipped workspace dirs: ${scan.skippedConductors.join(', ')}`) + '\n');
      for (const c of scan.collisions)
        process.stdout.write(`${yellow('!')} repo name collision — ${c} (connect the skipped one later: apply --connect-repo <path>)\n`);
      cfg.repos = await tuiSelect(step(`Member repos in ${root}`), scan.repos.map((r) => ({
        label: path.dirname(r.path) === root ? r.name : `${path.basename(path.dirname(r.path))}/${r.name}`,
        value: r,
        locked: mandatory.includes(r.name),
        checked: !cfg.profile || (r.name in known) || mandatory.includes(r.name),
        hint: !cfg.profile || (r.name in known) || mandatory.includes(r.name) ? undefined : 'not in deployment profile',
      })), { multi: true, summary: (p) => `${p.length} of ${scan.repos.length} selected` });
    }
  }
  const dup = cfg.repos.map((r) => r.name).filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length) fail(`duplicate repo names (basenames must be unique): ${[...new Set(dup)].join(', ')}`);
  for (const m of mandatory)
    if (!cfg.repos.some((r) => r.name === m))
      fail(`deployment "${cfg.profile!.name}" requires repo "${m}" — its folder must be included`);

  // Repo-map lint (the sixth element): artifacts binding to repos by name are checked
  // against the deployment config (unknown = error) and against THIS workspace's
  // connected set (unconnected = excluded + warning). Runbooks that survive become the
  // installed set; excluded skills leave the selectable pool below. Lint warnings live
  // in their own bag (cfg.lintWarnings) so a relint after repo toggles replaces them
  // instead of stacking stale duplicates.
  cfg.warnings = warnings;
  relintRepoBindings(cfg);
  const repoExcludedSkills = cfg.repoExcludedSkills!;

  // Agent harness(es) — any subset of the adapter registry (HARNESSES). The artifact
  // trees are disjoint by construction, so enabled harnesses install side by side; the
  // set is switchable later (apply --enable-harness/--disable-harness, or the panel
  // toggles) without a re-setup.
  if (answers.harnesses !== undefined || answers.harness !== undefined) {
    cfg.harnesses = normalizeHarnesses(answers.harnesses ?? answers.harness); // scalar = legacy answers
    stepNo += 1;
  } else if (!interactive) {
    need('harnesses');
  } else {
    const hints: Record<string, string> = {
      'claude-code': 'native skills + subagents, .mcp.json',
      codex: '.agents/skills + .codex native targets',
      opencode: '.agents/skills + .opencode native targets, opencode.json',
    };
    cfg.harnesses = await tuiSelect(step('Agent harness'), [
      ...HARNESSES.map((h) => ({ label: h, value: [h], hint: hints[h] ?? 'native toolchain' })),
      { label: 'all', value: [...HARNESSES], hint: 'every supported harness side by side — switch in the panel' },
    ], { summary: (v) => v.join(' + ') });
  }

  // KAUT — DISABLED by default; enabling is the explicit opt-in and ALWAYS carries the
  // engine folder: enabled-without-location aborts setup (a workspace must never claim
  // an integration it cannot reach). Most users have never heard of KAUT — the
  // preselected "disable" hint says exactly that. Answers: a missing `kaut` key means
  // false instead of failing the non-interactive run; the ENABLING VALUE IS THE FOLDER
  // (`kaut: "<dir>"`); a bare `kaut: true` names no folder and fails. The legacy
  // `atlas` answers key was normalized into `kaut` at the top of gatherConfig.
  if (answers.kaut !== undefined) {
    stepNo += 1;
    if (typeof answers.kaut === 'string' && answers.kaut.trim() !== '') {
      cfg.kaut = true;
      cfg.kautRoot = await resolveKautRoot(answers.kaut);
    } else if (answers.kaut) {
      fail('answers: enabling KAUT requires its folder — set `kaut` to the KAUT engine directory (or omit it / set false to disable)');
    } else { cfg.kaut = false; cfg.kautRoot = null; }
  } else if (!interactive) { cfg.kaut = false; cfg.kautRoot = null; }
  else {
    cfg.kaut = await tuiSelect(step('KAUT integration'), [
      { label: 'disable', value: false, hint: 'default — if you do not know what KAUT is, pick this; KAUT-dependent skills are excluded' },
      { label: 'enable', value: true, hint: 'source-anchored knowledge engine; asks for its folder next (required)' },
    ], { summary: (v) => (v ? 'enabled' : 'disabled') });
    if (cfg.kaut) {
      const dir = (await askText('KAUT folder (where the KAUT engine lives; empty aborts setup)')).trim();
      if (!dir) fail('KAUT enabled but no folder given — setup aborted; re-run and pick "disable" if you do not use KAUT');
      cfg.kautRoot = await resolveKautRoot(dir);
    } else cfg.kautRoot = null;
  }

  // Workspace MODE: strict = only the compiled toolchain
  // runs (foreign skills/agents/MCP blocked by the gate at invocation); normal = the
  // default — framework artifacts coexist with the user's own. Resolution:
  // answers.mode > the deployment's own `mode` > interactive choice > normal.
  if (answers.mode !== undefined) { cfg.mode = String(answers.mode); stepNo += 1; }
  else if (cfg.profile?.mode !== undefined) {
    cfg.mode = cfg.profile.mode;
    if (interactive) process.stdout.write(`${green('✔')} ${bold(step('Workspace mode'))} ${dim('·')} ${cfg.mode} ${dim('(deployment default)')}\n`);
  } else if (!interactive) {
    cfg.mode = 'normal';
  } else {
    cfg.mode = await tuiSelect(step('Workspace mode'), [
      { label: 'normal', value: 'normal', hint: 'default · framework artifacts coexist with your own skills/agents/MCP' },
      { label: 'strict', value: 'strict', hint: 'only the compiled toolchain runs — foreign skills/agents/MCP blocked by the gate' },
    ], { summary: (v) => v });
  }
  if (!['strict', 'normal'].includes(cfg.mode)) fail(`unknown mode "${cfg.mode}" (expected: strict, normal)`);

  // USAGE TELEMETRY — an ENGINE-owned choice (present for every pack: telemetry is
  // engine infrastructure, not pack policy — the question exists regardless of the
  // deployment, which keeps it pack-independent). LOCAL-ONLY by law: daily files under
  // memory/telemetry/ on this machine, never sent anywhere; no personal data (no prompt
  // content, no paths, no identities, no repository names). basic = the diagnostic
  // minimum (errors, denials, lifecycle); extended (default) adds usage events.
  if (answers.telemetry !== undefined) {
    const v = String(answers.telemetry);
    if (!TELEMETRY_LEVELS.includes(v)) fail(`unknown telemetry level "${v}" (expected: ${TELEMETRY_LEVELS.join(', ')})`);
    cfg.telemetry = v;
    stepNo += 1;
  } else if (!interactive) {
    cfg.telemetry = 'extended'; // the declared default — no answers key required
  } else {
    cfg.telemetry = await tuiSelect(step('Usage telemetry (stays on this machine — never sent anywhere)'), [
      { label: 'extended', value: 'extended', hint: 'default · usage + lifecycle detail for evaluating the framework; local files only' },
      { label: 'basic', value: 'basic', hint: 'diagnostic minimum — errors, denials, lifecycle' },
    ], { summary: (v) => v });
    process.stdout.write(dim('  telemetry is stored ONLY on this computer (memory/telemetry/, one file per day); files are never sent anywhere; no personal data is collected') + '\n');
  }

  // SESSION LANGUAGE — asked ONLY when the deployment declares a choice
  // (defaults.languages.chat = {options[], default}); a flat value (or no deployment)
  // fixes the language and setup never asks — the question set is deployment-authored
  // config, not engine policy. The chosen code compiles into the manifest as the flat
  // defaults.languages.chat every session reads.
  if (!langChoice) {
    if (answers.chatLanguage !== undefined)
      fail('answers: chatLanguage given but the deployment declares no session-language choice (defaults.languages.chat is fixed)');
    cfg.chatLanguage = null;
  } else if (answers.chatLanguage !== undefined) {
    const v = String(answers.chatLanguage);
    if (!langChoice.options.includes(v)) fail(`unknown session language "${v}" (options: ${langChoice.options.join(', ')})`);
    cfg.chatLanguage = v;
    stepNo += 1;
  } else if (!interactive) {
    if (langChoice.def === undefined) need('chatLanguage');
    cfg.chatLanguage = langChoice.def!;
  } else {
    // The declared default (when present) leads the list, so bare-enter picks it.
    const ordered = langChoice.def !== undefined
      ? [langChoice.def, ...langChoice.options.filter((c) => c !== langChoice.def)]
      : langChoice.options;
    cfg.chatLanguage = await tuiSelect(step('Session language (chat with the developer)'), ordered.map((c) => ({
      label: langName(c),
      value: c,
      hint: c === langChoice.def ? `${c} · deployment default` : c,
    })), { summary: (v) => `${langName(v)} (${v})` });
  }

  // Skills — a flat checklist over the whole catalog (framework + the deployment's own
  // payload). The pool is narrowed by capability (`requires: [kaut]` without KAUT) and
  // by the repo lint; flow docs only supply ordering hints.
  const availableSkills = [...cfg.catalog.skills.keys()].sort();
  const kautReq = kautRequired(cfg.catalog);
  const chain = stageChain(cfg.catalog);
  const selectable = availableSkills
    .filter((s) => (cfg.kaut || !kautReq.includes(s)) && !repoExcludedSkills.has(s));
  if (answers.skills !== undefined) {
    let requested: string | string[] = answers.skills === 'all' ? availableSkills : answers.skills;
    if (typeof requested === 'string') requested = requested.split(',').map((s) => s.trim()).filter(Boolean);
    for (const s of requested) if (!availableSkills.includes(s)) fail(`unknown skill "${s}"`);
    if (!cfg.kaut) {
      const dropped = requested.filter((s) => kautReq.includes(s));
      if (dropped.length) warnings.push(`KAUT disabled → skipping KAUT-dependent skills: ${dropped.join(', ')}`);
    }
    cfg.skills = requested.filter((s) => selectable.includes(s));
    stepNo += 1;
  } else if (!interactive) {
    need('skills');
  } else {
    if (!cfg.kaut && kautReq.length)
      process.stdout.write(dim(`  KAUT disabled → not offered: ${kautReq.join(', ')}`) + '\n');
    cfg.skills = await tuiSelect(step('Skills to install'), selectable.map((s) => ({
      label: s,
      value: s,
      hint: chain.includes(s) ? `flow stage ${chain.indexOf(s)}`
        : (cfg.catalog.skills.get(s)!.origin !== 'framework' ? 'project payload' : undefined),
    })), { multi: true, summary: (p) => `${p.length} of ${selectable.length}` });
  }
  // Record the selection INTENT, not just its result: "all" lets `update` auto-install
  // skills a NEWER framework version ships; a custom subset stays
  // fixed and update only advertises what is newly available.
  cfg.skillsSelection = (answers.skills === 'all'
    || (cfg.skills.length === selectable.length && selectable.every((s) => cfg.skills.includes(s))))
    ? 'all' : 'custom';
  cfg.skillsExcluded = []; // populated only by `apply` toggles (all-minus-exclusions)
  for (const s of chain.filter((x) => cfg.skills.includes(x))) {
    const idx = chain.indexOf(s);
    if (idx > 0 && !cfg.skills.includes(chain[idx - 1]))
      warnings.push(`flow chain gap: "${s}" installed without its predecessor "${chain[idx - 1]}"`);
  }

  // MCP servers.
  if (answers.mcp !== undefined) {
    let mcp: string | string[] = answers.mcp === 'all' ? Object.keys(MCP_CATALOG) : answers.mcp;
    if (typeof mcp === 'string') mcp = mcp.split(',').map((s) => s.trim()).filter(Boolean);
    for (const m of mcp) if (!MCP_CATALOG[m]) fail(`unknown MCP server "${m}"`);
    cfg.mcp = mcp;
  } else if (!interactive) {
    need('mcp');
  } else {
    cfg.mcp = await tuiSelect(step('MCP servers to install'), Object.entries(MCP_CATALOG).map(([id, c]) => ({
      label: id,
      value: id,
      hint: `${c.role} · ${c.package}@${c.pin}`,
    })), { multi: true, allowEmpty: true, summary: (p) => (p.length ? p.join(', ') : 'none') });
  }

  cfg.warnings = warnings;
  return cfg;
}

// ---------------------------------------------------------------- repair reconstruction

export async function cfgFromWorkspace(ws: string): Promise<Cfg> {
  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  // Legacy fallback: until its first recompile migrates the layout, a pre-rename
  // workspace keeps the machine binding at .federation/local.json.
  const localRaw = await readIfExists(path.join(ws, '.taut', 'local.json'), 1024 * 1024)
    ?? await readIfExists(path.join(ws, '.federation', 'local.json'), 1024 * 1024);
  if (localRaw === null) fail(`no .taut/local.json in ${ws} — the workspace has no machine binding (re-run setup)`);
  const local = JSON.parse(localRaw);
  const warnings: string[] = [];
  const repos: Repo[] = [];
  for (const [name, p] of Object.entries<string>(local.repoPaths ?? {})) {
    if (await exists(p)) repos.push({ name, path: p });
    else warnings.push(`repo path missing on this machine (kept out of the rebuild): ${name} → ${p}`);
  }
  // Pre-flat-model manifests recorded flow PACKAGES; the flat model has none — the artifact
  // catalog + the skills list carry everything (flow docs re-derive from the sequences).
  if (manifest.flows) warnings.push('manifest key "flows" is obsolete (flat artifact model) — dropped on this rebuild');
  // The manifest is the source of truth: repair reconstructs the config-equivalent from
  // it generically (all non-compiler-owned keys become the `manifest` bag), so a rebuild
  // needs neither the answers file nor the deployments/ config. The deployment DIR (when
  // this framework still ships it) is re-attached only to resolve project skills and
  // runbooks.
  const extra = Object.fromEntries(Object.entries(manifest).filter(([k]) => !OWNED_MANIFEST_KEYS.has(k)));
  const real = manifest.deployment ? (await listDeployments()).find((d) => d.name === manifest.deployment) : null;
  const profile: Profile | null = manifest.deployment ? {
    name: manifest.deployment,
    description: manifest.description,
    dir: real?.dir ?? null,
    repos: {
      mandatory: (manifest.repos ?? []).filter((r: any) => r.mandatory).map((r: any) => r.name),
      // The repo map doubles as the LINT DOMAIN (unknown repo = compile error), so it
      // must span the deployment's FULL known map, not just the repos connected HERE —
      // the pack legitimately ships runbook bindings and descriptor folders for repos
      // this workspace did not connect (they are excluded/skipped, exactly as in setup).
      // VALUES for connected repos stay manifest-derived (spread last — repair fidelity;
      // the live config's values enter only via update --from-deployment).
      known: {
        ...(real?.repos?.known ?? {}),
        ...Object.fromEntries((manifest.repos ?? []).map((r: any) => [r.name, {
          role: r.role, ...(r.guards ? { guards: r.guards } : {}),
          // Declared stack only (the resolved `stacks` outcome is recomputed each
          // compile — detection must not become sticky through a rebuild).
          ...(r.stack !== undefined ? { stack: r.stack } : {}),
        }])),
      },
    },
    manifest: { ...extra, flow: (({ stages, ...rest }) => rest)(manifest.flow ?? {}) },
  } : null;
  initProject(profile?.dir);
  const catalog = await loadCatalog(profile);

  // Same repo-map lint as setup, against the repos actually present on THIS machine —
  // a rebuild degrades honestly (excluded + warned) instead of shipping artifacts bound
  // to repos it cannot reach.
  const cfg: Cfg = {
    workspace: ws,
    profile,
    catalog,
    harnesses: normalizeHarnesses(manifest.harnesses ?? manifest.harness), // scalar = legacy manifest
    // Rename normalization (Atlas → KAUT): a pre-rename manifest/local.json carries the
    // legacy keys until its first recompile migrates them — folded in here, at the load.
    kaut: Boolean(manifest.kaut?.enabled ?? manifest.atlas?.enabled),
    kautRoot: local.kautRoot ?? local.atlasRoot ?? null, // machine binding; legacy workspaces have none
    mode: manifest.mode ?? 'normal',
    // Pre-telemetry manifests have no key — they adopt the default (extended); the
    // surfaced migration note lives in compileWorkspace, next to the old lock.
    telemetry: manifest.telemetry?.level === 'basic' ? 'basic' : 'extended',
    // The manifest carries the RESOLVED flat language; it counts as a live choice only
    // when the real deployment (still) declares one — a pack with a fixed language (or
    // an unreachable pack) reconstructs as null and the flat value passes through as-is.
    chatLanguage: chatChoice(real?.manifest) && typeof manifest.defaults?.languages?.chat === 'string'
      ? manifest.defaults.languages.chat : null,
    skills: manifest.skills,
    skillsSelection: manifest.skillsSelection ?? 'custom',
    skillsExcluded: manifest.skillsExcluded ?? [],
    mcp: Object.values<any>(manifest.mcp ?? {}).map((m) => m.id),
    repos,
    warnings,
  };
  relintRepoBindings(cfg);
  return cfg;
}
