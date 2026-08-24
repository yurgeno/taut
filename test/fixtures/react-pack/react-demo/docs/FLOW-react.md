---
name: react
description: 'The react-demo flow: analyze -> implement -> review, owner-gated between stages'
sequence: [analyze, implement, review]
---

# FLOW-react — the three-stage loop

A flow is a DOCUMENTED launch order, not an installed entity: this file ships to the
workspace (`.taut/docs/FLOW-react.md`), the manifest indexes which of its stages are
installed, and the generated instructions render the stage table from it.

Stage numbers are 0-based, matching how the generated instructions render this chain.

| Stage | Skill | Writes | Gate |
|---|---|---|---|
| 0 | `analyze` | `memory/spec/<TASK>/_analysis.md` | owner reads, launches stage 1 |
| 1 | `implement` | working-tree edits + `_changes.md` | owner reads, launches stage 2 |
| 2 | `review` | `_review.md` with a verdict | owner decides what lands |

Rules of the loop:

- Stages are OWNER-GATED on purpose: each writes its note and stops. Momentum is the
  enemy of reviewability.
- Every stage reads its predecessor's note from `memory/spec/<TASK>/` — chat scrollback
  is not the record, the notes are.
- On a `rework` verdict the owner relaunches `implement` with `_review.md` as input;
  the loop converges through the notes.
