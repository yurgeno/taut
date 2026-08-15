# Security policy

TAUT ships an enforcement surface, not just a build tool: a fail-closed integrity gate
wired into harness hooks, hash-locked artifacts, and a loopback control panel behind a
token guard. Bugs in those are security bugs.

## Reporting a vulnerability

Report privately through GitHub's **Report a vulnerability** button (Security tab of
this repository) — please do not open a public issue for anything exploitable. Include
what you did, what happened, and the commit you saw it on. Expect an acknowledgement
within a few days; this is a solo-maintained project, so fixes land as fast as one
person can verify them.

## What is in scope

- **Gate bypass** — invoking a managed skill or subagent whose file was edited outside
  the pipeline, or getting a drifted core artifact past the prompt-time sweep.
- **Strict-mode escape** — running a foreign skill, a workspace-file-backed agent, or an
  unlisted MCP server in a strict workspace.
- **Panel** — anything reachable without the token, a non-loopback bind, or an action
  that escapes the `apply`/`update` command surface.
- **Secret exposure** — any path where a value from `.taut/local.env` reaches stdout,
  the page, telemetry, or a committed artifact (names and filled/empty are fine).
- **Compile-time escape** — a data pack that writes outside the workspace, overwrites
  instance data (`memory/`, `local.json`, `local.env`), or smuggles content past the
  capability-marker pass.

## What is not

- A data pack instructing an agent to do something harmful: packs are trusted input,
  the same as the code you point the toolchain at. Review the packs you install.
- Anything requiring an attacker who can already write to the workspace, the pack repo,
  or the engine checkout — that is game over by construction, and the lock is designed
  to make it *visible*, not to prevent it.
- The harness's own model behaviour.

## Supported versions

The tip of `master` is the supported version. Workspaces pin engine and pack commits in
`taut.lock`; `taut status` tells you how far behind a workspace is, and `taut update`
re-pins it deliberately.
