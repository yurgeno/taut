# TAUT — Toolchain Actualization Under Trust

[![test](https://github.com/yurgeno/taut/actions/workflows/test.yml/badge.svg)](https://github.com/yurgeno/taut/actions/workflows/test.yml)

Compile, actualize and guard **agent workspaces**: turn versioned sources (skills,
subagents, laws, runbooks, per-repo knowledge, MCP pins, model profiles) into a
ready-to-work folder for your agent harness — hash-locked, runtime-guarded, and
deliberately updatable. TAUT is harness-agnostic: sources are authored once,
harness-neutral, and compiled per harness through adapters — currently
[Claude Code](https://code.claude.com) and
[Codex](https://developers.openai.com/codex), with the set designed to grow.

Zero runtime dependencies. The compiler is TypeScript executed natively by Node ≥ 24
(type stripping — no build step); compiled workspaces themselves run on any Node.

## Why

Hand-assembled agent setups rot in every direction at once: skills drift from their
sources, instance values leak into generic prompts, nobody can say which version of the
toolchain a session actually ran, and "just edit the file" silently defeats whatever
discipline the team agreed on. TAUT treats the workspace as a **build artifact**:

- **Compiled, never hand-edited.** `taut setup` renders everything from two versioned
  inputs — the engine (this repo) and a content **data pack** — and records both commits
  in `taut.lock` next to a sha256 for every installed file.
- **Guarded at runtime.** A self-contained gate script wires into the harness's hooks:
  a managed skill or agent that was edited outside the pipeline is **blocked at
  invocation** (fail-closed), core drift blocks prompts, and every managed invocation is
  logged to instance telemetry.
- **Actualized deliberately.** `status` tells you exactly how far the engine and the
  pack have moved past the workspace's pins; `update` re-pins on purpose; `repair`
  heals drift; nothing updates by accident.
- **Generic core, values in the pack.** The engine ships no content and hardcodes no
  instance names. Everything project-specific — repo maps, laws, ticket patterns, model
  ladders, runbooks — lives in the pack as VALUES and derives parametrically.

## Features

- **Multi-harness.** Harnesses are pluggable adapters over the same harness-neutral
  sources; one workspace can carry several toolchains side by side, each through its
  harness's native mechanisms — the per-harness trees are disjoint by construction
  (today: `.claude/*` + `CLAUDE.md` + `.mcp.json` for Claude Code, `.agents/skills`
  + `.codex/*` + `AGENTS.md` for Codex). Enable any subset; switch from the panel
  without a re-setup; secrets, selections and memory survive every toggle.
- **Model profiles.** The pack declares a model ladder (per-harness model, effort,
  context variant, use-when) plus the tier the orchestrator session runs on. The
  compiler enforces it through each harness's own config surface
  (`.claude/settings.json` `model`/`effortLevel` — workspace settings beat user
  defaults; `.codex/config.toml` `model`/`model_reasoning_effort`), renders a Model
  policy section into the instructions, and the gate advises when a live session
  deviates from the pin.
- **Strict mode.** Optionally, only the compiled toolchain runs: foreign skills,
  workspace-file-backed agents and unlisted MCP servers are denied at invocation
  (harness built-ins stay untouched).
- **Capability markers.** Sources carry conditional branches (`<!-- atlas:on -->` …)
  compiled per workspace, so a workspace never receives directives — or tool
  allowlists — for capabilities it does not have.
- **Acting panel.** `node ui` opens a loopback web panel: status badges, harness
  switches, skill/MCP/repo checklists applied as one batched recompile, update/repair
  buttons, read-only docs and instance-memory browsers. Everything explains itself on
  hover.
- **Memory outside the workspace.** Instance data (ticket memory, telemetry) lives in a
  sibling folder symlinked in; the workspace is disposable — delete and recompile, the
  memory survives.
- **MCP without ceremony.** Servers launch through a workspace launcher that reads
  `.taut/local.env` itself — developers fill one file, export nothing.

## Quickstart

Requires Node ≥ 24 (for the compiler only).

```bash
git clone https://github.com/yurgeno/taut.git
cd taut
node taut.mjs setup
```

The interactive setup resolves the bundled example pack (`taut-data/` — the
`react-demo` tutorial project). Two things to know before you answer: **member repos are
scanned from the workspace folder's PARENT**, and at least one must be selected — so put
the workspace next to your repos. The example's one mapped repo is fictional, so stub it:

```bash
mkdir -p ~/react-land && git init -q ~/react-land/react-app
# then answer the workspace question with: ~/react-land/ws
```

Setup then asks (in order): data pack, deployment, workspace folder, member repos,
harness(es), Atlas (say `disable` unless you know what it is), mode, skills, MCP servers
— and compiles. Open the compiled workspace folder with your harness and work; from that
folder:

```bash
node ui          # the acting panel
node ui status   # actualization check: pins vs HEADs, integrity, MCP pins
node ui check    # readiness self-test: integrity, live gate probe, repos, MCP handshakes
```

To run on your own content, author a data pack (start from `taut-data/`, see
[docs/PACK.md](docs/PACK.md)) and keep it as `taut-data` next to your workspace — or
pass `--data <path>`.

Working on TAUT itself additionally needs the dev dependencies (a typechecker — the
compiler ships none at runtime):

```bash
npm install && npm test
```

## Documentation

| Where | What |
|---|---|
| [docs/TUTORIAL.md](docs/TUTORIAL.md) | **start here to run TAUT on your own project** — builds a complete pack file by file (the `taut-data/react-demo/` project: a three-stage flow for a React SPA, agents, model profiles, a runbook, per-repo knowledge, context7) |
| [docs/HANDBOOK.md](docs/HANDBOOK.md) | using TAUT: setup, workspace anatomy, the lock and the gate, update vs repair vs apply, the panel, strict mode, multi-harness, model profiles, memory |
| [docs/PACK.md](docs/PACK.md) | authoring data packs: every element kind, frontmatter wiring, capability markers, deployment configs, model ladders, runbooks, repo descriptors |
| [taut-data/README.md](taut-data/README.md) | the example pack (the `react-demo` tutorial project) — also the out-of-the-box fallback; an end-to-end test compiles it on every `npm test` |
| `node taut.mjs --help` | the full command reference |

## Repo map

| Path | Role |
|---|---|
| `taut.mjs` | CLI entry (plain-JS shell: argv, help, dispatch; Node-floor guard) |
| `lib/*.mts` | the compiler — TypeScript run natively by Node; `tsc --noEmit` is the checker |
| `gate/gate.mjs` | the SHIPPED integrity gate (self-contained plain JS — runs on any workspace Node) |
| `gate/mcp-launch.mjs` | the SHIPPED MCP launcher (reads `.taut/local.env` at server start) |
| `taut-data/` | the example data pack (the `react-demo` tutorial project) — resolver fallback, compiled by an e2e test |
| `test/` | `node --test` suites, each in its own sandbox; `npm test` = typecheck + suite |

## Security

TAUT ships an enforcement surface (integrity gate, strict mode, the panel's token
guard). Found a hole in it? [SECURITY.md](SECURITY.md) — report privately, please.

## License

[Apache-2.0](LICENSE) © Yuriy Orlov
