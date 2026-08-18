#!/usr/bin/env node
// TAUT (Toolchain Actualization Under Trust) — distribution CLI entry: argv, help, dispatch.
// Zero RUNTIME dependencies, Node >= 24, ESM. Framework root = the directory of this
// file. This entry stays a thin PLAIN-JS shell (its name is baked into workspace `ui`
// launchers); the compiler under lib/ is TypeScript (.mts) executed natively by Node
// (type stripping — no build step); `tsc --noEmit` is the checker (npm test runs it).
//
// Module map (lib/ — the compiler; gate/*.mjs stay self-contained SHIPPED artifacts):
//   types.mts      the central data model: Cfg, Profile, Catalog, Lock, CliOpts, …
//   constants.mts  core data: framework root, data-pack seam, MCP catalog, owned keys
//   util.mts       hashing / fs probes / git info / fail / ANSI styling
//   tui.mts        interactive widgets: banner, askText, checklist picker
//   artifacts.mts  the flat artifact model: frontmatter parser, catalog, repo-map lint
//   markers.mts    capability-marker conditional compilation (gating pass)
//   config.mts     deployment profiles, repo scan, gatherConfig, cfgFromWorkspace
//   manifest.mts   per-harness model resolution, flow-doc selection, buildManifest
//   render.mts     generated artifacts: instructions, MCP configs, hooks, Codex TOML
//   install.mts    write/copy artifacts into the workspace + member-file scan
//   lock.mts       taut.lock + verify (--source re-derivation from the pin)
//   check.mts      readiness check: integrity, live gate probe, repos, MCP handshake
//   panel.mts      the acting loopback panel (serves lib/panel.html + JSON API)
//   commands.mts   setup / status / update / repair / verify / compileWorkspace
import process from 'node:process';

// Node floor guard BEFORE the .mts imports load (static imports would evaluate first
// and die with a cryptic ERR_UNKNOWN_FILE_EXTENSION on an old Node) — hence the
// dynamic imports below. Workspace artifacts (.taut/gate.mjs, mcp-launch.mjs) are
// plain JS and keep running on ANY Node — the floor applies to the COMPILER only.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 24) {
  process.stderr.write(`taut: Node >= 24 required to run the compiler (this is ${process.versions.node}) — `
    + 'the core is TypeScript executed natively by Node. Compiled workspaces themselves need no specific Node.\n');
  process.exit(1);
}

const { TautError, fail } = await import('./lib/util.mts');
const { cmdApply, cmdRepair, cmdRepoScaffold, cmdSetup, cmdStatus, cmdUpdate, cmdVerify } = await import('./lib/commands.mts');
const { cmdCheck } = await import('./lib/check.mts');
const { cmdPanel } = await import('./lib/panel.mts');

function parseArgs(argv) {
  const opts = { _: [], skillsOn: [], skillsOff: [], mcpOn: [], mcpOff: [], reposOn: [], reposOff: [], harnessOn: [], harnessOff: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--answers') opts.answers = argv[++i];
    else if (a === '--workspace') opts.workspace = argv[++i];
    else if (a === '--data') opts.data = argv[++i];
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--source') opts.source = true;
    else if (a === '--from-deployment') opts.fromDeployment = true;
    else if (a === '--data-only') opts.dataOnly = true;
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--enable-skill') opts.skillsOn.push(argv[++i]);
    else if (a === '--disable-skill') opts.skillsOff.push(argv[++i]);
    else if (a === '--enable-mcp') opts.mcpOn.push(argv[++i]);
    else if (a === '--disable-mcp') opts.mcpOff.push(argv[++i]);
    else if (a === '--connect-repo') opts.reposOn.push(argv[++i]);
    else if (a === '--disconnect-repo') opts.reposOff.push(argv[++i]);
    else if (a === '--enable-harness') opts.harnessOn.push(argv[++i]);
    else if (a === '--disable-harness') opts.harnessOff.push(argv[++i]);
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--chat-language') opts.chatLanguage = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

const HELP = `TAUT — Toolchain Actualization Under Trust — distribution CLI (v1 minimum)

Usage:
  taut.mjs setup  [--answers <file.json>] [--workspace <dir>] [--data <dir>] [--yes]
  taut.mjs status [--workspace <dir>] [--json]
  taut.mjs check  [--workspace <dir>] [--json]
  taut.mjs verify [--workspace <dir>] [--json] [--source]
  taut.mjs update [--workspace <dir>] [--from-deployment] [--data-only]
  taut.mjs repair [--workspace <dir>]
  taut.mjs apply  [--workspace <dir>] [--enable-skill <n>]... [--disable-skill <n>]...
                  [--enable-mcp <id>]... [--disable-mcp <id>]...
                  [--connect-repo <name|path>]... [--disconnect-repo <name>]...
                  [--enable-harness <h>]... [--disable-harness <h>]...
                  [--mode strict|normal] [--chat-language <code>]
  taut.mjs repo-scaffold [<repo>...] [--workspace <dir>] [--data <dir>]
  taut.mjs panel  [--workspace <dir>] [--port <n>]

CORE vs DATA (split 2026-08-15): this repo is the ENGINE only — content (skills, agents,
docs incl. LAWS.md, catalog/mcp.json, deployments + runbooks) lives in a DATA PACK repo.
The pack's home is the WORKSPACE SIBLING: a landscape root reads {repos…, <ws>,
<ws>-memory, taut-data} — one pack serves every workspace of that landscape. Resolution,
first hit wins: --data / answers "data" > the workspace's own .taut/local.json binding >
TAUT_DATA env > <workspace-parent>/taut-data (sibling) > ~/taut-data (global fallback) >
this repo (pre-split layout) > taut-data/ (the bundled example pack). The chosen pack is
recorded in local.json and PINNED in taut.lock next to the framework pin — status/update
judge BOTH axes.

setup   Compile a workspace from the FLAT ARTIFACT MODEL (no flow entity). The core
        (this CLI) does distribution, actualization and integrity over SIX element kinds:
          - skills/<name>/SKILL.md — each declares its own wiring in frontmatter
            metadata.taut: {agents, requires: [atlas], repos, role; mcp: [roles]
            is documentary — the docs gate follows the INSTALLED servers}
          - agents/<name>.md — installed only when a selected skill names them
          - MCP servers — catalog/mcp.json (role, package pin, env, usage note)
          - runbooks — <project>/runbooks/*.md in the pack (frontmatter = index values,
            body = the recipe an agent reads); indexed in the manifest, installed to
            .taut/runbooks/
          - flow DOCUMENTS — docs/FLOW-*.md (frontmatter sequence): a flow is nothing
            but a documented launch order over installed skills; installed to
            .taut/docs/ when its sequence touches an installed skill
          - the REPO MAP — deployment repos{mandatory,known} + per-artifact repos:
            bindings, LINTED at compile (unknown repo = error; unconnected repo =
            artifact excluded with a warning, never silently dead)
        DEPLOYMENT CONFIG (per project): a PROJECT FOLDER at the pack root —
        <name>/deployment.json (+ optional skills/, runbooks/) — structural
        keys name/description/repos{mandatory,known}; everything under its "manifest"
        bag passes VERBATIM into the generated manifest.json (compiler-owned keys
        protected; flow.* merges around computed stages). docs/LAWS.md is a CORE
        document — every workspace ships it as .taut/LAWS.md.
        Selection of a deployment config is REQUIRED when configs exist; a single config
        is auto-selected and cannot be deselected; its mandatory repos are LOCKED in the
        repo checklist. Skills are a flat checklist over the whole catalog. Interactive
        checklists (↑/↓ · space · a · enter); member repos auto-SCANNED from the
        workspace's parent root; repos unknown to the config are unchecked / excluded in
        scan mode. Never writes into member repos.
        Non-interactive: --yes with full --answers (deployment: <name> | "none" — the
        explicit service escape; repos: path list or "scan"; harnesses: any subset of
        the supported set ["claude-code","codex"] (legacy scalar "harness" accepted); atlas: the
        Atlas engine folder to integrate — the value IS the location, recorded in
        .taut/local.json and rendered into the instructions; omitted/false = DISABLED,
        the default (leave it out if you do not know what Atlas is), and a bare true
        fails: an enabled Atlas always carries its folder; chatLanguage: the session
        language code — accepted ONLY when the deployment declares a choice via
        defaults.languages.chat = {options[], default}; without the key the declared
        default applies, and a deployment with a FLAT chat value asks nothing and
        accepts no override).
status  The actualization check, one screen: framework pin vs HEAD (behind by how much,
        what changed), integrity vs the lock (lock-clean = settings-conformant — the
        manifest itself is a locked artifact), canonical flag, MCP pins vs the catalog.
        Exit 0 = ACTUAL. --json is the machine contract (the panel reads this).
check   READINESS check (status answers "am I current?", check answers "can practical
        work run HERE, NOW?"): artifact integrity, a LIVE gate self-test (managed skill
        allowed; in strict a foreign probe must be denied), every member repo reachable
        + git-readable (branch/dirty reported), every shipped data file readable
        (runbooks, repo descriptors, laws, flow docs), memory writable, the Atlas
        engine binding when Atlas is enabled (atlasRoot still points at an engine;
        live store proofs stay with the check skill), and a REAL MCP
        handshake (JSON-RPC initialize over stdio, env resolved from .taut/local.env)
        against every allowed server. Works without the framework/pack repos present —
        a pure workspace self-test. Exit 0 = READY. The panel's "Check" button runs
        this; the deployment's check skill runs it first, then adds the agent-side
        proofs (live MCP tool calls, Atlas lookups) that only a session can perform.
verify  Re-hash installed artifacts against taut.lock (exit 1 on drift). --source
        additionally re-derives copy artifacts from the PINNED framework commit (catches
        lock tampering).
update  Deliberate ACTUALIZATION (update != repair): recompile at the current framework
        HEAD with the workspace's own settings preserved, printing the pin-move changelog.
        A workspace set up with ALL skills follows the new version's payload — newly
        shipped skills/agents are installed, dropped ones removed (their files swept); a
        custom selection stays fixed and new skills are only advertised.
        A workspace compiled by the pre-rename FEDERATION framework is MIGRATED in place
        on its first update/repair/apply: .federation/ becomes .taut/, federation.lock
        becomes taut.lock, instance files (local.json, local.env) move untouched.
        --from-deployment additionally refreshes the manifest's profile blocks from the
        CURRENT <name>/deployment.json (factory-settings refresh).
        --data-only re-pins the DATA PACK alone — the everyday actualization: new pack
        skills / docs / repo descriptors flow in ("all" selections auto-install new
        content skills) while the core pin stays put. It REFUSES when the framework
        core itself moved: a recompile always renders with the CURRENT core tree, so a
        data-only update would silently re-pin the core too — run a full update then.
        The panel exposes both as separate buttons (Update workspace / Update data),
        plus "Refresh deployment" (--from-deployment) — the VALUES channel: profile
        blocks re-enter the manifest only through it, a plain update preserves them.
repair  HEALING (repair != update): recompile the workspace from its own manifest.json +
        local binding (no answers file needed) — restores drifted/deleted artifacts and
        the integrity gate. Note: rendering uses the current framework tree; when the
        framework moved since the pin, repair reports that it also updated.
apply   Deliberate per-artifact TOGGLES on an existing workspace, ONE recompile through
        the same chokepoint as setup: disabling a skill sweeps its files and orphaned
        agents; toggling an MCP server recompiles every artifact's capability branches
        (a removed docs role leaves no dead tool names; the last server removed sweeps
        .mcp.json). Under an "all" selection a disabled skill lands in skillsExcluded —
        "all minus exclusions": update keeps auto-installing NEW skills but never
        resurrects an excluded one; re-enabling clears the exclusion.
        REPO toggles (the panel's repo checklist): --disconnect-repo removes a member
        repo from the workspace — its descriptors are swept, repo-bound runbooks/skills/
        wrappers leave, manifest + local.json rows go (deployment-mandatory repos are
        locked); --connect-repo adds one (a bare name resolves in the workspace-parent
        root; a path is taken as-is) — its descriptors install, and a KNOWN repo the pack
        does not cover first gets a skeleton scaffolded into the pack (add ⇒ a descriptor
        exists; fill it by the embedded brief, then commit the pack). The member repo
        itself is never touched either way.
        HARNESS toggles: --enable-harness / --disable-harness (claude-code, codex)
        switch whole native toolchains on an existing workspace WITHOUT a re-setup:
        enabling renders that harness's full set (skills tree, agents, instructions
        file, MCP + gate hook wiring) next to the others — the trees are disjoint, so
        they coexist; disabling sweeps the set. At least one harness stays enabled;
        answers, secrets and selections survive either way. The panel exposes the same
        as per-harness switches. A disabled harness is UNPROVISIONED (no instructions,
        no gate) — the gate additionally fail-closes stale wiring that still carries a
        disabled harness's identity.
        WORKSPACE MODE (--mode, stage 3): "strict" = only the compiled toolchain runs —
        the gate DENIES foreign skills (any name outside taut.lock, wherever the skill
        lives), foreign workspace-file-backed agents (harness built-in subagent types
        stay allowed), and — on claude-code via a widened PreToolUse matcher, on Codex
        via its always-broad hooks — calls to MCP servers outside the workspace
        manifest. "normal" (default) = today's behavior: framework artifacts coexist
        with the user's own, the gate only guards what it manages. The mode is chosen
        at setup (answers "mode", or the deployment's own "mode" field), recorded in
        manifest + lock, shown in the panel, and switched by this flag — deliberately
        SOFT: any recompile can change it visibly (lock/manifest diff is the audit
        trail); it disciplines sessions, it is not an anti-owner lockout. Built-in
        harness tools (Bash, Read, WebSearch, …) are never gated — mode governs
        ARTIFACTS, not the harness.
        SESSION LANGUAGE (--chat-language): valid only when the deployment declares a
        choice (defaults.languages.chat = {options[], default} — asked once at setup);
        one recompile re-renders the instructions and the flat manifest value. A
        deployment that fixes the language (flat value) never asks and cannot be
        overridden here. The flat value "auto" is the adaptive variant: the generated
        instructions tell the session to MIRROR the language the developer writes in
        (pasted data never switches it) — nothing to configure, nothing to override.
repo-scaffold  AUTO-INIT of missing repo descriptors (the pack is checked first —
        initialization happens only for what does not exist). Repo descriptors are
        per-repo working knowledge shipped from the pack's <project>/repos/<repo>/*.md
        into the workspace as .taut/repos/<repo>/ (the member repo itself stays
        untouched; workspace descriptors take precedence over repo-internal instruction
        files — L9). setup/update flag connected repos the pack does not cover; this
        command writes a SKELETON descriptor with an embedded distillation brief INTO
        THE DATA PACK for each uncovered connected repo (or only the repos named as
        arguments). An agent then fills the skeleton by READ-ONLY analysis per the
        brief, the owner commits the pack, and update/repair installs the result.
        Existing files are never overwritten; a filled pack makes this a no-op.
panel   The ACTING local panel (D3): loopback-only web UI over the same core — status
        badges (pin vs HEAD, drift, canonicality), Repair/Update buttons, HARNESS +
        skill + MCP +
        REPO checkboxes applied as ONE batch recompile with a pending-diff preview (the
        repo checklist connects/disconnects member repos: mandatory repos locked, a
        disconnect sweeps the repo's workspace data, an add installs its descriptors —
        scaffolding a pack skeleton first when none exist). Reads are
        in-process; actions run this CLI and stream its output as the log. Mutations
        need a per-session token + Origin check (drive-by-localhost hardened); secrets
        render as env-var names + filled/empty only — values never reach the page.
        Every compiled workspace also carries a "ui" launcher: from the workspace
        folder "node ui" opens its panel, "node ui <command>" scopes any command here.

The compiled workspace carries a HARD integrity gate (harness hooks + .taut/gate.mjs):
a manually edited managed skill/agent is BLOCKED at invocation; core-artifact
drift blocks prompts; every managed invocation is logged to memory/telemetry/usage.jsonl.

Memory lives OUTSIDE the workspace: setup creates the sibling folder <workspace>-memory
and links it into the workspace as memory/ (a symlink) — ticket memory, agent reports
and telemetry are INSTANCE data the framework never writes, rewrites, or deletes. The
workspace folder is disposable: delete it and recompile — memory survives untouched and
is re-linked. A legacy IN-workspace memory/ directory is migrated by a single rename on
the next compile (both layouts present = refusal, never a silent merge). As tickets
accumulate, memory/spec/ doubles as the deployment's execution history — agents consult
past ticket folders read-only as prior art.

Docs: README.md (overview + quickstart) · docs/TUTORIAL.md (build your first pack) ·
docs/HANDBOOK.md (using compiled workspaces) · docs/PACK.md (authoring reference) ·
taut-data/ (the example pack: the react-demo tutorial project).
`;

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._[0];
try {
  if (opts.help || !cmd) { process.stdout.write(HELP); process.exit(cmd ? 0 : 1); }
  else if (cmd === 'setup') await cmdSetup(opts);
  else if (cmd === 'status') await cmdStatus(opts);
  else if (cmd === 'check') await cmdCheck(opts);
  else if (cmd === 'verify') await cmdVerify(opts);
  else if (cmd === 'update') await cmdUpdate(opts);
  else if (cmd === 'repair') await cmdRepair(opts);
  else if (cmd === 'apply') await cmdApply(opts);
  else if (cmd === 'repo-scaffold') await cmdRepoScaffold(opts);
  else if (cmd === 'panel') await cmdPanel(opts);
  else fail(`unknown command "${cmd}" (see --help)`);
} catch (e) {
  if (e instanceof TautError) { process.stderr.write(`taut: ${e.message}\n`); process.exit(1); }
  throw e;
}
