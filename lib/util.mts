// TAUT compiler — small shared utilities: hashing, fs probes, git info, process
// exit, and the ANSI styling helpers used by every output path (TTY/NO_COLOR-safe).
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import type { ExecSyncOptionsWithStringEncoding } from 'node:child_process';

export const sha256 = (buf: string | Buffer): string => createHash('sha256').update(buf).digest('hex');

export async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function readIfExists(p: string, limit = 128 * 1024): Promise<string | null> {
  try {
    const buf = await fs.readFile(p);
    return buf.subarray(0, limit).toString('utf8');
  } catch { return null; }
}

export function gitInfo(dir: string): { commit: string | null; dirty: boolean | null } {
  const opts: ExecSyncOptionsWithStringEncoding = { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    const commit = execSync('git rev-parse HEAD', opts).trim();
    const dirty = execSync('git status --porcelain', opts).trim().length > 0;
    return { commit, dirty };
  } catch { return { commit: null, dirty: null }; }
}

// gitInfo for a dir that must ITSELF be the repo toplevel: a plain folder nested inside
// some OTHER repo must not inherit that repo's commit (git walks up parents) — a data
// pack pinned with a foreign commit would be a lie.
export function gitInfoOwn(dir: string): { commit: string | null; dirty: boolean | null } {
  const opts: ExecSyncOptionsWithStringEncoding = { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    const top = execSync('git rev-parse --show-toplevel', opts).trim();
    if (path.resolve(top) !== path.resolve(dir)) return { commit: null, dirty: null };
  } catch { return { commit: null, dirty: null }; }
  return gitInfo(dir);
}

// Domain failures THROW: the CLI entry catches TautError, prints
// `taut: <msg>` to stderr and exits 1 — byte-identical UX to the old
// print-and-exit fail(); long-lived callers (the panel server) catch it per-request
// instead of dying. Never catch it blanket-style inside lib/ — let it propagate.
export class TautError extends Error {}

// Return type `never` so `x ?? fail(...)` narrows x for the checker — runtime unchanged.
export function fail(msg: string): never {
  throw new TautError(msg);
}

export function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(process.env.HOME ?? '', p.slice(2)) : p;
}

// A lock/manifest is an ordinary workspace file the integrity gate cannot itself vouch
// for, so every value read from one is untrusted. Two guards close the paths where such
// a value would escalate from "fooled a hash check" to code execution or data loss:

// A git commit is always lowercase hex — reject anything else before it reaches a git
// command line (an interpolated `<pin>..HEAD` range must never carry shell metacharacters
// or git option-injection). A non-matching pin is treated as unknown, never executed.
export const isCommit = (s: string): boolean => /^[0-9a-f]{7,40}$/.test(s);

// Resolve an artifact id under a base dir and confirm it stays inside — a lock id like
// `.claude/skills/../../../etc/x` must never let a sweep rm or a read escape the
// workspace. Returns the absolute path when contained, null otherwise.
export function safeJoin(base: string, rel: string): string | null {
  const abs = path.resolve(base, rel);
  return abs === base || abs.startsWith(base + path.sep) ? abs : null;
}

// ---------------------------------------------------------------- styling

const TTY = process.stdout.isTTY === true && !process.env.NO_COLOR;
const sty = (code: string) => (s: unknown): string => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const dim = sty('2');
export const bold = sty('1');
export const cyan = sty('36');
export const green = sty('32');
export const yellow = sty('33');
export const red = sty('31');
