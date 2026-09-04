#!/usr/bin/env node
// TAUT integrity gate — compiled into a workspace by `taut setup` as
// .taut/gate.mjs and wired to harness hooks (PreToolUse / UserPromptSubmit /
// UserPromptExpansion / SessionStart). Verifies framework-owned artifacts against
// taut.lock and BLOCKS use of manually-edited skills/agents (deployment law:
// managed artifacts are use-only; changes go through the framework source + recompile).
// Self-contained (node builtins only; works without the framework clone present).
// Fail-closed: an unreadable lock or an internal error blocks; `repair` heals.
// Usage telemetry goes through the sibling adapter .taut/telemetry.mjs (LOCAL-ONLY
// daily files under memory/telemetry/ — never sent anywhere; a missing adapter is a
// silent no-op, telemetry never breaks the gate).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const EVENT = process.argv[2] ?? '';
// Caller identity, baked into the hook wiring at compile (`... pretooluse --harness
// claude-code`): a multi-harness workspace ships an artifact set per enabled harness, and the gate routes
// skill/agent paths by whoever invoked it. Absent (legacy wiring) → derived from the lock.
const HARNESS_ARG = (() => { const i = process.argv.indexOf('--harness'); return i === -1 ? null : process.argv[i + 1] ?? null; })();
const WS = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const REPAIR_HINT = 'Heal: `taut repair --workspace <this workspace>` (or re-run setup); to change a managed artifact, edit the framework source and recompile.';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isCommit = (s) => /^[0-9a-f]{7,40}$/.test(s);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A skill NAME is mentioned in the (JSON-encoded) prompt input as a quoted token or a
// /slash-command — match it delimited so a short name (e.g. "a") cannot substring-match
// unrelated text and over-block. Prompt-expansion routing only.
const mentions = (text, name) => name.length > 0 && new RegExp('[\\s"\'/]' + escapeRe(name) + '(?![\\w-])').test(text);
// Resolve a lock id under the workspace and reject any that escapes it — a tampered lock
// must not make the gate read (and hash-trust) files outside the workspace.
function underWs(id) {
  const abs = path.resolve(WS, id);
  return abs === WS || abs.startsWith(WS + path.sep) ? abs : null;
}

function artifactState(id, want) {
  const abs = underWs(id);
  if (!abs) return 'MISSING';
  try { return sha256(fs.readFileSync(abs)) === want ? 'ok' : 'DRIFTED'; }
  catch { return 'MISSING'; }
}

// Telemetry rides the SIBLING adapter (compiled next to this gate) — the single write
// path for usage telemetry. Adapter missing/unreadable → tel stays null and every log
// call is a no-op: the gate keeps enforcing without it. Level + day-file meta come from
// the lock once it loads; until then the pre-lock default applies (early deny events).
let telemetryMod = null;
try { telemetryMod = await import(new URL('./telemetry.mjs', import.meta.url).href); } catch { telemetryMod = null; }
let tel = null;
function initTelemetry(level, meta) {
  try { tel = telemetryMod ? telemetryMod.createTelemetry({ workspace: WS, level, meta }) : null; } catch { tel = null; }
}
initTelemetry(undefined, null);
// `taut check` proves enforcement is live by running THIS gate out of band, against the
// first skill in the manifest. Those rows are indistinguishable from real invocations
// unless the probe says so — left unmarked, a self-test inflates one skill's usage and
// makes the usage column untrustworthy exactly where it looks most convincing.
const PROBE = process.env.TAUT_PROBE === '1';
function logUsage(entry) {
  // Every invocation says which path it arrived on. Stamped here rather than at each call
  // site so no path can be added later and silently go unlabelled — and so a reader can
  // tell a workspace whose gate records both paths from one whose files predate that: no
  // `via` anywhere means the slash path was never being counted, which is a different
  // statement from "nobody used it".
  const row = entry.event === 'invoke' && entry.via === undefined && EVENT === 'pretooluse'
    ? { ...entry, via: 'tool' } : entry;
  try { tel?.log(PROBE ? { ...row, probe: true } : row); } catch { /* telemetry must never break the gate */ }
}

function denyTool(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(0);
}
function blockPrompt(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}
function blockExit2(reason) { process.stderr.write(reason); process.exit(2); }
function sessionContext(text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'SessionStart', additionalContext: text } }));
  process.exit(0);
}

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { input = {}; }
const ts = new Date().toISOString();
const sid = input.session_id;

try {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(WS, 'taut.lock'), 'utf8')); }
  catch {
    const reason = `TAUT gate: taut.lock is missing/unreadable in ${WS} — integrity cannot be proven, managed artifacts are blocked. ${REPAIR_HINT}`;
    logUsage({ ts, event: EVENT, decision: 'deny', cause: 'lock-missing', harness: HARNESS_ARG ?? undefined, session_id: sid });
    if (EVENT === 'pretooluse') denyTool(reason);
    if (EVENT === 'sessionstart') sessionContext(`⚠ ${reason}`);
    blockExit2(reason);
  }

  // The lock is the telemetry config root too (like `mode`): level + day-file meta.
  initTelemetry(lock.telemetry, {
    engine: lock.framework?.commit?.slice(0, 7) ?? null,
    data: lock.data?.commit?.slice(0, 7) ?? null,
    mode: lock.mode ?? 'normal',
    harnesses: lock.harnesses ?? (lock.harness ? [lock.harness] : []),
  });

  // Enabled harness set (lock v3; a legacy v1/v2 lock carries a scalar). Wiring and lock
  // are rendered by the same compile, so an identity OUTSIDE the enabled set means stale
  // wiring for a since-disabled harness — fail closed rather than govern by guesswork.
  const enabled = lock.harnesses ?? (lock.harness ? [lock.harness] : ['claude-code']);
  if (HARNESS_ARG && !enabled.includes(HARNESS_ARG)) {
    const reason = `TAUT gate: harness "${HARNESS_ARG}" is not enabled in this workspace (enabled: ${enabled.join(', ')}) — stale hook wiring. Re-enable it (\`taut apply --enable-harness ${HARNESS_ARG}\`) or heal (\`taut repair\`).`;
    logUsage({ ts, event: EVENT, decision: 'deny', cause: 'harness-disabled', harness: HARNESS_ARG, session_id: sid });
    if (EVENT === 'pretooluse') denyTool(reason);
    if (EVENT === 'sessionstart') sessionContext(`⚠ ${reason}`);
    blockExit2(reason);
  }
  const HARNESS = HARNESS_ARG ?? (enabled.length === 1 ? enabled[0] : 'claude-code');
  const forCodex = HARNESS === 'codex';
  const forOpencode = HARNESS === 'opencode';

  const byId = new Map(lock.artifacts.map((a) => [a.id, a.sha256]));
  // .opencode/plugins is NOT payload — the gate plugin is enforcement infrastructure,
  // core-checked like the gate itself and the hook wiring.
  const isPayload = (id) => /^(\.claude\/skills|\.claude\/agents|\.agents\/skills|\.codex\/agents|\.opencode\/agents)\//.test(id);
  const coreIds = lock.artifacts.filter((a) => !isPayload(a.id)).map((a) => a.id);
  const checkIds = (ids) => ids
    .map((id) => ({ id, st: artifactState(id, byId.get(id)) }))
    .filter((r) => r.st !== 'ok')
    .map((r) => `${r.id} (${r.st})`);
  // opencode reads the Agent Skills standard natively — it SHARES the .agents/skills
  // tree with codex (one installed copy, one lock row); its subagents are its own tree.
  const skillArtifact = (name) => (forCodex || forOpencode ? `.agents/skills/${name}/SKILL.md` : `.claude/skills/${name}/SKILL.md`);
  const agentArtifact = (name) => (forCodex ? `.codex/agents/${name}.toml` : forOpencode ? `.opencode/agents/${name}.md` : `.claude/agents/${name}.md`);
  // STRICT mode: only the compiled toolchain runs. The mode rides in the
  // lock (the tamper-anchored root); a legacy lock without it = normal. Governs
  // ARTIFACTS only — harness built-ins (tools, built-in subagent types) are never gated.
  const strict = lock.mode === 'strict';
  const strictHint = `STRICT workspace: only the compiled toolchain (taut.lock) runs here. Add it to the data pack and recompile, or lift the regime: \`taut apply --mode normal --workspace ${WS}\`.`;

  if (EVENT === 'pretooluse') {
    const tool = input.tool_name ?? '';
    const ti = input.tool_input ?? {};
    // MCP calls reach the gate only where the matcher sends them (strict claude-code
    // widens it; Codex/opencode hooks are always broad). Foreign server in strict = deny;
    // the allowed set is the LOCK's serverKeys — the same trust root as everything else.
    // opencode does not prefix MCP tools with mcp__ — a lock-listed server is recognized
    // by its serverKey prefix instead. Recorded limitation: a FOREIGN server's tools are
    // not name-detectable there, so strict-foreign MCP under opencode is enforced by the
    // locked opencode.json (adding a server means editing it → core drift → deny), not
    // by this name match.
    const mcpHit = tool.startsWith('mcp__') ? (tool.split('__')[1] ?? '')
      : forOpencode ? ((lock.mcp ?? []).find((m) => tool === m.serverKey || tool.startsWith(m.serverKey + '_'))?.serverKey ?? null)
        : null;
    if (mcpHit !== null) {
      const server = mcpHit;
      const allowed = (lock.mcp ?? []).some((m) => m.serverKey === server);
      if (strict && !allowed) {
        logUsage({ ts, event: 'invoke', kind: 'mcp', name: server, decision: 'deny', cause: 'strict-foreign', harness: HARNESS, session_id: sid });
        denyTool(`TAUT gate: MCP server "${server}" is not in this workspace's manifest. ${strictHint}`);
      }
      logUsage({ ts, event: 'invoke', kind: 'mcp', name: server, decision: 'allow', managed: allowed, harness: HARNESS, session_id: sid });
      process.exit(0);
    }
    // Tool names are harness-native: claude-code capitalizes (Skill/Agent/Task),
    // opencode's natives are lowercase (skill / task); the arg key carrying the name
    // varies the same way — accept both shapes, unknown keys just resolve to no name.
    let kind = null; let name = null; let id = null;
    if (tool === 'Skill' || tool === 'skill') {
      kind = 'skill';
      name = String(ti.skill ?? ti.name ?? ti.command ?? '').split(/\s+/)[0].replace(/^\//, '');
      id = skillArtifact(name);
    } else if (tool === 'Agent' || tool === 'Task' || tool === 'task' || tool === 'agent') {
      kind = 'agent';
      name = String(ti.subagent_type ?? ti.subagentType ?? ti.agent ?? '');
      id = agentArtifact(name);
    }
    if (!id || !byId.has(id)) {
      // Not a TAUT-managed artifact. Normal mode: none of our business. Strict mode:
      // a SKILL name outside the lock is always a content artifact -> deny, wherever it
      // lives (workspace folder, user-global, plugin). An AGENT type outside the lock is
      // denied only when a workspace file backs it (a foreign local agent); a type with
      // no file is a harness BUILT-IN (general-purpose, Explore, ...) and stays allowed.
      // Not every harness HAS a skill tool. On some, a skill is invoked by the model
      // READING its SKILL.md: the harness lists the skills with their paths and the model
      // opens the one it needs, so the read IS the invocation and it arrives as an ordinary
      // tool call — invisible to the name check above. That is how an entire harness's skill
      // usage can read zero while the skills are in daily use.
      //
      // Recorded, never gated: denying a command because a path appears inside it would
      // change what runs, and a legitimate listing of the skills directory would start
      // failing. Provenance is explicit — `via: 'read'` is weaker evidence than an explicit
      // invocation (a session auditing its own skills reads them too), and a reader that
      // knows how a count was obtained can discount it; one that cannot, cannot.
      // Guarded to tools that are NOT a skill/agent invocation: an unlocked skill whose
      // arguments happened to name a locked one must still reach the strict check below.
      // Detection may never become a way around enforcement.
      if (kind === null) {
        const readBlob = JSON.stringify(ti ?? {});
        const readSkills = [];
        for (const a of lock.artifacts) {
          const m = a.id.match(/skills\/([^/]+)\/SKILL\.md$/);
          if (m && !readSkills.includes(m[1]) && readBlob.includes(skillArtifact(m[1]))) readSkills.push(m[1]);
        }
        for (const n of readSkills)
          logUsage({ ts, event: 'invoke', kind: 'skill', name: n, decision: 'allow', managed: true, via: 'read', harness: HARNESS, session_id: sid });
        if (readSkills.length) process.exit(0);
      }

      const foreignAgentFile = kind === 'agent' && name && fs.existsSync(path.join(WS, agentArtifact(name)));
      if (strict && (kind === 'skill' || foreignAgentFile) && name) {
        logUsage({ ts, event: 'invoke', kind, name, decision: 'deny', cause: 'strict-foreign', harness: HARNESS, session_id: sid });
        denyTool(`TAUT gate: ${kind} "${name}" is not part of the compiled toolchain. ${strictHint}`);
      }
      // Only NAMED artifacts are recorded. The claude-code matcher is a partial match, so
      // sibling tools (TaskOutput, TaskStop, …) reach the gate too and resolve to no kind
      // and no name — a row for one of those carries zero information and only dilutes the
      // usage stream it shares a file with.
      if (name) logUsage({ ts, event: 'invoke', kind, name, decision: 'allow', managed: false, harness: HARNESS, session_id: sid });
      process.exit(0); // not a TAUT-managed artifact — none of our business
    }
    const coreBad = checkIds(coreIds);
    if (coreBad.length) {
      logUsage({ ts, event: 'invoke', kind, name, decision: 'deny', cause: 'core-drift', harness: HARNESS, session_id: sid });
      denyTool(`TAUT gate: workspace core artifacts are out of sync (${coreBad.join(', ')}) — refusing to run managed ${kind} "${name}". ${REPAIR_HINT}`);
    }
    const st = artifactState(id, byId.get(id));
    if (st !== 'ok') {
      logUsage({ ts, event: 'invoke', kind, name, decision: 'deny', cause: st.toLowerCase(), harness: HARNESS, session_id: sid });
      denyTool(`TAUT gate: ${kind} "${name}" was modified outside the pipeline (${st}: ${id}). Managed artifacts are use-only. ${REPAIR_HINT}`);
    }
    logUsage({ ts, event: 'invoke', kind, name, decision: 'allow', managed: true, harness: HARNESS, session_id: sid });
    process.exit(0);
  }

  if (EVENT === 'promptsubmit') {
    const bad = checkIds(coreIds);
    if (bad.length) {
      logUsage({ ts, event: 'prompt', decision: 'block', cause: 'core-drift', drifted: bad.length, harness: HARNESS, session_id: sid });
      blockPrompt(`TAUT gate: core workspace artifacts drifted (${bad.join(', ')}). Prompts are blocked until integrity is restored. ${REPAIR_HINT}`);
    }
    process.exit(0);
  }

  if (EVENT === 'promptexpansion') {
    // Direct /skillname invocations bypass PreToolUse(Skill) — this event covers that
    // path. The exact input field carrying the name is harness-version-dependent, so we
    // match installed skill names against the whole input; core is always checked.
    const text = JSON.stringify(input);
    // Strict: a FOREIGN workspace-local skill (a skills dir entry not in the lock) is
    // blocked on this path too. Only workspace files are detectable here — user-global /
    // plugin skills invoked by direct slash are covered at the Skill-tool chokepoint
    // instead (recorded limitation; built-in /commands are never skill dirs, so never hit).
    if (strict) {
      const skillsDir = path.join(WS, forCodex || forOpencode ? '.agents/skills' : '.claude/skills');
      let local = [];
      try { local = fs.readdirSync(skillsDir); } catch { local = []; }
      const foreign = local.filter((n) => !byId.has(skillArtifact(n)) && mentions(text, n));
      if (foreign.length) {
        logUsage({ ts, event: 'expansion', decision: 'block', cause: 'strict-foreign', name: foreign.join(','), harness: HARNESS, session_id: sid });
        blockExit2(`TAUT gate: skill "${foreign.join('", "')}" is not part of the compiled toolchain. ${strictHint}`);
      }
    }
    const invoked = lock.artifacts.filter((a) => {
      const m = a.id.match(/skills\/([^/]+)\/SKILL\.md$/);
      return m && mentions(text, m[1]);
    });
    const bad = checkIds([...coreIds, ...invoked.map((a) => a.id)]);
    if (bad.length) {
      logUsage({ ts, event: 'expansion', decision: 'block', drifted: bad.length, harness: HARNESS, session_id: sid });
      blockExit2(`TAUT gate: blocked — drifted artifacts: ${bad.join(', ')}. ${REPAIR_HINT}`);
    }
    // A direct /slash never reaches PreToolUse(Skill), so this is the ONLY place a
    // user-invoked skill can be counted — and a skill declaring
    // `disable-model-invocation: true` is reachable by NO other path, which is why the
    // usage stream used to read zero for exactly the skills a human drives by hand.
    //
    // Enforcement above stays on the broad `mentions()` match: erring toward checking is
    // right for integrity. Telemetry must err the other way — a prompt that merely NAMES a
    // skill is not a use of it — so the usage row is written only from the harness's own
    // routing fields, never from a text match. A harness that does not send them records
    // nothing rather than inventing a number.
    if (input.expansion_type === 'slash_command' && typeof input.command_name === 'string') {
      const cmd = input.command_name.split(':').pop();      // plugin skills arrive as "plugin:name"
      const id = skillArtifact(cmd);
      // Builtin commands (/model, /compact) share this event but are harness features, not
      // toolchain artifacts: only a skill backed by a file on disk is recorded.
      if (byId.has(id)) logUsage({ ts, event: 'invoke', kind: 'skill', name: cmd, decision: 'allow', managed: true, via: 'slash', harness: HARNESS, session_id: sid });
      else if (fs.existsSync(path.join(WS, id))) logUsage({ ts, event: 'invoke', kind: 'skill', name: cmd, decision: 'allow', managed: false, via: 'slash', harness: HARNESS, session_id: sid });
    }
    process.exit(0);
  }

  if (EVENT === 'sessionstart') {
    const bad = checkIds([...byId.keys()]);
    const notes = [];
    if (strict) {
      notes.push('TAUT: STRICT workspace — only the compiled toolchain runs (skills, agents, MCP per taut.lock); foreign artifacts are denied at invocation. Harness built-ins are unaffected.');
    }
    if (bad.length) {
      notes.push(`⚠ TAUT integrity: ${bad.length} managed artifact(s) out of sync: ${bad.join(', ')}. Managed skills/agents will be BLOCKED at invocation. ${REPAIR_HINT}`);
    }
    if (lock.framework?.canonical === false || lock.data?.canonical === false) {
      const dirty = [lock.framework?.canonical === false ? 'framework' : null,
        lock.data?.canonical === false ? 'data pack' : null].filter(Boolean).join(' + ');
      notes.push(`TAUT: NON-CANONICAL build (${dirty} tree was dirty at compile) — dev-mode workspace.`);
    }
    // Model-policy ADVISORY (best-effort): the payload's `model` field is optional and
    // may be a full id while the pin is an alias — compare the alias family plus the
    // [1m] wide-context flag, and speak only on a confident mismatch. Never blocks.
    const pin = lock.session?.[HARNESS]?.model;
    const live = typeof input.model === 'string' ? input.model : null;
    if (pin && live) {
      const base = pin.replace(/\[1m\]$/, '');
      const wide = pin.endsWith('[1m]');
      if (!live.includes(base) || wide !== live.includes('[1m]')) {
        const eff = lock.session[HARNESS].effort;
        notes.push(`TAUT model policy: this session runs "${live}" but the workspace pins "${pin}"${eff ? ` (effort ${eff})` : ''} for sessions — switch back unless deliberately escalated.`);
      }
    }
    // Actualization ADVISORY (never blocking — a pinned build is still consistent):
    // when the framework clone or the DATA PACK is reachable and moved past this
    // workspace's pins, say so. Best-effort by design: a workspace must keep working
    // without either repo present. The same probe feeds telemetry: behind.{engine,data}
    // per session is the actualization-lag series (axis absent = unreadable/unknown).
    const behind = {};
    try {
      const local = JSON.parse(fs.readFileSync(path.join(WS, '.taut', 'local.json'), 'utf8'));
      const axes = [
        { key: 'engine', label: 'framework', root: local.frameworkRoot, pin: lock.framework?.commit },
        { key: 'data', label: 'data pack', root: local.dataRoot, pin: lock.data?.commit },
      ];
      for (const ax of axes) {
        if (!ax.root || !ax.pin || !isCommit(ax.pin)) continue;
        try {
          const git = { cwd: ax.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
          const head = execFileSync('git', ['rev-parse', 'HEAD'], git).trim();
          if (head && head !== ax.pin) {
            let n = '?';
            try { n = execFileSync('git', ['rev-list', '--count', `${ax.pin}..HEAD`], git).trim(); } catch { /* pin not in history */ }
            behind[ax.key] = n === '?' ? null : Number(n);
            notes.push(`TAUT: the ${ax.label} is ${n} commit(s) ahead of this workspace (pin ${ax.pin.slice(0, 7)} → ${head.slice(0, 7)}). Actualize with \`taut update --workspace ${WS}\`.`);
          } else if (head) behind[ax.key] = 0;
        } catch { /* this axis unreadable — stay silent for it */ }
      }
    } catch { /* no local binding — stay silent */ }
    logUsage({ ts, event: 'session_start', drifted: bad.length, ...(Object.keys(behind).length ? { behind } : {}), harness: HARNESS, session_id: sid });
    if (notes.length) sessionContext(notes.join('\n'));
    process.exit(0);
  }

  process.exit(0); // unknown event — no-op
} catch (e) {
  // Fail-closed: an internal gate error must not silently wave tampered artifacts through.
  const reason = `TAUT gate: internal error (${e?.message ?? e}) — blocking as a precaution. ${REPAIR_HINT}`;
  logUsage({ ts, event: EVENT, decision: 'deny', cause: 'gate-error', harness: HARNESS_ARG ?? undefined, session_id: sid });
  if (EVENT === 'pretooluse') denyTool(reason);
  if (EVENT === 'sessionstart') sessionContext(`⚠ ${reason}`);
  blockExit2(reason);
}
