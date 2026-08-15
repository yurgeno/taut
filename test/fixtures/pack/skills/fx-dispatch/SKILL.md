---
name: fx-dispatch
description: 'Stage 3 of the fx flow: implement the approved plan across repos, one isolated implementer per repo; audit the result.'
metadata:
  taut:
    agents: [fx-implementer, fx-auditor]
---

# fx-dispatch — implement (stage 3)

One fx-implementer per affected repo (working-tree edits + a patch, never commits);
then an fx-auditor compliance check. Records patches + _exec.md.
