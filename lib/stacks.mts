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
import fs from 'node:fs/promises';
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
  // Every common Python manifest / lock file: PEP 621 / Poetry / PDM / uv / Hatch
  // (pyproject), pip (requirements), setuptools (setup.py/setup.cfg), Pipenv, Conda,
  // and the uv / poetry / pdm locks. Variant requirements files and plain-script repos
  // are handled by `pythonExtras` below.
  ['python', ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile', 'Pipfile.lock',
    'environment.yml', 'uv.lock', 'poetry.lock', 'pdm.lock']],
  ['go', ['go.mod']],
  ['rust', ['Cargo.toml']],
];

const REQUIREMENTS_VARIANT = /^requirements[\w.-]*\.txt$/;
const PY_SCRIPT_DIRS = ['scripts', 'bin'];

async function names(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch(() => [] as string[]);
}

// Python beyond exact file names: `requirements-<x>.txt` and `requirements/*.txt`
// (pip layouts), and a plain-script repository — `*.py` at the root or under
// `scripts/` / `bin/` with no manifest at all. Directory listings, no content reads.
async function pythonExtras(repoPath: string): Promise<boolean> {
  const root = await names(repoPath);
  if (root.some((n) => REQUIREMENTS_VARIANT.test(n) || n.endsWith('.py'))) return true;
  if ((await names(path.join(repoPath, 'requirements'))).some((n) => n.endsWith('.txt'))) return true;
  for (const d of PY_SCRIPT_DIRS)
    if ((await names(path.join(repoPath, d))).some((n) => n.endsWith('.py'))) return true;
  return false;
}

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
  const found = new Set<string>();
  for (const [stack, files] of PROBES)
    for (const f of files)
      if (await exists(path.join(repoPath, f))) { found.add(stack); break; }
  if (!found.has('python') && await pythonExtras(repoPath)) found.add('python');
  return PROBES.map(([stack]) => stack).filter((s) => found.has(s)); // table order, deterministic
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
