---
summary:
  - "Member-repo git is READ-ONLY for agents; work product = working-tree edits + patch artifacts."
  - "No SQL execution anywhere, by any tool."
  - "The tracker is read-only."
  - "Minimal sufficient runtime: never bring up a stack by default."
---

# TAUT deployment laws — canonical text (fixture)

## L1 — Member-repo git is read-only for agents
Work product = working-tree edits + patch artifacts; branches are created by the owner.

## L2 — No SQL execution
No SQL execution anywhere, by any tool, in any environment.

## L3 — Guarded repos
Guarded repos get owner-controlled prompts instead of autonomous agents.

## L4 — Minimal sufficient runtime
Pick the LOWEST runtime tier that satisfies the task; never bring up a stack by default.

## L5 — Tracker read-only
Read issues; never transition, comment, or mutate.

## L6 — Secrets
Secrets live in the local env file only; values never enter canon.

## L7 — Instance scoping
No instance names in framework artifacts; values flow from the deployment manifest.

## L8 — Knowledge writes
Knowledge writes go through the sanctioned pipeline only.

## L9 — Contextual precedence
Workspace-launched tasks follow workspace laws; repo-launched tasks follow the repo.
