// TAUT compiler — the generated workspace manifest: per-harness model-tier
// resolution and buildManifest — the single producer of manifest.json. The manifest is
// the workspace's own usage index over the flat artifact model: skills, derived agents,
// MCP roles with usage, the runbooks index, flow docs with their installed stages, laws.
// The generated manifest is `Record<string, any>` by design: the deployment `manifest`
// bag passes through VERBATIM, so its full shape is deployment-authored, not compiler-owned.
import path from 'node:path';

import { MCP_CATALOG, OWNED_MANIFEST_KEYS } from './constants.mts';
import { fail } from './util.mts';
import { neededAgents, stageChain } from './artifacts.mts';
import type { Cfg, FlowDocEntry } from './types.mts';

// The SESSION rung of the model profile (modelTiers.sessionTier): the tier the
// ORCHESTRATOR session itself runs on — rendered into each harness's own config surface
// (.claude/settings.json model/effortLevel, .codex/config.toml model/effort) and pinned
// in the lock for the gate's session-start advisory. Absent = no session policy (nothing
// rendered — pre-profile behavior). An unknown tier is a config bug: fail the compile
// rather than silently un-pinning the session.
// Effort of a rung for a harness. Handles BOTH shapes: the authored per-harness map,
// and the flat STRING a single-harness compile writes into the workspace manifest
// (resolveModelTiers replaces the map — on repair the string IS the mono harness's
// value, so it applies to whichever single harness asks).
export const rungEffort = (rung: any, harness: string): string | undefined =>
  rung?.reasoningEffort?.[harness]
    ?? (typeof rung?.reasoningEffort === 'string' ? rung.reasoningEffort : undefined);

export function sessionRung(cfg: Cfg): any | null {
  const mt = cfg.profile?.manifest?.modelTiers;
  if (!mt?.sessionTier) return null;
  const rung = (mt.ladder ?? []).find((r: any) => r.tier === mt.sessionTier);
  if (!rung) fail(`modelTiers.sessionTier "${mt.sessionTier}" names no ladder rung (tiers: ${(mt.ladder ?? []).map((r: any) => r.tier).join(', ') || 'none'})`);
  return rung;
}

// Documented special-case of the verbatim pass-through: modelTiers.ladder rungs may carry
// per-harness values — models{<harness>} / reasoningEffort{<harness>} — resolved to flat
// model / reasoningEffort for the CHOSEN harness. The maps are kept in the manifest so
// repair re-renders identically and the agent-pin mapping keeps working.
export function resolveModelTiers(mt: any, harness: string): any {
  return {
    ...mt,
    ladder: mt.ladder.map((rung: any) => {
      const model = rung.models?.[harness] ?? rung.model;
      const effort = rung.reasoningEffort?.[harness]
        ?? (typeof rung.reasoningEffort === 'string' ? rung.reasoningEffort : undefined);
      return { ...rung, ...(model ? { model } : {}), ...(effort ? { reasoningEffort: effort } : {}) };
    }),
  };
}

// Session-language choice declared by a deployment: defaults.languages.chat may be
// {options[], default?} instead of a flat language code — setup asks EXACTLY when the
// choice is declared (a flat value never asks; the question itself is deployment-
// authored config, not engine policy). Returns the parsed declaration, or null when the
// value is flat/absent; a malformed declaration fails the compile.
export function chatChoice(profileManifest: Record<string, any> | undefined | null): { options: string[]; def?: string } | null {
  const chat = profileManifest?.defaults?.languages?.chat;
  if (chat === undefined || typeof chat === 'string') return null;
  if (typeof chat !== 'object' || chat === null || Array.isArray(chat))
    fail('defaults.languages.chat must be a language code or {options[], default}');
  const options = Array.isArray(chat.options) ? chat.options.map(String) : [];
  if (!options.length) fail('defaults.languages.chat: choice declares no options[]');
  const def = chat.default !== undefined ? String(chat.default) : undefined;
  if (def !== undefined && !options.includes(def))
    fail(`defaults.languages.chat: default "${def}" is not one of the options (${options.join(', ')})`);
  return { options, def };
}

// Flow docs whose sequence touches at least one INSTALLED skill ship with the workspace —
// a flow is documentation of a launch order, so it follows the skills, never the reverse.
export function installedFlowDocs(cfg: Cfg): FlowDocEntry[] {
  return cfg.catalog.flowDocs.filter((f) => f.sequence.some((s) => cfg.skills.includes(s)));
}

export function buildManifest(cfg: Cfg): Record<string, any> {
  // Shared manifest: canonical, machine-independent, secret-free. Paths live in local
  // binding. With a deployment profile the manifest is generated AS FULLY AS the profile
  // allows: flow.tracker/branch/scm, defaults, tiers, stacks, launcher,
  // per-repo roles/guards — everything the payload consumes at run time.
  const prof = cfg.profile ?? null;
  const known = prof?.repos?.known ?? {};
  const mandatorySet = new Set(prof?.repos?.mandatory ?? []);
  // Generic pass-through: everything under the config's `manifest` bag lands in the
  // generated manifest verbatim, except compiler-owned keys; flow.* merges around the
  // computed stages. This is what makes the config structure universal per project.
  const extra: Record<string, any> = { ...(prof?.manifest ?? {}) };
  const profFlow = extra.flow ?? {};
  for (const k of OWNED_MANIFEST_KEYS) delete extra[k];
  // Flat model/effort resolution happens only for a SINGLE-harness workspace: with two
  // harnesses enabled a flat value for one would mislead the other's sessions — the
  // per-harness maps (always kept) stay the authority there.
  if (extra.modelTiers?.ladder && cfg.harnesses.length === 1)
    extra.modelTiers = resolveModelTiers(extra.modelTiers, cfg.harnesses[0]);
  // Session-language resolution (a documented special-case of the verbatim pass-through,
  // like modelTiers): a {options, default} declaration compiles to the FLAT chosen code —
  // the workspace manifest always carries the resolved value, so laws and skills read one
  // string and repair re-renders identically. cfg.chatLanguage (setup answer / apply
  // --chat-language / the previous manifest value) wins; the declared default covers the
  // rest; a choice that resolves to nothing is a config error, never a silent pick.
  const choice = chatChoice(extra);
  if (choice) {
    let chosen = cfg.chatLanguage ?? choice.def;
    if (chosen === undefined)
      fail('defaults.languages.chat: no language chosen and the deployment declares no default — re-run setup or pass --chat-language');
    if (!choice.options.includes(chosen)) {
      const to = choice.def ?? choice.options[0];
      const w = `session language "${chosen}" is no longer offered by the deployment (options: ${choice.options.join(', ')}) — falling back to "${to}"`;
      if (!cfg.warnings.includes(w)) cfg.warnings.push(w);
      chosen = to;
    }
    extra.defaults = { ...extra.defaults, languages: { ...extra.defaults.languages, chat: chosen } };
  } else if (cfg.chatLanguage != null && typeof extra.defaults?.languages?.chat === 'string'
      && extra.defaults.languages.chat !== cfg.chatLanguage) {
    // apply --chat-language on an existing workspace: the manifest bag read back from the
    // workspace carries the previously resolved flat value — replace it with the new choice.
    extra.defaults = { ...extra.defaults, languages: { ...extra.defaults.languages, chat: cfg.chatLanguage } };
  }
  const chain = stageChain(cfg.catalog);
  return {
    name: prof?.name ?? path.basename(cfg.workspace),
    framework: 'taut',
    deployment: prof?.name,
    description: prof?.description,
    harnesses: cfg.harnesses,
    atlas: { enabled: cfg.atlas },
    mode: cfg.mode ?? 'normal',
    // Usage-telemetry level (an ENGINE-owned setup choice; default extended). Local-only
    // by law: daily files under memory/telemetry/, never sent anywhere, no personal data.
    telemetry: { level: cfg.telemetry === 'basic' ? 'basic' : 'extended', localOnly: true },
    // The config's flow VALUES merge around the engine-computed `stages` — stages spread
    // LAST, so a pack authoring `flow.stages` itself cannot override the real installed
    // chain (it is derived from the flow docs × the installed skills, never declared).
    flow: { ...profFlow, stages: chain.filter((s) => cfg.skills.includes(s)) },
    flowDocs: installedFlowDocs(cfg).map((f) => ({
      name: f.name,
      description: f.description,
      doc: `.taut/docs/FLOW-${f.name}.md`,
      stages: f.sequence.filter((s) => cfg.skills.includes(s)),
    })),
    skills: cfg.skills,
    skillsSelection: cfg.skillsSelection ?? 'custom',
    // "all minus exclusions" (apply toggles): an excluded skill never installs, but the
    // "all" selection keeps following new framework versions for everything else.
    skillsExcluded: cfg.skillsExcluded ?? [],
    agents: neededAgents(cfg.skills, cfg.catalog),
    mcp: Object.fromEntries(cfg.mcp.map((id) => {
      const c = MCP_CATALOG[id];
      return [c.role, { id, serverKey: c.serverKey, package: c.package, env: c.env }];
    })),
    runbooks: (cfg.runbooks ?? []).map((r) => ({
      name: r.name,
      description: r.description,
      ...(r.repos?.length ? { repos: r.repos } : {}),
      path: `.taut/runbooks/${r.name}.md`,
    })),
    // Repo descriptors index: repo → installed workspace-relative files.
    // Agents look a repo up here BEFORE working in it; only connected repos appear.
    repoDocs: Object.fromEntries(
      [...cfg.catalog.repoDocs]
        .filter(([n]) => cfg.repos.some((r) => r.name === n))
        .map(([n, files]) => [n, files.map((f: { file: string }) => `.taut/repos/${n}/${f.file}`)]),
    ),
    repos: cfg.repos.map((r) => ({
      name: r.name,
      role: known[r.name]?.role ?? 'member',
      ...(known[r.name]?.guards ? { guards: known[r.name].guards } : {}),
      ...(mandatorySet.has(r.name) ? { mandatory: true } : {}),
      git: 'read-only',
    })),
    ...extra,
    laws: {
      // Workspace-relative pointer to the SHIPPED law text — the laws are a CORE document
      // of the distribution model (no flow owns them), present in every workspace;
      // the workspace is self-contained, no path may reference the framework clone.
      ...(cfg.catalog.laws ? { text: '.taut/LAWS.md' } : {}),
      memberRepoGit: 'read-only for agents; work product = working-tree edits + patch artifacts',
      sql: 'no SQL execution anywhere, by any tool',
      tracker: 'read-only',
      memberRepoInstructionFiles: 'never modified by TAUT; contextual precedence — workspace-launched tasks follow workspace laws, repo-launched tasks follow the repo',
    },
  };
}
