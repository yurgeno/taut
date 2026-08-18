# TAUT Handbook — using compiled workspaces

This is the operator's guide: what `setup` builds, what guards it, and which command
changes what. Pack authoring lives in [PACK.md](PACK.md); the full CLI reference is
`node taut.mjs --help`.

## 1. The model in one paragraph

A **workspace** is a compiled artifact produced from two versioned inputs: the ENGINE
(this repo) and a DATA PACK (content: skills, agents, laws, runbooks, catalogs,
deployment configs). Both commits are pinned in `taut.lock`, and every installed file is
sha256-recorded there. A self-contained gate wired into the harness's hooks verifies
those hashes at the moments that matter — fail-closed. Changing the toolchain means
changing the SOURCES and recompiling; editing installed files by hand gets the artifact
blocked, not silently adopted.

## 2. Setup

Linux and macOS only (the framework is developed and tested on these two platforms;
Windows is not supported); Node ≥ 24 for the compiler.

```bash
node taut.mjs setup                # interactive
node taut.mjs setup --answers a.json --yes   # non-interactive
```

Questions, in order: data pack (resolution chain below) → deployment config (when the
pack ships any) → workspace folder → member repos (auto-scanned from the workspace's
parent; at least one must be selected, and deployment-mandatory repos are locked) →
harness(es) — interactively one adapter or all of them; an arbitrary subset comes from
an answers file or a later `apply` → Atlas integration (opt-in; enabling
asks for the Atlas engine folder next — an empty or wrong folder aborts setup; if you
have never heard of Atlas, keep the preselected `disable`) → workspace mode
(`normal`/`strict`) → session language (ONLY when the deployment config declares a
choice via `defaults.languages.chat = {options[], default}` — a flat value never asks;
see [PACK.md](PACK.md) §6.3) → skills → MCP servers.

Pack resolution, first hit wins: `--data` / answers `data` → the workspace's own
`.taut/local.json` binding → `TAUT_DATA` env → `<workspace-parent>/taut-data` (the
sibling convention) → `~/taut-data` → the engine repo itself (pre-split layout) →
the bundled `taut-data/` example pack.

Non-interactive answers file keys: `deployment` (`<name>` or `"none"`), `workspace`,
`repos` (path list or `"scan"`), `harnesses` (any subset of the supported set,
today `["claude-code","codex"]`), `atlas` (the Atlas engine folder to enable the
integration; omitted/false = disabled — a bare `true` fails), `mode`, `chatLanguage`
(the session-language code; accepted only when the deployment declares a choice —
omitted, the declared default applies), `skills`
(list or `"all"`), `mcp` (list or `"all"`), `data`.

## 3. Workspace anatomy

```
CLAUDE.md / AGENTS.md      generated instructions per enabled harness
.claude/skills|agents/     Claude Code payload (skills verbatim+gated, agents .md)
.claude/settings.json      gate hooks + the model profile's session pin
.mcp.json                  Claude Code MCP config (via the workspace launcher)
.agents/skills/            Codex payload (Agent Skills standard)
.codex/agents/*.toml       Codex subagents (rendered from the same sources)
.codex/config.toml         Codex MCP + gate hooks + the session model pin
.taut/gate.mjs             the integrity gate (shipped, self-contained)
.taut/mcp-launch.mjs       the MCP launcher (reads .taut/local.env itself)
.taut/mcp-servers.json     the allowed MCP servers the launcher and gate read
.taut/local.json           machine binding: repo paths, engine/pack/Atlas roots (never shared)
.taut/local.env            per-developer secrets (0600; placeholders written, values never)
.taut/LAWS.md|docs|runbooks|repos/   shipped documents, all integrity-locked
manifest.json              the workspace's own values index (locked artifact)
taut.lock                  the trust root: pins + per-file sha256 + mode + harness set
ui                         launcher: `node ui` = panel, `node ui <cmd>` = scoped CLI
memory/ -> ../<ws>-memory  SYMLINK to instance data (tickets, telemetry) — never compiled
```

## 4. The gate

Wired per harness (`.claude/settings.json` hooks; `.codex/config.toml` hooks), each
wiring carrying its identity (`--harness …`). Behavior:

- **PreToolUse** — a managed skill/agent whose file drifted from the lock is DENIED with
  the heal command; unmanaged names pass (normal mode). In **strict** mode foreign
  skills, workspace-file-backed foreign agents, and MCP servers outside the lock are
  denied too; harness BUILT-INS (tools, built-in subagent types) are never gated.
- **Prompt submit / expansion** — core-artifact drift blocks prompts; direct
  `/skill` invocations are checked on the expansion path. Recorded limitation: only
  workspace-local skills are enumerable there, so a user-global or plugin skill invoked
  by direct slash is caught at the Skill-tool chokepoint instead.
- **Session start** — integrity banner, strict notice, NON-CANONICAL notice,
  "engine/pack moved N commits" advisory, and the model-policy advisory (live model vs
  the profile pin). Advisories never block.
- A gate invoked with the identity of a DISABLED harness (stale wiring) fails closed.
- Every managed invocation is appended to `memory/telemetry/usage.jsonl`.

An unreadable `taut.lock` blocks managed artifacts entirely — the lock is the only
trust root, and the gate would rather refuse than guess.

## 5. Keeping it current — the verbs

| Verb | What it changes | When |
|---|---|---|
| `status` | nothing (read-only) | "how far behind am I?" — pins vs HEADs, drift, MCP pins; exit 0 = ACTUAL |
| `check` | nothing but a telemetry line per live gate probe | "can work run HERE, NOW?" — integrity, live gate probes per harness, repos reachable, data files readable, memory writable, the Atlas binding when enabled, real MCP handshakes |
| `verify` | nothing (read-only) | "are the installed files still the ones I compiled?" — re-hashes every artifact against the lock; `--source` additionally re-derives the COPIED ones from the pinned commits (generated artifacts stay lock-checked) |
| `update` | re-pins engine + pack (recompile) | deliberate actualization; `--data-only` re-pins the pack alone (refuses when the core moved); an "all" skill selection auto-installs newly shipped skills |
| `repair` | restores drifted/deleted files (recompile from the workspace's own manifest) | healing after tampering or accidents; renders with the current engine tree |
| `apply` | toggles: `--enable/--disable-skill`, `--enable/--disable-mcp`, `--connect/--disconnect-repo`, `--enable/--disable-harness`, `--mode strict|normal` | one deliberate recompile per batch; the panel's checklists ride this |

**The values channel:** deployment VALUES (model tiers, stacks, flow values) enter the
manifest only through `update --from-deployment` (panel: **Refresh deployment**) — a
plain update deliberately preserves the workspace's own manifest values, so nothing you
configured gets factory-reset by accident. User selections (harness set, skills, MCP,
repos) survive both.

## 6. The panel

```bash
node ui        # from the workspace folder
```

Loopback-only HTTP; mutations require a per-session token + Origin/Host checks; secrets
render as env-var NAMES + filled/empty dots — values never reach the page.

- **Control** — status badges (each explains itself on hover), Update workspace /
  Update data / Refresh deployment / Repair / Check / Mode buttons, and four
  checklists: Harness (enable any subset; the last one is locked), Skills, MCP
  servers, Repos. Checklist changes accumulate into a pending diff and land as ONE
  `apply` recompile.
- **Docs** — the workspace's shipped documentation (LAWS.md, flow docs, plain docs),
  rendered read-only.
- **Memory** — the instance-data tree (ticket folders, telemetry), read-only.

## 7. Multi-harness

Harness support is an adapter surface: the same harness-neutral sources compile into
the native toolchain of every enabled harness, side by side; the trees share no file.
Disabling a harness sweeps its entire set (payload trees, instructions file, hook
wiring, MCP config — and nothing else); enabling renders it back identically. At least
one harness stays enabled. The gate routes artifact checks by the caller's identity, so
a drifted copy blocks only that harness's sessions (a drifted Codex copy blocks Codex
sessions while intact Claude Code sessions keep working — and vice versa). Current
adapters: Claude Code and Codex; adding a harness extends the engine, never the packs.

## 8. Model profiles at runtime

If the deployment declares `modelTiers.sessionTier`, the compile pins the session model
per harness: Claude Code via `.claude/settings.json` (`model`, `effortLevel` — project
settings override the user's saved default), Codex via `.codex/config.toml` (`model`,
`model_reasoning_effort`). The instructions carry a Model policy table (tier / model /
effort / use-when for THIS harness), and the session-start banner flags a live model
outside the pinned family (or its wide-context `[1m]` variant). Escalating to a wider
tier is meant to be deliberate and temporary; quick ops never escalate. Subagents are
pinned separately through the ladder (`rolePolicy` + agent frontmatter).

## 9. Memory

`memory/` is a symlink to the sibling `<workspace>-memory` folder. The framework
NEVER writes, rewrites or sweeps anything under it — the guarantee is structural (a
compile that tries to route an artifact there fails). Ticket runs write
`memory/spec/<TICKET>/`; the gate writes `memory/telemetry/usage.jsonl`. The workspace
folder is disposable; the memory is not. Caveat: an IDE-side "discard changes" over the
workspace can still delete instance files the framework protects — treat agent-created
memory as data, not as reviewable diff noise.

## 10. Strict mode

`strict` = only the compiled toolchain runs; `normal` = framework artifacts coexist
with your own. Chosen at setup (or by the deployment's own `mode`), recorded in
manifest + lock, switched by `apply --mode …` or the panel's Mode button — deliberately
SOFT: any recompile can change it visibly (the lock/manifest diff is the audit trail).
It disciplines sessions; it is not an anti-owner lockout.

## 11. Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| gate denies a managed skill | its file drifted from the lock | `node ui repair` |
| prompts blocked | CORE artifact drift (lock, manifest, gate, instructions) | `node ui repair` |
| badge NOT CURRENT | engine/pack moved, or drift, or MCP pins behind | hover the badge; `update` / `repair` |
| badge NON-CANONICAL | compiled from a dirty engine/pack tree | recompile after committing sources |
| gate: "harness X is not enabled" | stale hook wiring for a disabled harness | re-enable it or `repair` |
| model-policy note at session start | live model ≠ the profile pin | switch back, or escalate knowingly |
| `--data-only` refused | the core itself moved — a data-only update would silently re-pin it | run a full `update` |
| MCP server missing env | `.taut/local.env` placeholders unfilled | fill the file, reconnect MCP |
