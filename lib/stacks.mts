// TAUT compiler — repo STACK resolution: the scan half of base-skill specialization.
// Base (pack-authored) skills carry per-toolchain branches in capability markers
// (`stack-<key>:on … :end`); the compiler keeps exactly the branches whose stacks the
// CONNECTED repos actually use. Resolution per repo, record-beats-guess:
//   1. the deployment's own declaration — repos.known[<name>].stack (string | string[])
//   2. otherwise DETECTION: deterministic file probes at the repo root (no agent, no
//      guessing beyond well-known toolchain marker files)
// The resolved outcome is recorded in the manifest (per-repo rows) and the lock
// (`stacks: [...]` — verify --source rebuilds the gates from it); detection re-runs on
// every compile, so a repo gaining a toolchain is picked up by the next update.
// Stack keys are an OPEN vocabulary: a pack may gate on stacks this table cannot
// detect — declare them in the deployment; unknown `stack-*` branches compile out.
import path from 'node:path';

import { exists, fail } from './util.mts';
import type { Cfg } from './types.mts';

// Toolchain-grained (not language-grained) on purpose: the practical knowledge a
// branch carries is toolchain-shaped (npm/nx vs gradle/maven vs composer); language
// nuance lives inside the branch text and in the repo descriptor.
const PROBES: [string, string[]][] = [
  ['node', ['package.json']],
  ['jvm', ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']],
  ['php', ['composer.json']],
  ['python', ['pyproject.toml', 'requirements.txt', 'setup.py']],
  ['go', ['go.mod']],
  ['rust', ['Cargo.toml']],
];

// Same shape the marker keys allow after the `stack-` prefix.
const STACK_NAME = /^[a-z][a-z0-9-]*$/;

export function normalizeStackList(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  const list = (Array.isArray(v) ? v : [v]).map((s) => String(s).trim()).filter(Boolean);
  for (const s of list)
    if (!STACK_NAME.test(s)) fail(`${where}: invalid stack name "${s}" (expected ${STACK_NAME})`);
  return [...new Set(list)].sort();
}

export async function detectStacks(repoPath: string): Promise<string[]> {
  const out: string[] = [];
  for (const [stack, files] of PROBES)
    for (const f of files)
      if (await exists(path.join(repoPath, f))) { out.push(stack); break; }
  return out;
}

// Per-repo resolution over the CONNECTED set; also flattens the workspace union onto
// cfg (cfg.repoStacks / cfg.stacks) for the gates, the manifest and the lock.
export async function resolveRepoStacks(cfg: Cfg): Promise<void> {
  const perRepo: Record<string, string[]> = {};
  for (const r of cfg.repos) {
    const declared = normalizeStackList(cfg.profile?.repos?.known?.[r.name]?.stack,
      `deployment "${cfg.profile?.name}": repos.known.${r.name}.stack`);
    perRepo[r.name] = declared.length ? declared : await detectStacks(r.path);
  }
  cfg.repoStacks = perRepo;
  cfg.stacks = [...new Set(Object.values(perRepo).flat())].sort();
}
