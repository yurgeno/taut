---
name: fx-plan
description: 'Stage 2 of the fx flow: turn the approved intake into a per-repo executable plan.'
# mcp-docs:on
allowed-tools: [Read, Glob, Grep, Bash, Agent, mcp__context7__resolve-library-id, mcp__context7__query-docs]
# mcp-docs:off
allowed-tools: [Read, Glob, Grep, Bash, Agent]
# mcp-docs:end
metadata:
  taut:
    agents: [fx-researcher]
    mcp: [docs]
---

# fx-plan — plan (stage 2)

Deep cross-repo analysis; delegate recon to the fx-researcher subagent; write _plan.md.
<!-- mcp-docs:on -->
Best practices via the docs MCP: resolve-library-id then query-docs, before web search.
<!-- mcp-docs:off -->
Best practices via web search.
<!-- mcp-docs:end -->
<!-- kaut:on -->
Consult `kaut lookup` per the trust hierarchy before concluding a root cause.
<!-- kaut:end -->
