---
name: implement
description: 'Stage 2 of the react flow: implement the analyzed task in react-app as working-tree edits, verify on the dev server when needed, write the change note.'
allowed-tools: [Read, Glob, Grep, Bash, Edit, Write, Agent]
metadata:
  taut:
    agents: [implementer]
    repos: [react-app]
    mcp: [docs]
---

# implement — make the change (stage 2)

Input: `memory/spec/<TASK>/_analysis.md` with verdict `ready-to-implement`. If the note
is missing or blocked, stop and say which stage owes it — do not re-analyze inline.

1. Re-read the analysis and the repo descriptor (`.taut/repos/react-app/`).
2. Delegate the coding to the **implementer** subagent, pointing it at the analysis
   note and the descriptor. The change lands as WORKING-TREE EDITS in react-app —
   per the laws, agents never commit; the human reviews and commits.
3. Verify at the cheapest sufficient tier: unit tests (`npm test`) on the `static` tier;
   climb to `dev-server` (recipe: `.taut/runbooks/dev-server.md`) only when the change
   is visual or interactive.
4. Write `memory/spec/<TASK>/_changes.md`: what changed and why, file list, how it was
   verified (commands actually run + outcomes), anything deliberately left out.
5. Stop at the owner gate; the owner launches `/review`.

<!-- mcp-docs:on -->
For any library/framework API doubt (React, Vite, router, testing library), use the
docs MCP FIRST: `mcp__context7__resolve-library-id` → `mcp__context7__query-docs` —
guessing an API from memory is how subtle breakage ships.
<!-- mcp-docs:end -->

