// Shared test helpers. Run the suites with bare `node --test` from the repo root.
// node --test executes suite FILES in parallel child processes — suite() gives each
// file its own tmp sandbox (.test-tmp-<name>) so fixtures never collide.
//
// Core/data split: the suites never touch real content — each suite materializes the
// GENERIC fixture pack (test/fixtures/pack: the fx-* shared layer + the full-surface
// fxdep project) into its sandbox as a git repo and exports it via TAUT_DATA, so every
// spawned CLI and every in-process call resolves it. The user-facing example pack
// (taut-data/ = the react-demo project) is exercised by its own end-to-end test. The
// core must stay fully self-testable without any private data pack present.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const run = promisify(execFile);
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// FW/CLI are LET on purpose: ensureFrameworkHistory may re-point them at a throwaway
// clone (see below). ESM live bindings carry the new value to every importing suite.
export let FW = REPO;
export let CLI = path.join(REPO, 'taut.mjs');
export const FIXTURE_PACK = path.join(REPO, 'test', 'fixtures', 'pack');
export const exists = (p) => fs.access(p).then(() => true, () => false);

const git = (dir, args) => run('git', ['-C', dir, '-c', 'user.email=fx@test', '-c', 'user.name=fx',
  '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args]);

// Turn a directory into a committed git repo (the data pack must carry a commit so the
// dual pin — lock.data — is exercised for real).
export async function commitAll(dir, msg = 'pack') {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-qm', msg]);
}

// Staleness/update suites fabricate an "old pin" from the framework's own `HEAD~1`, so
// they need a checkout with at least two commits. A release snapshot (a single orphan
// commit) and any `--depth 1` clone have none — the suite must still be runnable there,
// so it re-points FW/CLI at a throwaway clone carrying one synthetic commit. A normal dev
// checkout is used as-is. Call from a suite's before(), after reset().
export async function ensureFrameworkHistory(TMP) {
  try { await run('git', ['-C', REPO, 'rev-parse', 'HEAD~1']); return; }
  catch { /* single-commit checkout — build the history this suite needs */ }
  const clone = path.join(TMP, 'fw-history');
  await fs.mkdir(TMP, { recursive: true });
  await run('git', ['clone', '--quiet', '--no-hardlinks', REPO, clone]);
  await fs.appendFile(path.join(clone, 'README.md'), '\n<!-- test sandbox: synthetic commit -->\n');
  await git(clone, ['commit', '-qam', 'test: synthetic head so the staleness paths stay testable']);
  FW = clone;
  CLI = path.join(clone, 'taut.mjs');
}

export function runGate(ws, event, inputObj, extraArgs = []) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [path.join(ws, '.taut', 'gate.mjs'), event, ...extraArgs],
      { env: { ...process.env, CLAUDE_PROJECT_DIR: ws } },
      (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }));
    child.stdin.end(JSON.stringify(inputObj ?? {}));
  });
}

export function suite(name) {
  const TMP = path.join(FW, `.test-tmp-${name}`);
  const PACK = path.join(TMP, 'pack');
  const reset = () => fs.rm(TMP, { recursive: true, force: true });

  // Copy `from` to `dest`, git-init + commit, and (for the suite default) export it as
  // TAUT_DATA so every child CLI process inherits it.
  async function makePack(dest = PACK, from = FIXTURE_PACK) {
    await fs.cp(from, dest, { recursive: true });
    await git(dest, ['init', '-q']);
    await commitAll(dest);
    if (dest === PACK) process.env.TAUT_DATA = PACK;
    return dest;
  }

  async function makeRepo(rname, files = {}) {
    const dir = path.join(TMP, 'repos', rname);
    await fs.mkdir(path.join(dir, '.git'), { recursive: true });
    for (const [rel, content] of Object.entries(files)) await fs.writeFile(path.join(dir, rel), content);
    return dir;
  }

  async function setup(wsName, answers) {
    const ws = path.join(TMP, 'ws', wsName);
    const answersFile = path.join(TMP, `${wsName}.answers.json`);
    await fs.mkdir(TMP, { recursive: true });
    // deployment: 'none' = the explicit service escape; tests opt into a config per case.
    await fs.writeFile(answersFile, JSON.stringify({ deployment: 'none', ...answers, workspace: ws }));
    const { stdout } = await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']);
    return { ws, stdout };
  }

  return { TMP, PACK, reset, makePack, makeRepo, setup, commitAll };
}
