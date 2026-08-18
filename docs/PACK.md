# PACK.md — authoring TAUT data packs

A data pack is the CONTENT half of the core/data split: a plain (usually private) git
repository holding everything the engine distributes. The bundled example
(`taut-data/`) demonstrates every element kind and is exercised by the test suite —
copy it and replace the content. Layout contract: `taut-data/README.md`.
New to packs? Start with **[TUTORIAL.md](TUTORIAL.md)** — it builds the
`taut-data/react-demo/` project file by file; this document is the reference.

Two standing rules shape everything below:

- **Values, not names.** The engine hardcodes no content names. Anything
  project-specific is a VALUE in the pack (deployment config, frontmatter, catalog) and
  derives parametrically. Content ROLES (`metadata.taut.role`) replace hardcoded
  filenames where the engine needs "the skill that does X".
- **Everything installed is locked.** Whatever the pack ships lands in the workspace as
  an integrity-locked artifact; `verify --source` can re-derive copies from the pinned
  pack commit — keep the pack a real git repo so the pin axis works.

## 1. Skills — `skills/<name>/SKILL.md`

Standard SKILL.md (frontmatter `name`, `description`, optional `allowed-tools`) plus
the wiring block the compiler consumes:

```yaml
metadata:
  taut:
    agents: [fx-analyst]      # subagents this skill launches → they get installed
    requires: [atlas]         # capability requirements; unmet → skill not offered
                              # (`atlas` is the only capability the engine gates on today)
    mcp: [docs]               # documentary: the MCP roles this skill uses. NOT wiring —
                              # the mcp-docs gate follows the servers actually installed
    repos: [repo-core]        # repo bindings → repo-map lint (see §7)
    role: stack-engine        # content role: stack-engine | spa-mock | knowledge
```

Skills install verbatim (byte-copied) into every enabled harness's native tree after
the capability-marker pass (§3). A skill named by nothing still installs — skills are
selected at setup; agents ride along only when a selected skill names them.

## 2. Agents — `agents/<name>.md`

Subagent sources with standard frontmatter. `model:` pins matter twice: Claude Code
reads them natively, and the compiler maps them into Codex TOML through the deployment's
model ladder (the rung whose `models["claude-code"]` equals the pin supplies
`models.codex` + `reasoningEffort.codex`). `effort:` pins pass through for Claude Code.
Recorded degradation: Claude Code frontmatter tool allowlists are informational on
Codex — put the methodology in the body.

## 3. Capability markers — conditional compilation

Sources are written ONCE with capability branches inline; the compiler keeps exactly
one branch per gate, so a workspace never receives instructions (or tool allowlists)
for a capability it does not have:

```
<!-- atlas:on -->        …lines kept when the capability is ON…
<!-- atlas:off -->       …optional OFF branch…
<!-- atlas:end -->
```

`# key:on` / `# key:off` / `# key:end` work inside YAML frontmatter. Known keys:
`atlas` (the Atlas integration answer) and `mcp-docs` (a docs-role MCP server is
installed). Markers must be alone on their line; no nesting; unknown keys or unclosed
blocks FAIL the compile. Marker lines never ship.

## 4. Documents — `docs/`

- `LAWS.md` — the deployment laws. Frontmatter `summary:` bullets render into every
  generated instructions file; the full text ships as `.taut/LAWS.md` (locked). A
  project-folder LAWS.md OVERRIDES the shared one.
- `FLOW-<name>.md` — a flow is nothing but a DOCUMENTED launch order. Frontmatter
  `sequence: [fx-task, fx-init, …]`; the doc ships when its sequence touches an
  installed skill, and the manifest indexes the installed stages.
- Any other `*.md` ships to every workspace as `.taut/docs/<name>`.

## 5. MCP catalog — `catalog/mcp.json`

```json
{ "servers": { "<id>": {
    "role": "tracker",            // the ROLE skills reference via metadata.taut.mcp
    "serverKey": "atlassian",     // MUST match the tool namespace: mcp__<serverKey>__*
    "package": "mcp-atlassian", "pin": "0.23.0",
    "command": "uvx", "args": ["mcp-atlassian==0.23.0"],
    "env": ["JIRA_URL", "JIRA_API_TOKEN"],   // keys developers fill in .taut/local.env
    "fixedEnv": { "READ_ONLY_MODE": "true" },// framework-mandated, not overridable
    "usage": "one-line note rendered into the instructions",
    "tools": ["mcp__atlassian__jira_get_issue"] // informational: the tool names your
                                                // gated branches cite; the engine reads none
  } },
  "envHelp": { "JIRA_URL": ["Base URL of your Jira site.", "example: …"] } }
```

Servers launch through the SHIPPED launcher (`.taut/mcp-launch.mjs <id>`), which reads
`.taut/local.env` itself at server start — nothing exported, secrets never compiled. A
project-folder catalog merges over the shared one (project wins per id / env key).

## 6. Deployment configs — `<project>/deployment.json`

A PROJECT FOLDER at the pack root is one project's whole home: its `deployment.json`
plus optional project-scoped `skills/ agents/ docs/ catalog/ runbooks/ repos/`. Worked
example: `taut-data/react-demo/` (tutorial-grade, heavily commented); the full surface
— mandatory repos, guards, stacks, a shared multi-project layer — is exercised by the
engine's internal test fixture (`test/fixtures/pack/`, project `fxdep`) if you want to
see every key in use at once.

### 6.1 Structural keys (consumed by setup)

| Key | Meaning |
|---|---|
| `name` | MUST equal the folder name — the compile fails otherwise (catches copy-paste) |
| `description` | shown in the setup picker and recorded in the manifest |
| `mode` | optional default workspace mode: `"strict"` or `"normal"`; answers `mode` overrides; adopted by existing workspaces on `update --from-deployment` |
| `repos.mandatory` | repo names locked into every workspace of this deployment — setup refuses to compile without them, the panel's checklist locks them |
| `repos.known` | the full repo map: `{"<name>": {"role": "…", "guards": […]}}`. `role` and `guards` pass through into the generated manifest's `repos[]` rows for skills to honor |
| `$comment` | ignored among the STRUCTURAL keys — annotate freely. Not so inside the `manifest` bag: that bag passes through VERBATIM, so anything you put there ships into the workspace manifest (deliberate in `react-demo`, whose `note:` keys document the values for the agents reading them) |

**The repo map is load-bearing.** It is the LINT DOMAIN for every repo binding in the
pack: `metadata.taut.repos` on skills, `repos:` on runbooks, and `repos/<name>/`
descriptor folders must all name mapped repos (unknown name = compile error). A mapped
repo NOT connected in a given workspace excludes the artifacts bound to it — with a
warning, never silently. Repos are matched by FOLDER BASENAME on the user's machine;
setup scans the workspace's parent directory and pre-checks mapped names.

### 6.2 The `manifest` bag (passed VERBATIM)

Everything under `manifest` lands in the generated workspace `manifest.json` unchanged
— this is the ONLY channel by which your values reach skills/agents at run time (they
read the manifest, never the pack). Two mechanics to know:

- **Compiler-owned keys are protected.** `name, framework, deployment, description,
  harness(es), atlas, mode, flow, flows, flowDocs, runbooks, repoDocs, skills,
  skillsSelection, skillsExcluded, agents, mcp, repos, laws` are computed by the engine;
  a config supplying them gets a warning and the value is ignored. `flow` is the single
  exception: your flow values MERGE around the computed `flow.stages` — silently, no
  warning — and `stages` is applied LAST, so authoring it yourself has no effect. The
  stage chain is DERIVED (flow docs × installed skills), never declared.
- **Values refresh is deliberate.** A plain `update` preserves the workspace manifest's
  existing values (repair fidelity); edits to `deployment.json` reach existing
  workspaces only through `update --from-deployment` (panel: **Refresh deployment**).
  New workspaces always compile from the current config.

### 6.3 Conventional blocks

The engine treats these as opaque values except at the named seams:

- `flow` — tracker/branch/scm values (ticket patterns, label→repo routing, branch
  policy). Purely skill-consumed; deployments without a tracker simply omit
  `flow.tracker` (see react-demo).
- `runtimeTiers` — the cost-ordered runtime ladder (`static` → mocks → dev servers →
  stacks), teaching sessions to pick the LOWEST sufficient tier. SEAM: a rung's
  `runbook` must name a shipped runbook file (lint); a rung whose runbook the repo lint
  excluded is flagged not-runnable.
- `stacks` — named stack profiles (`{description, runbook, infra[], services[], spa,
  human[], extends}`). SEAM: each generates an `up-<name>` wrapper skill over the
  installed skill declaring `metadata.taut.role: stack-engine`; the wrapper points at
  the stack's runbook; a stack whose runbook is excluded generates NO wrapper (warned).
- `modelTiers` — the MODEL PROFILE (§8). SEAMS: `sessionTier` renders into harness
  configs + the lock; the ladder maps agent pins into Codex TOML; single-harness
  compiles add flat per-rung values.
- `defaults.languages` — the language policy (`{documents, chat, tracker}`; language
  codes). SEAM on `chat` (the session-communication language): a flat code fixes it —
  setup asks nothing; declaring `"chat": {"options": ["ru", "en", "cs"], "default":
  "en"}` instead turns it into a SETUP QUESTION (one extra step, answered
  non-interactively via answers `chatLanguage`, changed later with `taut apply
  --chat-language <code>`). Either way the workspace manifest carries the resolved FLAT
  code, and the generated instructions state the session language explicitly (a
  `## Languages` block); `documents`/`tracker` always ride through untouched. The
  question set thus lives in the PACK: a deployment that declares no choice is never
  asked about languages.

Anything else you put in the bag rides along untouched — deployment-specific values
for your own skills are exactly what it is for.

## 7. The repo map and per-repo knowledge

Artifacts binding to repos by name (`metadata.taut.repos`, runbook `repos:`) are LINTED
at compile: a repo unknown to the deployment map is an ERROR; a known-but-unconnected
repo excludes the artifact with a warning — never a silently dead install.

`<project>/repos/<repo>/*.md` are per-repo DESCRIPTORS: working knowledge (stack,
verified commands, layout, gotchas) installed as `.taut/repos/<repo>/` for connected
repos. The member repo itself is never touched. `taut repo-scaffold` writes a skeleton
with an embedded distillation brief into the pack for connected repos the pack does not
cover; an agent fills it by read-only analysis, you commit the pack, `update` installs.

## 8. Model profiles — `manifest.modelTiers`

```json
{ "sessionTier": "frontier",
  "ladder": [
    { "tier": "cheap",    "useWhen": "mechanical work",
      "models": { "claude-code": "haiku", "codex": "gpt-5.6-luna" },
      "reasoningEffort": { "claude-code": "low", "codex": "low" } },
    { "tier": "frontier", "useWhen": "high-stakes reasoning; the session default",
      "models": { "claude-code": "opus", "codex": "gpt-5.6" },
      "reasoningEffort": { "claude-code": "high", "codex": "high" } },
    { "tier": "frontier-wide", "useWhen": "whole-landscape synthesis — deliberate escalation only",
      "models": { "claude-code": "opus[1m]", "codex": "gpt-5.6" } } ],
  "rolePolicy": { "frontier": ["repo-implementer"], "cheap": ["compliance-auditor"] } }
```

- `sessionTier` names the rung the ORCHESTRATOR session runs on. It renders into
  `.claude/settings.json` (`model`/`effortLevel`) and `.codex/config.toml`
  (`model`/`model_reasoning_effort`), lands in the lock, and powers the gate's
  session-start advisory. An unknown tier fails the compile.
- Context width is part of the model string (`opus` vs `opus[1m]`); Codex context is
  not a configurable axis.
- `rolePolicy` is the declarative agent-role → tier mapping; keep it in step with the
  agent frontmatter pins (the pins are what enforce).
- With ONE harness enabled the manifest also gets flat `model`/`reasoningEffort` per
  rung for that harness; with both, the per-harness maps stay unresolved (a flat value
  for one harness would mislead the other's sessions).

## 9. Runbooks — `<project>/runbooks/<name>.md`

Frontmatter = index values (`description`, optional `repos: []`), body = the recipe an
agent reads. Installed to `.taut/runbooks/`, indexed in the manifest, referenced by
name from `stacks.<n>.runbook` and `runtimeTiers.ladder[].runbook` (an unknown name
fails the compile; one excluded by the repo lint warns and skips its consumers).

## 10. Validation summary — what fails a compile

Unknown skill/MCP-server/harness/deployment names (note: the roles in a skill's
`metadata.taut.mcp` are documentary and NOT validated); a deployment folder whose `name` mismatches;
mandatory repos missing; duplicate repo basenames; artifacts binding to repos the
deployment does not know; runbook references to nothing; malformed or unknown capability
markers; a `modelTiers.sessionTier` naming no rung; legacy `metadata.federation` wiring;
shared/project name collisions (except the sanctioned LAWS override and catalog merge).
Warnings (never silent): scan-excluded repos, lint-excluded artifacts, flow-chain gaps,
compiler-owned manifest keys in a config.
