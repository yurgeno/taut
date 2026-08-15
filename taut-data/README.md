# taut-data — the example DATA PACK

The pack bundled with the engine. Its root holds **PROJECT FOLDERS** — one folder per
project, carrying everything that belongs to that project. Here there is exactly one:

- **`react-demo/`** — the tutorial project: a three-stage owner-gated flow
  (analyze → implement → review) for a one-repo React landscape, with a subagent per
  stage, per-harness model profiles, a runbook, per-repo knowledge for the fictional
  `react-app`, project laws, and context7 as the only MCP server. The engine repo's
  `docs/TUTORIAL.md` builds this project file by file; an end-to-end test compiles it
  on every `npm test`, so the example cannot rot.

This pack is also the resolver's LAST fallback — a bare engine checkout compiles a
workspace from it with zero configuration (`docs/TUTORIAL.md` §10 shows the commands,
including the stub for the fictional repo).

## Layout (the pack contract)

A real pack is a separate (usually private) git repository shaped like this one:

    pack.json                     optional descriptor: { "name", "description" }
    <project>/                    a PROJECT FOLDER per project — its whole home:
      deployment.json             the project's VALUES (repo map, mode, manifest bag:
                                  flow/runtimeTiers/stacks/modelTiers …)
      skills/<name>/SKILL.md      flat skills; wiring in frontmatter `metadata.taut`
      agents/<name>.md            subagents — installed when a skill names them
      docs/LAWS.md                the project's laws (frontmatter `summary:` bullets)
      docs/FLOW-<name>.md         flow docs (frontmatter `sequence:`)
      docs/*.md                   any other markdown ships to every workspace
      catalog/mcp.json            MCP server pins + env help
      runbooks/<name>.md          bring-up recipes (frontmatter = index values)
      repos/<repo>/*.md           per-repo working knowledge (workspace descriptors)

Pack-root `skills/ agents/ docs/ catalog/` are ALSO legal — an optional SHARED layer
for multi-project packs (names must be unique across layers; a project LAWS.md
overrides the shared one; a project catalog merges over shared pins). Skip the shared
layer until you actually have several projects sharing content.

## Using your own pack

Point the engine at it: keep it as `taut-data` NEXT TO your workspace (the sibling
convention — a landscape root reads `{repos…, <ws>, <ws>-memory, taut-data}`), or pass
`taut setup --data <path>`, or set `TAUT_DATA`, or keep a global `~/taut-data`. The
chosen pack is PINNED in `taut.lock` next to the engine commit — `status`/`update`
judge both axes, PROVIDED the pack is its own git repo. This bundled one is a folder
inside the engine repo, so it carries no pin of its own and its axis honestly reads
"not judged"; give a real pack its own repository. Authoring reference: `docs/PACK.md`;
walkthrough: `docs/TUTORIAL.md`.
