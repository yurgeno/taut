---
name: review
description: 'Stage 3 of the react flow: review the working-tree diff against the analysis, run the checks, write the review verdict.'
allowed-tools: [Read, Glob, Grep, Bash, Agent]
metadata:
  taut:
    agents: [reviewer]
    repos: [react-app]
---

# review — judge the change (stage 3)

Input: `memory/spec/<TASK>/_analysis.md` + `_changes.md` and the react-app working tree.

1. Delegate to the **reviewer** subagent: the full diff (`git -C <react-app> diff`),
   read in context — correctness first (state updates, effect dependencies, list keys,
   race conditions), then regressions (what else renders these components), then style
   per the repo descriptor's conventions.
2. Re-run the verification the change note claims (`npm test`, lint) — a claim without
   a rerun is hearsay.
3. Write `memory/spec/<TASK>/_review.md`: findings ranked by severity, each with file
   anchor and a concrete failure scenario; end with a VERDICT line —
   `approve`, `approve-with-nits`, or `rework: <what>`.
4. Stop. The human decides what lands; on `rework` the owner relaunches `/implement`
   with the review note as input.
