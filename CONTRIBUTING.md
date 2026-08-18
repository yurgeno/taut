# Contributing to TAUT

Thanks for looking under the hood. This file covers the dev setup and the few rules
that keep the engine what it is.

## Dev setup

```bash
git clone https://github.com/yurgeno/taut.git
cd taut
npm install        # dev dependencies only: typescript + @types/node
npm test           # tsc --noEmit && node --test
```

Node ≥ 24 is required: the compiler is TypeScript executed natively via type stripping,
`tsc` is only the checker. Linux and macOS are the only supported platforms —
development, CI and the test suite run and are verified on these two; Windows is not
supported. Every test suite builds its own sandbox (temp workspaces,
throwaway git repos), so the suite runs from any checkout and leaves nothing behind.

## Ground rules

- **Zero runtime dependencies is a feature, not an accident.** The engine, the shipped
  gate (`gate/gate.mjs`) and the MCP launcher (`gate/mcp-launch.mjs`) run on plain Node.
  A PR that adds a runtime dependency needs an exceptional case; "convenient" is not one.
- **The engine ships no content.** Nothing project- or instance-specific belongs in
  `lib/` — project material lives in data packs (see
  [docs/PACK.md](docs/PACK.md)). If your change hardcodes a name a pack should own,
  it is in the wrong repository.
- **Sources are harness-neutral; harnesses are adapters.** The supported set lives in
  `lib/constants.mts` (`HARNESSES`) and every per-harness surface derives from it.
  Adapter PRs for additional harnesses are welcome — map capabilities explicitly and
  surface any degradation, don't author to a lowest common denominator.
- **The gate and the panel are an enforcement surface.** Changes to `gate/`,
  strict mode, or the panel's token guard get extra scrutiny; if you found a way
  *around* them, that is a vulnerability — report it privately per
  [SECURITY.md](SECURITY.md) instead of opening a PR.
- **Behavior changes come with tests**, and `npm test` stays green.
- **Commit messages in English**, stating the user-visible effect.

## Where things go

| Change | Belongs in |
|---|---|
| Compiler, lock, gate, panel, CLI | this repository (`lib/`, `gate/`, `taut.mjs`) |
| Skills, agents, laws, runbooks, deployment values | a data pack — start from [docs/PACK.md](docs/PACK.md) |
| The bundled example pack / tutorial | `taut-data/` here (it is compiled by an e2e test on every `npm test`) |
| Docs | `docs/` — update them in the same PR as the behavior they describe |

## Reporting

Bugs and feature requests: use the issue templates. Security issues: privately, per
[SECURITY.md](SECURITY.md).
