---
name: fx-init
# kaut:on
description: 'Stage 1 of the fx flow: read the tracker issue, gather landscape knowledge from the KAUT system store, write the intake report.'
# kaut:off
description: 'Stage 1 of the fx flow: read the tracker issue and write the intake report.'
# kaut:end
metadata:
  taut:
    agents: [fx-analyst]
    mcp: [tracker]
---

# fx-init — intake (stage 1)

Read the ticket, delegate heavy analysis to the fx-analyst subagent, write the intake
report to memory/spec/<TICKET>/_raw.md, stop at the owner gate.
<!-- kaut:on -->
Start with `kaut lookup` on the affected domains before any code search.
<!-- kaut:end -->
