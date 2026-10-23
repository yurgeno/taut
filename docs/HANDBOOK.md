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
pack ships any) → workspace folder (created if it does not exist yet) → member repos (auto-scanned from the workspace's
parent; at least one must be selected, and deployment-mandatory repos are locked) →
harness(es) — interactively one adapter or all of them; an arbitrary subset comes from
an answers file or a later `apply` → KAUT integration — formerly Atlas; legacy `atlas`
keys/markers still accepted (opt-in; enabling
asks for the KAUT engine folder next — an empty or wrong folder aborts setup; if you
have never heard of KAUT, keep the preselected `disable`) → workspace mode
(`normal`/`strict`) → session language (ONLY when the deployment config declares a
choice via `defaults.languages.chat = {options[], default}` — a flat value never asks;
see [PACK.md](PACK.md) §6.3) → skills → MCP servers.

Pack resolution, first hit wins: `--data` / answers `data` → the workspace's own
`.taut/local.json` binding → `TAUT_DATA` env → `<workspace-parent>/taut-data` (the
sibling convention) → `~/taut-data` → the engine repo itself (pre-split layout).
The engine ships no content of its own — when the chain finds nothing, setup fails
with the fix: `git clone https://github.com/yurgeno/taut-data-community.git
~/taut-data` (the public starter pack).

A deployment's repo map CURATES the scan: with `repos.known`/`mandatory` entries only
those repos connect (a landscape where the pack decides membership). A deployment that
declares NO repos curates nothing — every scanned repo connects, which is what a generic
starter pack wants.

`repos: "scan"` searches the landscape root (the workspace's parent) **two levels
deep**: git repositories directly in the root, plus repositories inside a level-1 folder
that is not itself a repo — a project folder grouping several repos (`travel/{web,api}`)
is discovered without extra flags. Workspaces are skipped at both levels. Repos are keyed
by BASENAME: when the same basename appears twice, the first in sorted order wins and the
other is reported as a collision, to be connected by path if it was the wanted one
(`apply --connect-repo <path>`). Deeper nesting is never searched — pass those repos as
explicit paths.

Non-interactive answers file keys: `deployment` (`<name>` or `"none"`), `workspace`,
`repos` (path list or `"scan"`), `harnesses` (any subset of the supported set,
today `["claude-code","codex","opencode"]`), `kaut` (the KAUT engine folder to enable the
integration — the legacy `atlas` key is still accepted; omitted/false = disabled — a
bare `true` fails), `mode`, `chatLanguage`
(the session-language code; accepted only when the deployment declares a choice —
omitted, the declared default applies), `skills`
(list or `"all"`), `mcp` (list or `"all"`), `data`.

## 3. Workspace anatomy

```
CLAUDE.md / AGENTS.md      generated instructions per enabled harness
.claude/skills|agents/     Claude Code payload (skills verbatim+gated, agents .md)
.claude/settings.json      gate hooks + the model profile's session pin
.mcp.json                  Claude Code MCP config (via the workspace launcher)
.agents/skills/            Codex + opencode payload (Agent Skills standard — SHARED:
                           both harnesses read it natively, one copy, one lock row)
.codex/agents/*.toml       Codex subagents (rendered from the same sources)
.codex/config.toml         Codex MCP + gate hooks + the session model pin
.opencode/agents/*.md      opencode subagents (rendered from the same sources)
.opencode/plugins/taut-gate.js  the gate as an opencode plugin (auto-loaded; CORE)
opencode.json              opencode MCP + session model pin (+ strict skill allowlist)
.taut/gate.mjs             the integrity gate (shipped, self-contained)
.taut/mcp-launch.mjs       the MCP launcher (reads .taut/local.env itself)
.taut/mcp-servers.json     the allowed MCP servers the launcher and gate read
.taut/local.json           machine binding: repo paths, engine/pack/KAUT roots (never shared)
.taut/local.env            per-developer secrets (0600; placeholders written, values never)
.taut/LAWS.md|docs|runbooks|repos/   shipped documents, all integrity-locked
repos/<name>/descriptor.md workspace-owned INSTANCE descriptor per connected repo the
                           pack does not cover: scaffolded at compile, filled in place
                           by the pack's init skill, read by every session; instance
                           data — never locked, never swept, never overwritten
manifest.json              the workspace's own values index (locked artifact)
taut.lock                  the trust root: pins + per-file sha256 + mode + harness set
ui                         launcher: `node ui` = panel, `node ui <cmd>` = scoped CLI
memory/ -> ../<ws>-memory  SYMLINK to instance data (tickets, telemetry) — never compiled
```

**Repo descriptors, two homes, one index** (manifest `repoDocs`): a repo the data pack
covers gets the pack's files installed under `.taut/repos/` — distributed, reviewed,
integrity-locked. Every other connected repo gets a workspace-owned instance descriptor
under `repos/` — a living file with no external source of truth, deliberately NOT locked
(locking it would turn every legitimate edit into "drift"). One repo is always under
exactly one regime. Member repositories themselves are NEVER written; instruction files
inside them carry no authority in workspace sessions (L9).

## 4. The gate

Wired per harness (`.claude/settings.json` hooks; `.codex/config.toml` hooks;
`.opencode/plugins/taut-gate.js` — a thin plugin translating opencode's
`tool.execute.before` onto the same gate, deny = thrown error), each
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
- **Draft skills** — a pack may ship a skill as `draft` (PACK.md §1): runnable, but not
  approved for production use. The gate allows it like any managed skill and adds a
  hook `systemMessage` on every invocation (Skill tool and direct `/slash`): "… is a
  DRAFT skill — not yet approved for production use; you run it at your own risk". The
  compiled skill body opens with the same notice as a banner the model prints first, so
  the warning reaches you on a harness that shows hook messages (claude-code) and on one
  that does not (the banner is the harness-neutral channel; enforcement strength differs
  per adapter and is recorded here, not hidden). Drafts are also listed by `status`, by
  `check` (a warning), in CLAUDE.md / AGENTS.md and on the panel, and flagged in the
  usage telemetry (`draft: true`).
- A gate invoked with the identity of a DISABLED harness (stale wiring) fails closed.
- **opencode capability mapping (recorded degradations, surfaced not hidden):** no
  blocking prompt hook exists, so there is NO prompt-time sweep — drifted core
  artifacts are caught at the first managed tool call instead of the first prompt (the
  invoke chokepoint is otherwise CLEANER: skills always run through the native `skill`
  tool, no /slash bypass). The session-start banner is best-effort (toast; headless
  `opencode run` delivers no session events to plugins at all — verified live). MCP
  tools are not `mcp__`-prefixed there: they are advertised as `<serverKey>_<tool>`
  (verified live against opencode 1.18.20), so lock-listed servers are recognized by
  serverKey prefix; a FOREIGN server's tools are not name-detectable, so strict-foreign MCP is
  enforced by the locked `opencode.json` (adding a server = editing it = core drift =
  deny) rather than by name. In strict mode the compiler ALSO renders a native
  `permission.skill` allowlist into `opencode.json` — the only adapter with a native
  permission surface today; defense in depth, the gate stays authoritative.
- Every managed invocation is recorded through the telemetry adapter (see §9) —
  LOCAL-ONLY daily files under `memory/telemetry/`; a missing adapter is a silent
  no-op, telemetry never breaks the gate.

An unreadable `taut.lock` blocks managed artifacts entirely — the lock is the only
trust root, and the gate would rather refuse than guess.

## 5. Keeping it current — the verbs

| Verb | What it changes | When |
|---|---|---|
| `status` | nothing (read-only) | "how far behind am I?" — pins vs HEADs, drift, MCP pins; exit 0 = ACTUAL |
| `check` | nothing but a telemetry line per live gate probe | "can work run HERE, NOW?" — integrity, live gate probes per harness, repos reachable, data files readable, memory writable, the KAUT binding when enabled, real MCP handshakes |
| `verify` | nothing (read-only) | "are the installed files still the ones I compiled?" — re-hashes every artifact against the lock; `--source` additionally re-derives the COPIED ones from the pinned commits (generated artifacts stay lock-checked) |
| `update` | re-pins engine + pack (recompile) | deliberate actualization; `--data-only` re-pins the pack alone (refuses when the core moved); an "all" skill selection auto-installs newly shipped skills. Skips the recompile only when BOTH pins are at HEAD, no artifact drifted, **and the pack tree is clean** — an uncommitted or non-git pack always recompiles, so freshly written pack content (repo descriptors, a dropped-in skill) installs instead of being reported "already current" |
| `repair` | restores drifted/deleted files (recompile from the workspace's own manifest) | healing after tampering or accidents; renders with the current engine tree |
| `apply` | toggles: `--enable/--disable-skill`, `--enable/--disable-mcp`, `--connect/--disconnect-repo`, `--enable/--disable-harness`, `--mode strict|normal`, `--telemetry basic|extended` | one deliberate recompile per batch; the panel's checklists ride this |
| `render` | nothing (read-only, no workspace needed) | compile-preview of ONE source on ONE harness: `render --skill <name> \| --agent <name> --harness <id> [--gates kaut=false,…] [--deployment <n>] --stdout\|--json` — the marker pass under the given gates plus the harness's agent render (Codex TOML / opencode md); `--json` adds the target path and the adapter's recorded degradations. Built for linters and studios (e.g. SAUT) that need the exact bytes the installer writes |
| `report` | nothing (read-only) | LOCAL aggregation of the workspace's telemetry files: sessions, actualization lag, usage by artifact, denials by cause, lifecycle chronology; `--since`/`--to`/`--json`. Prints only on this machine — sharing the output is a manual act |

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
adapters: Claude Code, Codex and opencode; adding a harness extends the engine, never the packs.

What each adapter does with a harness-neutral source is DATA, not prose:
`lib/harness-caps.mts` records, per harness, the target directories, what a skill's
`allowed-tools` means once installed there (Claude Code: a *grant* — it pre-approves, it
does not restrict; Codex/opencode: informational), what a subagent's `tools:` becomes
(Claude Code: a native allowlist; Codex: dropped on TOML render), how the gate reaches a
session, and the recorded degradations. The generated instructions render those sentences
from the table, `status --json` carries them under `degradations`, and `render --json`
returns them with the preview.

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
NEVER owns, rewrites or sweeps anything under it — the guarantee is structural (a
compile that tries to route an artifact there fails). Ticket runs write
`memory/spec/<TICKET>/`; telemetry appends under `memory/telemetry/`. The workspace
folder is disposable; the memory is not. Caveat: an IDE-side "discard changes" over the
workspace can still delete instance files the framework protects — treat agent-created
memory as data, not as reviewable diff noise.

**Telemetry (engine-owned; LOCAL-ONLY BY LAW).** All usage telemetry goes through ONE
adapter — `.taut/telemetry.mjs`, compiled next to the gate — into
`memory/telemetry/YYYY-MM-DD.jsonl`, one file per LOCAL day (the first line of each day
is a `meta` row with the build pins/mode/harnesses). Files stay on this computer and
are NEVER sent anywhere; there is no send mechanism by construction — sharing a file or
a `taut report` output is always your manual, deliberate act. No personal data is
collected: no prompt content, no tool arguments, no file paths, no machine/user/git
identities, no env values, and no repository names (repo toggles are recorded as
counts). Two levels, chosen at setup (default **extended**) and switchable any time
with `taut apply --telemetry basic|extended`:

- **basic** — the diagnostic minimum: errors, denials (with the artifact name and
  cause), prompt blocks, lifecycle events (setup/update/repair/apply/check with pin
  movements), and the per-session actualization lag.
- **extended** (default) — basic plus usage: allow-decisions per skill/agent/MCP and
  per-name apply detail — the data that lets `taut report` show what the toolchain
  actually does day to day.

A workspace compiled before telemetry existed adopts the default on its next
update/repair (surfaced in the output). Event completeness differs per harness hook
surface and is surfaced in `taut report`, never hidden. A pre-telemetry
`usage.jsonl` stays untouched; `report` still reads it.

**Both invocation paths are counted.** A skill can be reached two ways: the harness's
skill tool (the model decides) and a direct `/slash` (you decide). They arrive on
different hooks, and the slash path never touches the tool chokepoint — so a skill that
declares `disable-model-invocation: true` is reachable ONLY by slash. The gate records
each path and stamps the row with `via`. On the slash path it counts only what the
harness itself routed (its own `expansion_type`/`command_name` fields), never a name
matched in prompt text: the integrity check there is deliberately broad — erring toward
checking — and a counter must not inherit that breadth, or merely naming a skill would
register as using one. A harness that does not send routing fields records nothing on
this path rather than inventing a number. Rows the gate cannot name at all (sibling
tools caught by a partial hook matcher) are not written.

**Where a skill is invoked from differs per harness, and the gate follows.** A harness may
offer a skill tool, a `/slash`, both, or neither. Where it offers neither, a skill is
invoked by the model READING its `SKILL.md` — the harness lists the skills with their paths
and the model opens the one it needs, so the read IS the invocation and arrives as an
ordinary tool call. The gate records that too, stamped `via: 'read'`. That label matters:
a read is weaker evidence than an explicit call — a session auditing its own skills reads
them as well — and a reader who knows how a count was obtained can discount it. Detection
is recording only: a command is never denied because a skill path appears inside it, and
the detection is skipped entirely for tools that ARE skill or agent invocations, so it can
never become a way around the strict gate.

**Self-test rows are marked, never counted as use.** `taut check` proves the gate is
live by running it out of band against the first skill in the manifest. Those rows carry
`probe: true`; `taut report` excludes them from usage and friction and prints how many
it excluded. Files written before this existed are recognized by the reserved probe name
(`taut-check-foreign-probe`) and the same-second row beside it.

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
