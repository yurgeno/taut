# TUTORIAL — your first data pack, file by file

This walkthrough builds a complete TAUT deployment for a small React project: three
skills launched in sequence (**analyze → implement → review**), a subagent behind each,
one repo, one runbook, a documented flow, per-harness model profiles, and
context7 as the only MCP server. The finished result ships in this repo as
**`taut-data/react-demo/`** — every file below exists there, and the test suite
compiles it on every `npm test`, so the tutorial cannot drift from reality.

Reference docs as you go: [PACK.md](PACK.md) (every element kind + the full
`deployment.json` reference) and [HANDBOOK.md](HANDBOOK.md) (operating the compiled
workspace). Prerequisites: Node ≥ 24 on Linux or macOS — the only supported and
tested platforms.

## 0. The mental model

You author a **data pack** — a folder (in real life: its own private git repo). The
engine compiles pack + your answers into a **workspace**: a folder your harness opens,
with skills/agents installed natively, laws and runbooks shipped as locked documents,
and a gate that blocks anything edited outside the pipeline. You never edit the
workspace — you edit the pack and recompile (`node ui update`).

A pack can hold many PROJECTS. Everything specific to one project lives in ONE folder
at the pack root, named after it:

```
my-pack/
  react-demo/
    deployment.json      ← the project's values (this is the file people get wrong)
    skills/              ← the project's skills
    agents/              ← the subagents those skills launch
    docs/                ← FLOW-*.md, LAWS.md, any plain docs
    runbooks/            ← bring-up recipes
    repos/<repo>/*.md    ← per-repo knowledge, shipped into the workspace
    catalog/mcp.json     ← MCP servers this project uses
```

Pack-root `skills/ agents/ docs/ catalog/` also exist as an optional SHARED layer for
multi-project packs — ignore them on a first pack; put everything in your project
folder.

## 1. `deployment.json` — the project's values

Create `react-demo/deployment.json`. Two zones: **structural keys** the setup consumes,
and a **`manifest` bag** copied VERBATIM into the generated workspace `manifest.json`
(this is how your values reach the skills at run time).

```jsonc
{
  "name": "react-demo",              // MUST equal the folder name (lint)
  "description": "…",                // shown in the setup picker
  "repos": {                         // the REPO MAP
    "known": {
      "react-app": { "role": "React 18 + Vite SPA - the product under work" }
    }
  },
  "manifest": { …see below… }
}
```

The repo map is load-bearing, not documentation:

- Artifacts that name a repo (`metadata.taut.repos`, a runbook's `repos:`) are LINTED
  against it — a name outside the map fails the compile (catches typos), a mapped repo
  not connected in a given workspace excludes the artifact with a warning.
- A `repos/<name>/` descriptor folder must match a mapped name.
- Add `"mandatory": ["react-app"]` INSIDE the `repos` object (next to `known`) to lock a
  repo into every workspace of this deployment (setup refuses without it). The tutorial
  leaves it out so you can try the compile with a stub folder.
- Per-repo `"guards": […]` values pass through for your skills to honor.

Inside `manifest` the tutorial uses three conventional blocks (all optional, all
yours to shape — the engine passes them through and only the named seams below are
consumed by machinery):

```jsonc
"flow":         { "branch": { "pattern": "feature/*", "agentCreate": "forbidden" } },
"runtimeTiers": { "ladder": [                       // cost-ordered runtime ladder
                  { "tier": "static",     "how": "read the code - no runtime" },
                  { "tier": "dev-server", "how": "Vite dev server",
                    "runbook": "dev-server" } ] },  // ← names a runbook FILE (lint)
"modelTiers":   { …the model profile, step 5… }
```

Full key-by-key reference: [PACK.md §6](PACK.md#6-deployment-configs--projectdeploymentjson).

## 2. The first skill — `skills/analyze/SKILL.md`

A skill is a standard `SKILL.md` plus one TAUT block in the frontmatter:

```markdown
---
name: analyze                        # MUST equal the directory name
description: 'Stage 1 of the react flow: …'
allowed-tools: [Read, Glob, Grep, Bash, Agent, AskUserQuestion]
metadata:
  taut:
    agents: [analyst]                # subagents this skill launches → they install too
    repos: [react-app]               # repo binding → checked against the repo map
---

# analyze — understand before touching (stage 1)
…the procedure the session follows…
```

`metadata.taut` is the WIRING — the compiler reads it to decide what else to install
(`agents`), what to lint (`repos`), and whether a capability requirement is met
(`requires`). `mcp` is documentary: which MCP roles the skill uses. The `mcp-docs`
capability branch follows the servers the WORKSPACE installed, not this list.
The body is the methodology; write it as instructions to the session, ending with
"write the note, stop at the owner gate" — gated stages are what make the flow
reviewable.

Frontmatter is a STRICT subset of YAML (single-line values, inline `[a, b]` lists,
2-space nesting; anything fancier fails the compile with a line number — deliberately,
so a typo can't parse wrong).

Repeat for `implement` and `review` — see the shipped files. `implement` shows one more
wiring key, `mcp: [docs]`, plus a capability-gated paragraph:

```markdown
<!-- mcp-docs:on -->
For any library/framework API doubt use the docs MCP FIRST: …
<!-- mcp-docs:end -->
```

If the compiled workspace has no docs-role MCP server, that paragraph — and the tool
names in it — are compiled OUT. A workspace never carries directives for capabilities
it lacks.

## 3. The agents — `agents/{analyst,implementer,reviewer}.md`

An agent is a standard subagent file; the tutorial's three carry model pins:

```markdown
---
name: analyst
description: Read-only analysis subagent for the react flow. …
tools: Read, Glob, Grep, Bash
model: sonnet          # the Claude Code pin — also the KEY into the model ladder
effort: medium
---
…the methodology…
```

The body is the contract: what the agent does, what it never does (the analyst never
edits; the reviewer never fixes), and what it returns — subagents report to the calling
skill, which writes the stage note.

## 4. The flow — `docs/FLOW-react.md`

A flow is a DOCUMENTED launch order, not an installed thing:

```markdown
---
name: react                          # file must be FLOW-<name>.md
description: 'analyze -> implement -> review, owner-gated'
sequence: [analyze, implement, review]
---
…what each stage writes, where the gates are…
```

The doc ships when its sequence touches an installed skill; the generated instructions
render the stage table from it; installing a mid-chain skill without its predecessor
draws a warning.

## 5. The model profile — `manifest.modelTiers`

The block that answers "which model, which effort, which context width, for what":

```jsonc
"modelTiers": {
  "sessionTier": "frontier",                  // the ORCHESTRATOR session's tier
  "ladder": [
    { "tier": "cheap",    "useWhen": "mechanical work",
      "models": { "claude-code": "haiku",  "codex": "gpt-5.6-luna"  },
      "reasoningEffort": { "claude-code": "low",    "codex": "low"    } },
    { "tier": "mid",      "useWhen": "bounded analysis",
      "models": { "claude-code": "sonnet", "codex": "gpt-5.6-terra" },
      "reasoningEffort": { "claude-code": "medium", "codex": "medium" } },
    { "tier": "frontier", "useWhen": "writing and reviewing code; the SESSION default",
      "models": { "claude-code": "opus",   "codex": "gpt-5.6"       },
      "reasoningEffort": { "claude-code": "high",   "codex": "high"   } }
  ],
  "rolePolicy": { "frontier": ["implementer", "reviewer"], "mid": ["analyst"] }
}
```

What the compiler does with it:

- `sessionTier` → `.claude/settings.json` gets `"model": "opus"` +
  `"effortLevel": "high"` (workspace settings beat the user's saved default);
  `.codex/config.toml` gets `model = "gpt-5.6"` + `model_reasoning_effort = "high"`.
  The gate's session-start banner flags a live session running something else.
- Agent pins map ACROSS harnesses: `analyst` pins `model: sonnet`; the ladder rung
  whose `models["claude-code"]` is `sonnet` supplies the Codex TOML its
  `gpt-5.6-terra` + `medium`.
- A wider-context tier is just a model string: add a rung with
  `"claude-code": "opus[1m]"` for whole-landscape work, marked "deliberate escalation
  only" in its `useWhen`.
- `rolePolicy` is declarative documentation of role → tier; the PINS enforce.

Model ids are pack VALUES passed through verbatim — the compiler validates none of
them. The ones above are the current ids of the two shipped adapters (Claude Code:
[model config](https://code.claude.com/docs/en/model-config.md); Codex: [subagent
configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents), both
checked 2026-08-15). Model line-ups move — when you build your own pack, put in the
ids your harness offers you today.

## 6. The runbook — `runbooks/dev-server.md`

```markdown
---
name: dev-server                     # file must be <name>.md
description: 'Bring up the react-app Vite dev server for interactive verification'
repos: [react-app]                   # binding → excluded (with a warning) if unconnected
---
…the recipe: commands, ready markers, known failures…
```

Runbooks install to `.taut/runbooks/`, are indexed in the manifest, and are what
`runtimeTiers.ladder[].runbook` (and `stacks.*.runbook`, when you have stacks) point
at — an unknown name fails the compile.

## 7. Per-repo knowledge — `repos/react-app/CLAUDE.md`

Everything an agent should know BEFORE working in the repo: stack, verified commands,
layout, conventions, gotchas. It installs into the workspace as
`.taut/repos/react-app/` — the member repo itself is never touched, and workspace
descriptors take precedence over any instruction files inside the repo. Keep a
`derived:` anchor line so staleness is visible. For repos you haven't described yet,
`node ui repo-scaffold` writes a skeleton with an embedded distillation brief.

## 8. MCP — `catalog/mcp.json`

react-demo needs one server, context7 (role `docs`):

```jsonc
{ "servers": { "context7": {
    "role": "docs", "serverKey": "context7",
    "package": "@upstash/context7-mcp", "pin": "4.0.2",
    "command": "npx", "args": ["-y", "@upstash/context7-mcp@4.0.2"],
    "env": ["CONTEXT7_API_KEY"], "fixedEnv": {},
    "tools": ["mcp__context7__resolve-library-id", "mcp__context7__query-docs"],
    "usage": "Use it PROACTIVELY for any library/framework API question…" } },
  "envHelp": { "CONTEXT7_API_KEY": ["API key…", "https://context7.com/dashboard"] } }
```

`role` is what skills reference (`mcp: [docs]`) and what capability gates key on;
`serverKey` must match the tool namespace (`mcp__context7__*`); `env` keys become
commented placeholders in the workspace's `.taut/local.env` — the developer fills that
one file, the shipped launcher reads it at server start, nothing is exported.

## 9. Laws — `docs/LAWS.md`

Frontmatter `summary:` bullets render into every workspace's instructions; the full
text ships locked. react-demo's four: git is human-owned; notes over scrollback;
verify claims by running; secrets never enter files. A project-level LAWS.md overrides
the pack-level one. Keep laws few and enforceable.

## 10. Compile it

Stub the fictional repo, then run setup against the bundled pack:

```bash
git init -q /tmp/react-land/react-app
cat > /tmp/react-land/answers.json <<'EOF'
{ "deployment": "react-demo",
  "workspace": "/tmp/react-land/ws",
  "repos": ["/tmp/react-land/react-app"],
  "harnesses": ["claude-code", "codex"],
  "skills": ["analyze", "implement", "review"],
  "mcp": ["context7"],
  "atlas": false, "mode": "normal" }
EOF
node taut.mjs setup --answers /tmp/react-land/answers.json --yes
```

(Interactively: `node taut.mjs setup`, pick `react-demo`, check the same boxes.
On your own project: point `repos` at your real repo and rename the map entry.
Setup also asks one ENGINE-owned question — the usage-telemetry level, `extended`
(default) or `basic`; omitted in `--answers` the default applies. Telemetry is stored
ONLY on this machine under `memory/telemetry/`, one file per day, is never sent
anywhere, and collects no personal data — see HANDBOOK §9.)

What you get: the toolchain of every enabled harness side by side, each invoked its own
native way (`/analyze` in Claude Code, `$analyze` in Codex), the
session model pinned per the profile, `.taut/LAWS.md` + `FLOW-react.md` + the runbook +
the react-app descriptor shipped and locked, context7 wired through the launcher, and
`memory/` linked outside the workspace. Open the panel:

```bash
cd /tmp/react-land/ws && node ui
```

## 11. Iterate

Edit the PACK, then from the workspace: `node ui update` (re-pins engine + pack;
content flows in), `node ui repair` (heals drift), panel checklists for
skill/MCP/repo/harness toggles, **Refresh deployment** for `deployment.json` VALUES
(a plain update deliberately preserves the workspace's manifest values). Commit the
pack repo like any code — the lock pins its commit, and `verify --source` can re-derive
every COPIED file from that pin (generated artifacts — instructions, manifest, harness
configs — stay lock-checked). Keep the pack its OWN git repo: the bundled example sits
inside the engine repo, so it carries no data pin of its own and that axis reads
"not judged".

## 12. What the lints catch for you

Folder/frontmatter name mismatches; unknown skills/agents/MCP-server/runbook names; repo
bindings outside the map; descriptor folders for unmapped repos; malformed frontmatter
(with line numbers); unclosed or unknown capability markers; wiring that varies between
capability branches; an unknown `sessionTier`; name collisions between the shared layer
and a project (except the sanctioned LAWS override and catalog merge). If the compile
is green, the workspace is coherent.
