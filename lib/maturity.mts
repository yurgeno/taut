// TAUT compiler — artifact MATURITY. A pack marks a skill (`metadata.taut.maturity`) or
// a flow doc (frontmatter `maturity`) as `draft`: shipped and runnable, but NOT approved
// for production use — whoever runs it does so at their own risk. The flag is DATA the
// compiler makes visible on every surface it owns, never a gate that blocks: the banner
// below rides in the compiled skill body (the harness-neutral channel — the model prints
// the notice first), the manifest carries `skillsDraft` + `flowDocs[].maturity`, the lock
// carries `draft` (the gate's trust root: a user-facing notice on every invocation), and
// CLAUDE.md / AGENTS.md, `status`, `check` and the panel all mark the artifact. Absent =
// stable; any other value fails the compile (lint) rather than shipping an unknown state.
import { fail } from './util.mts';

export const MATURITY_VALUES = ['draft'] as const;
export type Maturity = typeof MATURITY_VALUES[number];

export function parseMaturity(value: unknown, id: string): Maturity | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (MATURITY_VALUES as readonly string[]).includes(value)) return value as Maturity;
  return fail(`${id}: maturity must be one of ${MATURITY_VALUES.join(', ')} (or absent = stable), got ${JSON.stringify(value)}`);
}

// The one-line notice a draft skill prints to the user before anything else — the same
// wording the gate emits as a system message, so a reader sees one message, not two kinds.
export const draftNotice = (name: string): string =>
  `⚠ ${name} is a DRAFT skill — not yet approved for production use; you run it at your own risk.`;

// The banner the compiler inserts right after the frontmatter of a draft skill. Fixed
// text, deterministic by construction: `verify --source` re-derives it from the lock row
// (`transform: 'gates+draft'`) exactly as install produced it.
export function draftBanner(name: string): string {
  return [
    '> **DRAFT — not approved for production use.** This skill is still under evaluation;',
    '> whoever runs it does so at their own risk. FIRST, before any other output or tool',
    `> call, print this line to the user verbatim: \`${draftNotice(name)}\``,
    '> Then continue with the skill as written below.',
  ].join('\n');
}

// Insert the banner between the frontmatter and the body. Same frontmatter convention as
// parseFrontmatter (lib/artifacts.mts): `---` on the first line, closed by the next line
// that is exactly `---`. The frontmatter stays byte-identical, so every reader (harness
// loader, lock, SAUT) sees the same wiring it would without the flag.
export function withDraftBanner(text: string, name: string): string {
  if (!text.startsWith('---\n')) return fail(`${name}: a draft skill needs YAML frontmatter to carry the banner`);
  const lines = text.split('\n');
  const close = lines.indexOf('---', 1);
  if (close === -1) return fail(`${name}: unclosed frontmatter`);
  return [...lines.slice(0, close + 1), '', draftBanner(name), ...lines.slice(close + 1)].join('\n');
}
