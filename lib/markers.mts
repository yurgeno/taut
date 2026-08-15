// TAUT compiler — conditional-compilation pass over artifact SOURCES (the first,
// minimal slice of the capability mapping). Sources are written once with capability
// branches inline; the compiler keeps exactly one branch per gate, so a compiled artifact
// never instructs (or allowlists) a capability the workspace does not have.
//
// Markers (each alone on its line), parameterized by a capability KEY:
//   <!-- <key>:on -->  / # <key>:on    lines kept when the gate is ON
//   <!-- <key>:off --> / # <key>:off   lines kept when the gate is OFF (optional branch)
//   <!-- <key>:end --> / # <key>:end   closes the block
// The HTML form keeps markdown BODIES valid; the '#' form works inside YAML frontmatter
// (duplicate-key variants never reach a YAML parser — sources are only consumed through
// this pass). Known keys today: `atlas` (Atlas integration), `mcp-docs` (a docs-role MCP
// server is installed) — the gate values come from the setup config / the lock.
// Marker lines never ship; no nesting. Malformed or unknown-key markers throw — the
// compile fails rather than shipping a half-gated artifact (lint).
const MARKER = /^(?:<!-- ([a-z][a-z0-9-]*):(on|off|end) -->|# ([a-z][a-z0-9-]*):(on|off|end))$/;

export function applyMarkers(text: string, gates: Record<string, boolean>, id = 'artifact'): string {
  const out: string[] = [];
  let key: string | null = null;   // capability of the open block, or null
  let branch: 'on' | 'off' | null = null; // while a block is open
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER.exec(lines[i].trim());
    if (m) {
      const k = m[1] ?? m[3];
      const verb = m[2] ?? m[4];
      if (!(k in gates)) throw new Error(`${id}:${i + 1}: unknown capability "${k}" (gates: ${Object.keys(gates).join(', ')})`);
      if (verb === 'on') {
        if (key !== null) throw new Error(`${id}:${i + 1}: nested ${k}:on inside ${key} block`);
        key = k; branch = 'on';
      } else if (verb === 'off') {
        if (key !== k || branch !== 'on') throw new Error(`${id}:${i + 1}: ${k}:off without a preceding ${k}:on`);
        branch = 'off';
      } else {
        if (key !== k) throw new Error(`${id}:${i + 1}: ${k}:end without an open ${k} block`);
        key = null; branch = null;
      }
      continue;
    }
    if (key !== null && branch === 'on' && !gates[key]) continue;
    if (key !== null && branch === 'off' && gates[key]) continue;
    out.push(lines[i]);
  }
  if (key !== null) throw new Error(`${id}: unclosed ${key} block`);
  return out.join('\n');
}
