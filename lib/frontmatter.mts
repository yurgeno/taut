// Frontmatter EMITTER — the inverse of the parser in artifacts.mts. Produces exactly the
// strict subset that parser accepts (2-space nesting, one line per value, inline lists
// without quoted items; no empty maps — the parser reads `{}` as a string), so anything a tool assembles from
// form fields is guaranteed to compile. Round-trip law (tested): parse(emit(x)) deep-equals x
// for every value shape the parser can represent.
//
// Values the subset cannot carry are REFUSED, never silently mangled: a string list item
// containing a comma or a quote (the parser forbids quoted inline items and a block list
// is the caller's choice), multi-line strings (no continuation lines in the subset), nested
// arrays, non-string list items inside maps of lists.
import { parseFrontmatter } from './artifacts.mts';

export class FrontmatterEmitError extends Error {}

function quote(s: string): string {
  // bare when it reads back as the same string; otherwise single-quoted (parser: '' escape)
  const bare = s !== '' && s.trim() === s && !/^['"\[{#&*!|>%@`]/.test(s) && !/: |\t|\r|\n/.test(s)
    && !/^(true|false|null|~)$/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) && !s.endsWith(':');
  return bare ? s : `'${s.replaceAll("'", "''")}'`;
}

function emitValue(key: string, v: unknown, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  if (v === null || v === undefined) throw new FrontmatterEmitError(`${key}: null/undefined is not representable — omit the key`);
  if (typeof v === 'boolean') { out.push(`${pad}${key}: ${v}`); return; }
  if (typeof v === 'number') { out.push(`${pad}${key}: ${v}`); return; }
  if (typeof v === 'string') {
    if (/\r?\n/.test(v)) throw new FrontmatterEmitError(`${key}: multi-line strings are not representable (no continuation lines in the subset) — fold to one line`);
    out.push(`${pad}${key}: ${quote(v)}`);
    return;
  }
  if (Array.isArray(v)) {
    if (!v.every((x) => typeof x === 'string')) throw new FrontmatterEmitError(`${key}: only string lists are representable`);
    const items = v as string[];
    if (items.some((x) => /[,'"\[\]\r\n]/.test(x) || x.trim() !== x || x === ''))
      throw new FrontmatterEmitError(`${key}: a list item contains a comma, a quote, brackets or edge whitespace — not representable in an inline list`);
    out.push(`${pad}${key}: [${items.join(', ')}]`);
    return;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (!entries.length) throw new FrontmatterEmitError(`${key}: an empty map is not representable (the parser reads \`{}\` as a string) — omit the key`);
    out.push(`${pad}${key}:`);
    for (const [k, x] of entries) {
      if (!/^[A-Za-z0-9_-]+$/.test(k)) throw new FrontmatterEmitError(`key "${k}" is not representable (letters, digits, _ and - only)`);
      emitValue(k, x, indent + 2, out);
    }
    return;
  }
  throw new FrontmatterEmitError(`${key}: unsupported value type ${typeof v}`);
}

export function emitFrontmatter(data: Record<string, unknown>): string {
  const out: string[] = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(k)) throw new FrontmatterEmitError(`key "${k}" is not representable (letters, digits, _ and - only)`);
    emitValue(k, v, 0, out);
  }
  out.push('---');
  const text = out.join('\n') + '\n';
  // self-check: the parser must read back exactly what was asked for
  const back = parseFrontmatter(text, 'emit').fm;
  const norm = (x: unknown) => JSON.stringify(x);
  if (norm(back) !== norm(Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined))))
    throw new FrontmatterEmitError(`round-trip mismatch — emitted:\n${text}\nread back: ${norm(back)}`);
  return text;
}
