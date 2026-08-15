---
name: analyze
description: 'Stage 1 of the react flow: understand the task, map the change surface in react-app, write the analysis note. Delegates deep reading to the analyst subagent.'
allowed-tools: [Read, Glob, Grep, Bash, Agent, AskUserQuestion]
metadata:
  taut:
    agents: [analyst]
    repos: [react-app]
---

# analyze — understand before touching (stage 1)

Input: the task as stated by the user in chat (this deployment has no tracker).

1. Restate the task in one paragraph; ask (AskUserQuestion) only what genuinely blocks
   analysis — ambiguous scope, conflicting acceptance criteria.
2. Read the repo descriptor FIRST: `.taut/repos/react-app/` (workspace-owned knowledge —
   stack, verified commands, layout, gotchas). Trust the code over the descriptor when
   they disagree, and say so in the note.
3. Delegate the deep pass to the **analyst** subagent: which components, hooks, routes
   and tests the task touches; what the current behavior is; where the risk lives.
4. Write `memory/spec/<TASK>/_analysis.md`: task restatement, affected files with
   line-level anchors, current-behavior notes, risks, open questions, and a
   VERDICT line — `ready-to-implement` or `blocked: <why>`.
5. Stop. The owner reads the note and launches `/implement` — stages are gated on
   purpose; do not roll into implementation.

Runtime discipline: stay on the `static` tier here — analysis reads code, it does not
need the dev server (the ladder lives in `manifest.json` → `runtimeTiers`).
