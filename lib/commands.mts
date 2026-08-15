// TAUT compiler — the CLI commands: setup (gather → compile), repair (reconstruct
// from the workspace's own manifest → compile), verify, status/update (the actualization
// axis: is the workspace CURRENT vs the framework, and the deliberate re-pin), and the
// shared compileWorkspace step (install + local binding + lock + summary).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';

import { FW_ROOT, HARNESSES, MCP_CATALOG, initData, initDataFor, initProject, requireData, resolveDataRoot } from './constants.mts';
import { bold, dim, exists, expandHome, fail, gitInfo, gitInfoOwn, green, isCommit, readIfExists, red, safeJoin, sha256, yellow } from './util.mts';
import { atlasRequired, neededAgents } from './artifacts.mts';
import { askText, banner } from './tui.mts';
import { cfgFromWorkspace, gatherConfig, isConductorDir, listDeployments, normalizeHarnesses, relintRepoBindings } from './config.mts';
import { install, memoryRootFor, migrateLegacyLayout, scanMemberInstructionFiles } from './install.mts';
import { verify, writeLock } from './lock.mts';
import { scaffoldDescriptor } from './render.mts';
import type { Cfg, CliOpts, Lock, RepoDelta, StatusData } from './types.mts';

export async function cmdSetup(opts: CliOpts): Promise<void> {
  const interactive = !opts.yes && process.stdin.isTTY === true;
  const answers = opts.answers ? JSON.parse(await fs.readFile(opts.answers, 'utf8')) : {};
  if (opts.workspace) answers.workspace = opts.workspace;
  if (interactive) banner('setup');
  // Data pack first (core/data split): everything below reads content from it. The
  // chain default is shown interactively and can be overridden in place. The workspace
  // path (when already known — answers/flag) feeds the SIBLING rung of the chain.
  let dataRoot = await resolveDataRoot({
    explicit: opts.data ?? answers.data ?? null,
    ws: answers.workspace ?? opts.workspace ?? null,
  });
  if (interactive) {
    const a = (await askText('Data pack (skills/agents/docs/catalog source)', dataRoot)).trim();
    dataRoot = path.resolve(expandHome(a || dataRoot));
  }
  if (!await exists(dataRoot)) fail(`data pack not found: ${dataRoot}`);
  initData(dataRoot);
  const cfg = await gatherConfig(answers, interactive);

  const wsExisting = await exists(cfg.workspace) && (await fs.readdir(cfg.workspace)).length > 0;
  if (wsExisting && interactive) {
    const a = (await askText(`${cfg.workspace} is not empty — write framework-owned files into it? [Y/n]`, 'Y')).toLowerCase();
    if (a.startsWith('n')) fail('aborted by user');
  }
  if (interactive) {
    const a = (await askText(`Install ${cfg.skills.length} skill(s), ${neededAgents(cfg.skills, cfg.catalog).length} agent(s), ${cfg.mcp.length} MCP server(s) into ${cfg.workspace}? [Y/n]`, 'Y')).toLowerCase();
    if (a.startsWith('n')) fail('aborted by user');
    process.stdout.write('\n');
  }

  await compileWorkspace(cfg);
}

export async function compileWorkspace(cfg: Cfg, { verb = 'compiled' }: { verb?: string } = {}): Promise<void> {
  // Pre-rename FEDERATION workspaces migrate in place on their first recompile: the old
  // lock is read as the sweep source, instance files move .federation/ → .taut/, and the
  // legacy layout is swept below like any renamed payload.
  const migrated = await migrateLegacyLayout(cfg.workspace);
  const oldLock = await readLock(cfg.workspace);
  const artifacts = await install(cfg);
  const memberFiles = await scanMemberInstructionFiles(cfg);

  // Sweep artifacts WE previously installed that this build no longer produces (a skill
  // dropped by an update, an atlas-flag change, a renamed payload, a flow doc / runbook
  // that left the set, an .mcp.json whose last server was disabled — a lingering MCP
  // config would keep servers alive unmanaged). Only ids from the old lock are touched —
  // files the framework never wrote are not ours to delete.
  const newIds = new Set(artifacts.map((a) => a.id));
  const PAYLOAD = /^(\.claude\/skills|\.claude\/agents|\.agents\/skills|\.codex\/agents|\.taut\/docs|\.taut\/runbooks|\.taut\/repos)\//;
  // Legacy pre-rename layout: every framework-owned id lived under .federation/ — swept
  // wholesale on migration (instance files local.json/local.env never carry lock ids,
  // and they were moved to .taut/ above before this point).
  const LEGACY = /^\.federation\//;
  // Per-harness ROOT files join the sweep so disabling a harness removes its whole
  // toolchain (instructions, hook wiring, MCP config), not just the payload trees.
  const HARNESS_ROOT = new Set(['CLAUDE.md', 'AGENTS.md', '.claude/settings.json', '.codex/config.toml']);
  const sweepable = (id: string) => PAYLOAD.test(id) || LEGACY.test(id) || HARNESS_ROOT.has(id)
    || id === '.mcp.json' || id === 'ui' || id === '.taut/mcp-servers.json' || id === '.taut/mcp-launch.mjs';
  const removed: string[] = [];
  for (const a of (oldLock?.artifacts ?? [])) {
    // Belt to the PAYLOAD regex: instance data is NEVER swept, whatever a lock claims.
    if (!sweepable(a.id) || newIds.has(a.id) || a.id.startsWith('memory/')) continue;
    // A tampered lock id must not aim the recursive rm outside the workspace.
    const target = safeJoin(cfg.workspace, a.id);
    if (!target) continue;
    if (/\/skills\//.test(a.id)) await fs.rm(path.dirname(target), { recursive: true, force: true });
    else await fs.rm(target, { force: true });
    removed.push(a.id);
  }
  // A disconnected repo's descriptor folder must not linger empty (rmdir is a no-op
  // while any file — swept or not — still lives there).
  for (const id of removed)
    if (id.startsWith('.taut/repos/'))
      await fs.rmdir(path.dirname(path.join(cfg.workspace, id))).catch(() => {});
  // A disabled harness must not leave empty tree skeletons behind (children before
  // parents; rmdir no-ops on non-empty dirs, so anything user-owned keeps its dir).
  if (removed.length)
    for (const d of ['.agents/skills', '.agents', '.codex/agents', '.codex', '.claude/skills', '.claude/agents', '.claude'])
      await fs.rmdir(path.join(cfg.workspace, d)).catch(() => {});
  if (migrated) // rmdir only succeeds on now-empty legacy dirs — anything user-owned stays
    for (const d of ['.federation/docs', '.federation/runbooks', '.federation'])
      await fs.rmdir(path.join(cfg.workspace, d)).catch(() => {});

  await fs.mkdir(path.join(cfg.workspace, '.taut'), { recursive: true });
  await fs.writeFile(path.join(cfg.workspace, '.taut', 'local.json'), JSON.stringify({
    workspace: cfg.workspace,
    memoryRoot: memoryRootFor(cfg.workspace),
    frameworkRoot: FW_ROOT,
    dataRoot: requireData(),
    ...(cfg.atlas && cfg.atlasRoot ? { atlasRoot: cfg.atlasRoot } : {}),
    repoPaths: Object.fromEntries(cfg.repos.map((r) => [r.name, r.path])),
    memberInstructionFiles: memberFiles,
  }, null, 2) + '\n');

  const lock = await writeLock(cfg, artifacts);

  const p = (s: string) => process.stdout.write(s + '\n');
  p('');
  p(`${green('✔')} ${bold(`TAUT workspace ${verb}`)} ${dim('·')} ${cfg.workspace}`);
  const fw = `${lock.framework.commit?.slice(0, 7) ?? 'no-git'}${lock.framework.canonical ? '' : ` ${yellow('(NON-CANONICAL: dirty tree)')}`}`;
  const dt = `${lock.data?.pack ? `${lock.data.pack} ` : ''}${lock.data?.commit?.slice(0, 7) ?? 'no-git'}${lock.data?.canonical !== false ? '' : ` ${yellow('(NON-CANONICAL: dirty tree)')}`}`;
  p(`  ${dim('harness')}   ${cfg.harnesses.join(' + ')}   ${dim('mode')} ${cfg.mode === 'strict' ? bold('STRICT') : 'normal'}   ${dim('atlas')} ${cfg.atlas ? (cfg.atlasRoot ? `enabled · ${cfg.atlasRoot}` : 'enabled') : 'disabled'}   ${dim('deployment')} ${cfg.profile?.name ?? 'generic'}   ${dim('framework')} ${fw}`);
  p(`  ${dim('data')}      ${dt} ${dim(`· ${requireData()}`)}`);
  p(`  ${dim('skills')}    ${cfg.skills.length} ${dim(`· ${cfg.skills.join(', ')}`)}`);
  p(`  ${dim('agents')}    ${neededAgents(cfg.skills, cfg.catalog).length}`);
  if ((cfg.runbooks ?? []).length) p(`  ${dim('runbooks')}  ${cfg.runbooks!.length} ${dim(`· ${cfg.runbooks!.map((r) => r.name).join(', ')}`)}`);
  const repoDocFiles = artifacts.filter((a) => a.id.startsWith('.taut/repos/'));
  if (repoDocFiles.length) {
    const covered = [...new Set(repoDocFiles.map((a) => a.id.split('/')[2]))];
    p(`  ${dim('repo docs')} ${repoDocFiles.length} file(s) across ${covered.length} repo(s) ${dim(`· ${covered.join(', ')}`)}`);
  }
  // Auto-init flag: connected repos the pack does not cover — project mode only
  // (repo descriptors are project-scoped; `deployment: none` has no repos/ home).
  const noDocs = cfg.profile?.dir
    ? cfg.repos.map((r) => r.name).filter((n) => !cfg.catalog.repoDocs.has(n))
    : [];
  if (noDocs.length)
    p(`  ${dim('repo docs')} ${yellow(`no descriptors for ${noDocs.length} repo(s):`)} ${noDocs.join(', ')} ${dim('· auto-init: node ui repo-scaffold')}`);
  p(`  ${dim('mcp')}       ${cfg.mcp.length ? cfg.mcp.map((id) => `${id}${dim(`@${MCP_CATALOG[id].pin}`)}`).join(', ') : 'none'}`);
  if (removed.length) p(`  ${dim('removed')}   ${removed.length} stale artifact(s) ${dim(`· ${removed.join(', ')}`)}`);
  p(`  ${dim('memory')}    ${memoryRootFor(cfg.workspace)} ${dim('· instance data, never touched; workspace memory/ is a symlink')}`);
  p(`  ${dim('repos')}     ${cfg.repos.length} ${dim(`· ${cfg.repos.map((r) => r.name).join(', ')}`)}`);
  for (const h of cfg.harnesses)
    p(`  ${dim('gate')}      ${green('ACTIVE')} ${dim(h === 'codex'
      ? '· codex: PreToolUse + prompt sweep + session banner (.codex/config.toml hooks)'
      : '· claude-code: PreToolUse(Skill|Agent) + /skill expansion + prompt sweep + session banner')}`);
  for (const w of [...(cfg.warnings ?? []), ...(cfg.lintWarnings ?? [])]) p(`  ${yellow('warning:')} ${w}`);
  if (memberFiles.length) {
    const repoCount = new Set(memberFiles.map((c) => c.repo)).size;
    p(`  ${dim('member files')} ${memberFiles.length} instruction file(s) across ${repoCount} repo(s) ${dim('· inventory: .taut/local.json')}`);
    p(`  ${dim('precedence law: workspace-launched tasks follow workspace laws; repo-launched follow the repo; member files are never modified')}`);
  }
  p(`\nNext steps:`);
  let stepNo = 0;
  if (cfg.mcp.length) {
    p(`  ${++stepNo}. Fill secrets in .taut/local.env (placeholders written; values never enter canon).`);
    p(`     Nothing to export: MCP servers launch through .taut/mcp-launch.mjs, which reads`);
    p(`     the file itself — after filling, just (re)start the harness or reconnect MCP.`);
    if (cfg.harnesses.includes('claude-code')) p(`  ${++stepNo}. On first open, approve the workspace .mcp.json servers.`);
    if (cfg.harnesses.includes('codex')) p(`  ${++stepNo}. TRUST the project on first Codex open (loads .codex/config.toml MCP + project artifacts).`);
  }
  p(`  ${++stepNo}. Open the workspace with ${cfg.harnesses.join(' or ')} and run the flow (stage skills).`);
  p(`  From the workspace folder: ${bold('node ui')} opens the panel · ${bold('node ui verify')} / ${bold('node ui status')} / any command, scoped here.`);
}

export async function cmdVerify(opts: CliOpts): Promise<void> {
  const ws = path.resolve(expandHome(opts.workspace ?? process.cwd()));
  const ok = await verify(ws, { json: opts.json, source: opts.source });
  process.exit(ok ? 0 : 1);
}

export async function cmdRepair(opts: CliOpts): Promise<void> {
  const ws = path.resolve(expandHome(opts.workspace ?? process.cwd()));
  if (!await exists(path.join(ws, 'manifest.json'))) fail(`no manifest.json in ${ws} — not a TAUT workspace`);
  await initDataFor({ explicit: opts.data ?? null, ws });
  const before = await readLock(ws);
  const cfg = await cfgFromWorkspace(ws);
  await compileWorkspace(cfg, { verb: 'repaired' });
  // Honest conflation note (repair ≠ update): repair renders with the CURRENT
  // framework tree — when the framework moved since the workspace's pin, healing also
  // updated it. Pin-faithful repair needs the generator at the pin (D1b).
  const after = gitInfo(FW_ROOT).commit;
  const pin = before?.framework?.commit;
  if (pin && after && pin !== after)
    process.stdout.write(dim(`  note: repair recompiled at the CURRENT framework (pin ${pin.slice(0, 7)} → ${after.slice(0, 7)}); for a deliberate actualization use \`taut update\`.`) + '\n');
}

// ---------------------------------------------------------------- status + update

async function readLock(ws: string): Promise<Lock | null> {
  // Legacy fallback: a pre-rename workspace still carries federation.lock until its
  // first recompile migrates it — read-only commands (status/verify/panel) must work
  // on it unchanged, and the migration sweep needs the old artifact ids.
  const raw = await readIfExists(path.join(ws, 'taut.lock'), 8 * 1024 * 1024)
    ?? await readIfExists(path.join(ws, 'federation.lock'), 8 * 1024 * 1024);
  try { return raw === null ? null : JSON.parse(raw); } catch { return null; }
}

// What lies between a workspace's pinned commit and the repo HEAD — for the framework
// AND the data pack (dual pin, core/data split). The pin comes from the lock (untrusted):
// validated as a commit hash and passed as an argv element (never a shell string).
function repoDelta(root: string, pin: string | null): RepoDelta {
  const opts: ExecFileSyncOptionsWithStringEncoding = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
  let head: string | null = null;
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim(); } catch { /* no git */ }
  if (!head) return { head: null, behind: null, files: [], pinKnown: false };
  if (!pin || !isCommit(pin)) return { head, behind: null, files: [], pinKnown: false };
  if (pin === head) return { head, behind: 0, files: [], pinKnown: true };
  try {
    const behind = Number(execFileSync('git', ['rev-list', '--count', `${pin}..HEAD`], opts).trim());
    const files = execFileSync('git', ['diff', '--name-only', `${pin}..HEAD`], opts).trim().split('\n').filter(Boolean);
    return { head, behind, files, pinKnown: true };
  } catch {
    // The pin is not in this clone's history (rebased/amended repo, foreign clone).
    return { head, behind: null, files: [], pinKnown: false };
  }
}
const frameworkDelta = (pin: string | null): RepoDelta => repoDelta(FW_ROOT, pin);

async function driftedArtifacts(ws: string, lock: Lock): Promise<string[]> {
  const out: string[] = [];
  for (const a of lock.artifacts ?? []) {
    const target = safeJoin(ws, a.id);
    if (!target) { out.push(`${a.id} (invalid)`); continue; }
    try { if (sha256(await fs.readFile(target)) !== a.sha256) out.push(a.id); }
    catch { out.push(`${a.id} (missing)`); }
  }
  return out;
}

// The actualization check the deployment law asks for: is this workspace CURRENT
// (framework pin == HEAD) and does it still ANSWER ITS SETTINGS (integrity vs the lock —
// the manifest is itself a locked artifact, so lock-clean ⇒ settings-conformant) —
// plus canonicality and MCP catalog-pin drift. statusData is the machine contract:
// `status --json` prints it, the panel serves it.
export async function statusData(ws: string): Promise<StatusData> {
  const lock = await readLock(ws);
  if (!lock) fail(`no taut.lock in ${ws} — not a TAUT workspace (or setup never ran)`);
  let manifest: any = null;
  try { manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8')); } catch { /* reported via drift */ }
  // The project's own MCP catalog joins before the pin comparison (a project may pin
  // its servers itself — status must judge against the MERGED catalog).
  if (manifest?.deployment) {
    try { initProject((await listDeployments()).find((d) => d.name === manifest.deployment)?.dir); }
    catch { /* a broken pack layout is reported by compile paths, not status */ }
  }

  const drifted = await driftedArtifacts(ws, lock);
  const delta = frameworkDelta(lock.framework?.commit ?? null);
  // Data axis (lock v2): judged only when the pack is a git repo with a recorded pin;
  // a v1 lock (no `data`) or a non-git pack leaves the axis out of the currency verdict.
  const dataDelta = lock.data?.commit ? repoDelta(requireData(), lock.data.commit) : null;
  const dataCurrent = lock.data?.commit ? dataDelta!.behind === 0 : true;
  const mcp = (lock.mcp ?? []).map((m) => ({ id: m.id, pin: m.pin, catalogPin: MCP_CATALOG[m.id]?.pin ?? null }));
  const mcpOutdated = mcp.filter((m) => m.catalogPin && m.catalogPin !== m.pin);
  const canonical = lock.framework?.canonical === true && lock.data?.canonical !== false;
  // Canonicality is a build-MODE property (dev builds from a dirty tree), not an
  // actualization property — it is reported, but does not fail the currency verdict.
  const current = delta.behind === 0 && dataCurrent && drifted.length === 0 && mcpOutdated.length === 0;
  return {
    workspace: ws,
    deployment: manifest?.deployment ?? null,
    harnesses: lock.harnesses ?? (lock.harness ? [lock.harness] : []),
    atlas: lock.atlas,
    generatedAt: lock.generatedAt,
    framework: { pin: lock.framework?.commit ?? null, head: delta.head, behind: delta.behind, pinKnown: delta.pinKnown, canonical, changedFiles: delta.files },
    data: lock.data ? {
      pack: lock.data.pack ?? null,
      root: requireData(),
      pin: lock.data.commit ?? null,
      head: dataDelta?.head ?? null,
      behind: dataDelta?.behind ?? null,
      pinKnown: dataDelta?.pinKnown ?? false,
      canonical: lock.data.canonical !== false,
      changedFiles: dataDelta?.files ?? [],
    } : null,
    artifacts: { total: (lock.artifacts ?? []).length, drifted },
    mcp,
    current,
  };
}

export async function cmdStatus(opts: CliOpts): Promise<void> {
  const ws = path.resolve(expandHome(opts.workspace ?? process.cwd()));
  await initDataFor({ explicit: opts.data ?? null, ws });
  const st = await statusData(ws);
  const { current, framework: fw, mcp } = st;
  const drifted = st.artifacts.drifted;
  const mcpOutdated = mcp.filter((m) => m.catalogPin && m.catalogPin !== m.pin);

  if (opts.json) {
    process.stdout.write(JSON.stringify(st, null, 2) + '\n');
    process.exit(current ? 0 : 1);
  }

  const p = (s: string) => process.stdout.write(s + '\n');
  p(`${current ? green('✔') : yellow('!')} ${bold('TAUT workspace status')} ${dim('·')} ${ws}`);
  p(`  ${dim('deployment')} ${st.deployment ?? 'generic'}   ${dim('harness')} ${st.harnesses.join(' + ')}   ${dim('atlas')} ${st.atlas ? 'enabled' : 'disabled'}   ${dim('built')} ${st.generatedAt ?? '?'}${fw.canonical ? '' : `   ${yellow('NON-CANONICAL')}`}`);
  const pinTxt = fw.pin?.slice(0, 7) ?? 'none';
  if (fw.behind === 0) p(`  ${dim('framework')}  pin ${pinTxt} ${green('== HEAD — up to date')}`);
  else if (!fw.pinKnown) p(`  ${dim('framework')}  pin ${pinTxt} ${yellow('not found in the framework clone history')} ${dim('(rebased/amended? re-run setup or update)')}`);
  else {
    const dirs = [...new Set(fw.changedFiles.map((f) => f.split('/')[0]))].join(', ');
    p(`  ${dim('framework')}  pin ${pinTxt} ${yellow(`BEHIND HEAD ${fw.head!.slice(0, 7)} by ${fw.behind} commit(s)`)} ${dim(`· changed: ${dirs}`)}`);
  }
  if (st.data) {
    const dp = st.data.pin?.slice(0, 7);
    const label = st.data.pack ?? path.basename(st.data.root ?? '') ?? 'pack';
    if (!st.data.pin) p(`  ${dim('data')}       ${label} ${dim('(not a git repo — currency not judged)')}`);
    else if (st.data.behind === 0) p(`  ${dim('data')}       ${label} pin ${dp} ${green('== HEAD — up to date')}`);
    else if (!st.data.pinKnown) p(`  ${dim('data')}       ${label} pin ${dp} ${yellow('not found in the data pack history')} ${dim('(moved/rebased pack? re-run update)')}`);
    else {
      const dirs = [...new Set(st.data.changedFiles.map((f) => f.split('/')[0]))].join(', ');
      p(`  ${dim('data')}       ${label} pin ${dp} ${yellow(`BEHIND HEAD ${st.data.head!.slice(0, 7)} by ${st.data.behind} commit(s)`)} ${dim(`· changed: ${dirs}`)}`);
    }
  }
  p(`  ${dim('integrity')}  ${drifted.length ? red(`${drifted.length} of ${st.artifacts.total} artifact(s) DRIFTED: ${drifted.join(', ')}`) : green(`${st.artifacts.total} artifacts match the lock (settings-conformant)`)}`);
  if (mcp.length) p(`  ${dim('mcp')}        ${mcp.map((m) => `${m.id}@${m.pin}${m.catalogPin && m.catalogPin !== m.pin ? yellow(` (catalog: ${m.catalogPin})`) : ''}`).join(', ')}`);
  p(current
    ? `\n${green('ACTUAL')} — the workspace matches its pinned build, its settings, and the framework HEAD${fw.canonical ? '' : yellow(' (NON-CANONICAL dev build)')}.`
    : `\n${yellow('NOT CURRENT')} — ${[fw.behind ? 'framework moved (run `taut update`)' : null, st.data?.behind ? `data pack moved (run \`taut update${fw.behind ? '' : ' --data-only'}\`)` : null, !fw.pinKnown && fw.behind !== 0 ? 'pin unknown (re-run setup/update)' : null, drifted.length ? 'artifacts drifted (run `taut repair`)' : null, mcpOutdated.length ? 'MCP pins behind the catalog (run `taut update`)' : null].filter(Boolean).join('; ')}.`);
  process.exit(current ? 0 : 1);
}

// Deliberate actualization (repair heals, UPDATE re-pins): recompile the workspace
// at the CURRENT framework with its own manifest settings preserved, printing what the
// pin move brings. --from-deployment additionally refreshes the manifest's profile blocks
// from the CURRENT <name>/deployment.json in the pack (factory-settings refresh — user selections
// harness/atlas/skills/mcp/repos stay as configured).
export async function cmdUpdate(opts: CliOpts): Promise<void> {
  const ws = path.resolve(expandHome(opts.workspace ?? process.cwd()));
  if (!await exists(path.join(ws, 'manifest.json'))) fail(`no manifest.json in ${ws} — not a TAUT workspace`);
  await initDataFor({ explicit: opts.data ?? null, ws });
  const lock = await readLock(ws);
  const pin = lock?.framework?.commit ?? null;
  const delta = frameworkDelta(pin);
  // Data axis (dual pin): the pack moves independently of the engine — an update is due
  // when EITHER moved; a non-git pack (or v1 lock) leaves the axis out.
  const dataPin = lock?.data?.commit ?? null;
  const dataDelta = dataPin ? repoDelta(requireData(), dataPin) : null;
  const dataCurrent = dataPin ? dataDelta!.behind === 0 : true;
  const drifted = lock ? await driftedArtifacts(ws, lock) : [];

  // --data-only: the everyday content actualization — re-pin the
  // pack alone. Honesty guard: a recompile always renders with the CURRENT framework
  // tree, so when the core itself moved (or its pin is unknown), a "data-only" update
  // would silently re-pin the core too — refuse instead of lying about the pin.
  if (opts.dataOnly && (!pin || !delta.pinKnown || (delta.behind ?? 0) > 0))
    fail(`--data-only: the framework core is not current (pin ${pin?.slice(0, 7) ?? 'none'}${delta.behind ? ` BEHIND HEAD by ${delta.behind} commit(s)` : ', unknown in this clone'}) — a recompile always renders with the current core tree, so a data-only update would silently re-pin the core; run a full \`taut update\``);

  if (delta.behind === 0 && dataCurrent && !drifted.length && !opts.fromDeployment) {
    process.stdout.write(`${green('✔')} already current — pin ${pin!.slice(0, 7)} == framework HEAD${dataPin ? `, data ${dataPin.slice(0, 7)} == pack HEAD` : ''}, all artifacts match.\n`);
    return;
  }
  const fw = gitInfo(FW_ROOT);
  if (fw.dirty) process.stdout.write(`${yellow('warning:')} framework tree is dirty — the update will be a NON-CANONICAL build.\n`);
  if (gitInfoOwn(requireData()).dirty) process.stdout.write(`${yellow('warning:')} data pack tree is dirty — the update will be a NON-CANONICAL build.\n`);
  const changelog = (root: string, from: string, label: string): void => {
    if (!isCommit(from)) return;
    try {
      const log = execFileSync('git', ['log', '--oneline', `${from}..HEAD`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').slice(0, 8);
      for (const l of log) process.stdout.write(`  ${dim(`${label} ${l}`)}\n`);
    } catch { /* changelog is best-effort */ }
  };
  if (pin && delta.pinKnown && (delta.behind ?? 0) > 0) {
    process.stdout.write(`${bold('Updating')} framework pin ${pin.slice(0, 7)} → ${delta.head!.slice(0, 7)} ${dim(`(${delta.behind} commit(s))`)}\n`);
    changelog(FW_ROOT, pin, 'core');
  }
  if (dataPin && dataDelta?.pinKnown && (dataDelta.behind ?? 0) > 0) {
    process.stdout.write(`${bold('Updating')} data pin ${dataPin.slice(0, 7)} → ${dataDelta.head!.slice(0, 7)} ${dim(`(${dataDelta.behind} commit(s))`)}\n`);
    changelog(requireData(), dataPin, 'data');
  }

  const cfg = await cfgFromWorkspace(ws);
  if (opts.fromDeployment) {
    const name = cfg.profile?.name;
    if (!name) fail('workspace has no deployment config — nothing to refresh from (--from-deployment)');
    const prof = (await listDeployments()).find((d) => d.name === name);
    if (!prof) fail(`deployment config "${name}" not found in the framework`);
    cfg.profile = prof;
    // Factory-settings refresh includes the deployment's MODE (when it declares one) —
    // an existing workspace adopts e.g. `strict` the deployment turned on later.
    if (prof.mode !== undefined && prof.mode !== cfg.mode) {
      cfg.mode = prof.mode;
      process.stdout.write(`  ${dim(`workspace mode → ${cfg.mode} (deployment default)`)}\n`);
    }
    process.stdout.write(`  ${dim(`manifest profile blocks refreshed from ${name}/deployment.json`)}\n`);
  }

  // New-version payload (a new framework version may SHIP new skills/
  // agents). An "all" selection follows the framework: newly shipped skills are installed,
  // no-longer-shipped ones removed (compileWorkspace sweeps their files). A "custom"
  // selection stays fixed — newly available skills are only advertised.
  const available = [...cfg.catalog.skills.keys()].sort();
  const atlasReq = atlasRequired(cfg.catalog);
  const selectable = available.filter((s) => (cfg.atlas || !atlasReq.includes(s))
    && !(cfg.repoExcludedSkills?.has(s)));
  if (cfg.skillsSelection === 'all') {
    // "all minus exclusions": toggled-off skills (skillsExcluded) never re-install,
    // everything else keeps following the shipped payload.
    const excluded = new Set(cfg.skillsExcluded ?? []);
    const target = selectable.filter((s) => !excluded.has(s));
    const added = target.filter((s) => !cfg.skills.includes(s));
    const dropped = cfg.skills.filter((s) => !target.includes(s));
    cfg.skills = target;
    if (added.length) process.stdout.write(`  ${green('new in this version — installing:')} ${added.join(', ')}\n`);
    if (dropped.length) process.stdout.write(`  ${yellow('no longer shipped — removing:')} ${dropped.join(', ')}\n`);
  } else {
    const fresh = selectable.filter((s) => !cfg.skills.includes(s));
    if (fresh.length) process.stdout.write(`  ${yellow('note:')} new skill(s) available but not installed (custom selection kept): ${fresh.join(', ')} — re-run setup to add.\n`);
  }
  await compileWorkspace(cfg, { verb: 'updated' });
}

// ---------------------------------------------------------------- repo-scaffold

// Auto-init of MISSING repo descriptors: the pack is
// checked first — initialization happens only for what does not exist. For every
// connected repo without a repos/<name>/ folder in the project (or for the repos named
// as arguments), write a SKELETON descriptor with an embedded distillation brief INTO
// THE DATA PACK. Writing the pack is an EXPLICIT act (compile never writes it); the
// loop closes outside the core: an agent fills the skeleton by read-only analysis, the
// owner commits the pack, update/repair installs. Existing files are never overwritten.
export async function cmdRepoScaffold(opts: CliOpts): Promise<void> {
  const ws = path.resolve(expandHome(opts.workspace ?? process.cwd()));
  if (!await exists(path.join(ws, 'manifest.json'))) fail(`no manifest.json in ${ws} — not a TAUT workspace`);
  await initDataFor({ explicit: opts.data ?? null, ws });
  const cfg = await cfgFromWorkspace(ws);
  if (!cfg.profile?.dir)
    fail('repo descriptors are project-scoped — this workspace has no deployment config in the pack (repos/ lives inside the project folder)');
  const connected = new Map(cfg.repos.map((r) => [r.name, r]));
  const targets = opts._.slice(1);
  for (const t of targets)
    if (!connected.has(t)) fail(`repo "${t}" is not connected in this workspace (connected: ${[...connected.keys()].join(', ') || 'none'})`);
  const names = targets.length ? targets : [...connected.keys()].filter((n) => !cfg.catalog.repoDocs.has(n));

  const made: string[] = []; const skipped: string[] = [];
  for (const n of names) {
    const file = path.join(cfg.profile.dir, 'repos', n, 'CLAUDE.md');
    if (cfg.catalog.repoDocs.has(n) || await exists(file)) { skipped.push(n); continue; }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, scaffoldDescriptor(n, connected.get(n)!.path));
    made.push(`${cfg.profile.name}/repos/${n}/CLAUDE.md`);
  }
  const p = (s: string) => process.stdout.write(s + '\n');
  if (made.length) {
    p(`${green('✔')} ${bold(`scaffolded ${made.length} repo descriptor skeleton(s)`)} ${dim(`into ${requireData()}`)}`);
    for (const f of made) p(`  ${f}`);
    p(`\nNext: fill each skeleton by its embedded distillation brief (READ-ONLY repo analysis —`);
    p(`an agent session does this well), commit the data pack, then ${bold('node ui update')} to install.`);
  } else {
    p(`${green('✔')} nothing to scaffold — ${targets.length ? 'the requested repo(s) already have descriptors' : 'every connected repo already has descriptors in the pack'}.`);
  }
  if (skipped.length) p(`  ${dim(`skipped (already covered): ${skipped.join(', ')}`)}`);
}

// ---------------------------------------------------------------- apply (toggles)

// Deliberate per-artifact toggles: enable/disable skills and MCP servers on an
// existing workspace by ONE recompile through the same chokepoint as setup — sweep
// removes a disabled skill's files and orphaned agents, capability gates recompile
// every artifact when an MCP role changes. Under an "all" selection a disabled skill
// lands in skillsExcluded ("all minus exclusions") so update keeps following new
// versions without resurrecting it. This is the panel's engine and a CLI in its own
// right: taut apply --disable-skill x --enable-mcp y ...
export async function cmdApply(opts: CliOpts): Promise<void> {
  const ws = path.resolve(expandHome(opts.workspace ?? process.cwd()));
  if (!await exists(path.join(ws, 'manifest.json'))) fail(`no manifest.json in ${ws} — not a TAUT workspace`);
  const total = opts.skillsOn.length + opts.skillsOff.length + opts.mcpOn.length + opts.mcpOff.length
    + opts.reposOn.length + opts.reposOff.length + opts.harnessOn.length + opts.harnessOff.length + (opts.mode ? 1 : 0);
  if (!total) fail('nothing to apply — pass --enable-skill/--disable-skill/--enable-mcp/--disable-mcp/--connect-repo/--disconnect-repo/--enable-harness/--disable-harness/--mode');
  await initDataFor({ explicit: opts.data ?? null, ws });
  const cfg = await cfgFromWorkspace(ws);

  // Workspace MODE toggle: a deliberate, VISIBLE regime change — one recompile
  // re-renders the gate wiring (strict widens the PreToolUse matcher to mcp__*) and the
  // instructions. Soft by design: any recompile can change it; the audit trail is the
  // lock/manifest diff, not a lockout (a workspace cannot distinguish who runs the CLI).
  if (opts.mode) {
    if (!['strict', 'normal'].includes(opts.mode)) fail(`unknown mode "${opts.mode}" (expected: strict, normal)`);
    cfg.mode = opts.mode;
  }

  // HARNESS toggles (the panel's harness switches): enable = the union render installs
  // that harness's full native set; disable = the sweep removes it (payload trees + its
  // root files). No re-setup — answers, secrets, selections all survive the recompile.
  if (opts.harnessOn.length || opts.harnessOff.length) {
    const turnOn = opts.harnessOn.length ? normalizeHarnesses(opts.harnessOn) : [];
    const turnOff = opts.harnessOff.length ? normalizeHarnesses(opts.harnessOff) : [];
    const clash = turnOn.filter((h) => turnOff.includes(h));
    if (clash.length) fail(`--enable-harness and --disable-harness conflict on: ${clash.join(', ')}`);
    const set = new Set(cfg.harnesses);
    for (const h of turnOn) set.add(h);
    for (const h of turnOff) set.delete(h);
    if (!set.size) fail('cannot disable the last harness — at least one must stay enabled');
    cfg.harnesses = HARNESSES.filter((h) => set.has(h));
  }

  // REPO toggles first (the panel's repo checklist): the connected set
  // is a workspace setting like any other — toggled through the same compile chokepoint.
  // Disconnect: the recompile sweeps the repo's workspace data (descriptors, bound
  // runbooks/wrappers, manifest + local.json rows); the member repo itself is untouched.
  // Connect: descriptors install; an uncovered KNOWN repo first gets a skeleton
  // scaffolded into the pack (add ⇒ a descriptor exists, per the auto-init contract).
  for (const n of opts.reposOff) {
    if (!cfg.repos.some((r) => r.name === n)) fail(`repo "${n}" is not connected in this workspace`);
    if ((cfg.profile?.repos?.mandatory ?? []).includes(n))
      fail(`repo "${n}" is mandatory in deployment "${cfg.profile!.name}" — cannot disconnect`);
    cfg.repos = cfg.repos.filter((r) => r.name !== n);
  }
  const added: string[] = [];
  for (const spec of opts.reposOn) {
    // A bare name resolves in the workspace-parent root (the landscape convention);
    // anything with a separator is a path. Reconnecting a connected repo is a no-op.
    const byPath = spec.includes('/') || spec.startsWith('~');
    const abs = byPath ? path.resolve(expandHome(spec)) : path.join(path.dirname(ws), spec);
    const name = path.basename(abs);
    if (cfg.repos.some((r) => r.name === name)) continue;
    if (!await exists(abs)) fail(`repo folder not found: ${abs}`);
    if (await isConductorDir(abs)) fail(`${abs} is a TAUT workspace — not a member repo`);
    if (!await exists(path.join(abs, '.git'))) cfg.warnings.push(`${abs} is not a git repository (kept, but guards assume git)`);
    cfg.repos.push({ name, path: abs });
    added.push(name);
  }
  if (opts.reposOff.length || added.length) {
    if (cfg.profile?.dir) {
      const known = new Set([...(cfg.profile.repos?.mandatory ?? []), ...Object.keys(cfg.profile.repos?.known ?? {})]);
      for (const n of added) {
        if (cfg.catalog.repoDocs.has(n)) continue;
        if (known.size && !known.has(n)) {
          cfg.warnings.push(`repo "${n}" is not in the deployment repo map — descriptor not scaffolded (add it to deployment.json first)`);
          continue;
        }
        const file = path.join(cfg.profile.dir, 'repos', n, 'CLAUDE.md');
        if (!await exists(file)) {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, scaffoldDescriptor(n, cfg.repos.find((r) => r.name === n)!.path));
        }
        cfg.catalog.repoDocs.set(n, [{ file: 'CLAUDE.md', path: file }]);
        process.stdout.write(`  scaffolded a descriptor skeleton for "${n}" into the pack — fill it by its embedded brief, then commit the pack\n`);
      }
    }
    relintRepoBindings(cfg);
    // An "all" selection keeps meaning ALL: skills whose repo bindings the new connected
    // set satisfies (minus explicit exclusions) re-enter, mirroring update's payload rule.
    if (cfg.skillsSelection === 'all') {
      const atlasReqNow = atlasRequired(cfg.catalog);
      const excludedNow = new Set(cfg.skillsExcluded ?? []);
      cfg.skills = [...cfg.catalog.skills.keys()].sort().filter((s) =>
        (cfg.atlas || !atlasReqNow.includes(s)) && !cfg.repoExcludedSkills!.has(s) && !excludedNow.has(s));
    }
  }

  const atlasReq = atlasRequired(cfg.catalog);
  const excluded = new Set(cfg.skillsExcluded ?? []);

  for (const s of opts.skillsOn) {
    if (!cfg.catalog.skills.has(s)) fail(`unknown skill "${s}"`);
    if (!cfg.atlas && atlasReq.includes(s)) fail(`skill "${s}" requires Atlas, which is disabled in this workspace`);
    if (cfg.repoExcludedSkills?.has(s)) fail(`skill "${s}" is excluded by the repo lint (bound to repos not connected here)`);
    if (!cfg.skills.includes(s)) cfg.skills.push(s);
    excluded.delete(s);
  }
  for (const s of opts.skillsOff) {
    if (!cfg.catalog.skills.has(s) && !cfg.skills.includes(s)) fail(`unknown skill "${s}"`);
    cfg.skills = cfg.skills.filter((x) => x !== s);
    if (cfg.skillsSelection === 'all') excluded.add(s);
  }
  cfg.skills.sort();
  cfg.skillsExcluded = [...excluded].sort();

  for (const id of opts.mcpOn) {
    if (!MCP_CATALOG[id]) fail(`unknown MCP server "${id}" (catalog: ${Object.keys(MCP_CATALOG).join(', ')})`);
    if (!cfg.mcp.includes(id)) cfg.mcp.push(id);
  }
  for (const id of opts.mcpOff) {
    if (!MCP_CATALOG[id]) fail(`unknown MCP server "${id}"`);
    cfg.mcp = cfg.mcp.filter((x) => x !== id);
  }

  await compileWorkspace(cfg, { verb: 'applied' });
}
