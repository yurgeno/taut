---
name: LAWS
summary:
  - '**Git is human-owned.** Agents produce WORKING-TREE edits only: no commit, no branch, no push, no reset. The human reviews the diff and owns everything that lands.'
  - '**Notes over scrollback.** Every stage writes its note to memory/spec/<TASK>/ and stops at the owner gate; the next stage starts from the note, never from memory of the chat.'
  - '**Verify claims by running.** A verification claim without the command actually re-run in this session is hearsay - rerun `npm test`/lint before repeating it.'
  - '**Secrets never enter files.** Tokens and keys live in .taut/local.env only; never in code, notes, or examples.'
---

# Deployment laws — react-demo

The four bullets above are the summary rendered into every workspace's instructions;
this file is the canonical text, shipped integrity-locked as `.taut/LAWS.md`.

This is a PROJECT-level laws file: it OVERRIDES the pack-level `docs/LAWS.md` for
react-demo workspaces — each project's laws are the laws of its workspaces. Keep laws
few and enforceable; a law nobody can check is a wish.
