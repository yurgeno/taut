#!/usr/bin/env node
// TAUT integrity gate — compiled into a workspace by `taut setup` as
// .taut/gate.mjs and wired to harness hooks (PreToolUse / UserPromptSubmit /
// UserPromptExpansion / SessionStart). Verifies framework-owned artifacts against
// taut.lock and BLOCKS use of manually-edited skills/agents (deployment law:
// managed artifacts are use-only; changes go through the framework source + recompile).
// Self-contained (node builtins only; works without the framework clone present).
// Fail-closed: an unreadable lock or an internal error blocks; `repair` heals.
// The same gate is the usage-telemetry writer (memory/telemetry/usage.jsonl).

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

function logUsage(entry) {
  try {
    const dir = path.join(WS, 'memory', 'telemetry');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'usage.jsonl'), JSON.stringify(entry) + '\n');
  } catch { /* telemetry must never break the gate */ }
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
    logUsage({ ts, event: EVENT, decision: 'deny', cause: 'lock-missing', session_id: sid });
    if (EVENT === 'pretooluse') denyTool(reason);
    if (EVENT === 'sessionstart') sessionContext(`⚠ ${reason}`);
    blockExit2(reason);
  }

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

  const byId = new Map(lock.artifacts.map((a) => [a.id, a.sha256]));
  const isPayload = (id) => /^(\.claude\/skills|\.claude\/agents|\.agents\/skills|\.codex\/agents)\//.test(id);
  const coreIds = lock.artifacts.filter((a) => !isPayload(a.id)).map((a) => a.id);
  const checkIds = (ids) => ids
    .map((id) => ({ id, st: artifactState(id, byId.get(id)) }))
    .filter((r) => r.st !== 'ok')
    .map((r) => `${r.id} (${r.st})`);
  const skillArtifact = (name) => (forCodex ? `.agents/skills/${name}/SKILL.md` : `.claude/skills/${name}/SKILL.md`);
  const agentArtifact = (name) => (forCodex ? `.codex/agents/${name}.toml` : `.claude/agents/${name}.md`);
  // STRICT mode: only the compiled toolchain runs. The mode rides in the
  // lock (the tamper-anchored root); a legacy lock without it = normal. Governs
  // ARTIFACTS only — harness built-ins (tools, built-in subagent types) are never gated.
  const strict = lock.mode === 'strict';
  const strictHint = `STRICT workspace: only the compiled toolchain (taut.lock) runs here. Add it to the data pack and recompile, or lift the regime: \`taut apply --mode normal --workspace ${WS}\`.`;

  if (EVENT === 'pretooluse') {
    const tool = input.tool_name ?? '';
    const ti = input.tool_input ?? {};
    // MCP calls reach the gate only where the matcher sends them (strict claude-code
    // widens it; Codex hooks are always broad). Foreign server in strict = deny; the
    // allowed set is the LOCK's serverKeys — the same trust root as everything else.
    if (tool.startsWith('mcp__')) {
      const server = tool.split('__')[1] ?? '';
      const allowed = (lock.mcp ?? []).some((m) => m.serverKey === server);
      if (strict && !allowed) {
        logUsage({ ts, event: 'invoke', kind: 'mcp', name: server, decision: 'deny', cause: 'strict-foreign', session_id: sid });
        denyTool(`TAUT gate: MCP server "${server}" is not in this workspace's manifest. ${strictHint}`);
      }
      logUsage({ ts, event: 'invoke', kind: 'mcp', name: server, decision: 'allow', managed: allowed, session_id: sid });
      process.exit(0);
    }
    let kind = null; let name = null; let id = null;
    if (tool === 'Skill') {
      kind = 'skill';
      name = String(ti.skill ?? ti.name ?? ti.command ?? '').split(/\s+/)[0].replace(/^\//, '');
      id = skillArtifact(name);
    } else if (tool === 'Agent' || tool === 'Task') {
      kind = 'agent';
      name = String(ti.subagent_type ?? '');
      id = agentArtifact(name);
    }
    if (!id || !byId.has(id)) {
      // Not a TAUT-managed artifact. Normal mode: none of our business. Strict mode:
      // a SKILL name outside the lock is always a content artifact -> deny, wherever it
      // lives (workspace folder, user-global, plugin). An AGENT type outside the lock is
      // denied only when a workspace file backs it (a foreign local agent); a type with
      // no file is a harness BUILT-IN (general-purpose, Explore, ...) and stays allowed.
      const foreignAgentFile = kind === 'agent' && name && fs.existsSync(path.join(WS, agentArtifact(name)));
      if (strict && (kind === 'skill' || foreignAgentFile) && name) {
        logUsage({ ts, event: 'invoke', kind, name, decision: 'deny', cause: 'strict-foreign', session_id: sid });
        denyTool(`TAUT gate: ${kind} "${name}" is not part of the compiled toolchain. ${strictHint}`);
      }
      logUsage({ ts, event: 'invoke', kind, name, decision: 'allow', managed: false, session_id: sid });
      process.exit(0); // not a TAUT-managed artifact — none of our business
    }
    const coreBad = checkIds(coreIds);
    if (coreBad.length) {
      logUsage({ ts, event: 'invoke', kind, name, decision: 'deny', cause: 'core-drift', session_id: sid });
      denyTool(`TAUT gate: workspace core artifacts are out of sync (${coreBad.join(', ')}) — refusing to run managed ${kind} "${name}". ${REPAIR_HINT}`);
    }
    const st = artifactState(id, byId.get(id));
    if (st !== 'ok') {
      logUsage({ ts, event: 'invoke', kind, name, decision: 'deny', cause: st.toLowerCase(), session_id: sid });
      denyTool(`TAUT gate: ${kind} "${name}" was modified outside the pipeline (${st}: ${id}). Managed artifacts are use-only. ${REPAIR_HINT}`);
    }
    logUsage({ ts, event: 'invoke', kind, name, decision: 'allow', managed: true, session_id: sid });
    process.exit(0);
  }

  if (EVENT === 'promptsubmit') {
    const bad = checkIds(coreIds);
    if (bad.length) {
      logUsage({ ts, event: 'prompt', decision: 'block', cause: 'core-drift', drifted: bad.length, session_id: sid });
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
      const skillsDir = path.join(WS, forCodex ? '.agents/skills' : '.claude/skills');
      let local = [];
      try { local = fs.readdirSync(skillsDir); } catch { local = []; }
      const foreign = local.filter((n) => !byId.has(skillArtifact(n)) && mentions(text, n));
      if (foreign.length) {
        logUsage({ ts, event: 'expansion', decision: 'block', cause: 'strict-foreign', name: foreign.join(','), session_id: sid });
        blockExit2(`TAUT gate: skill "${foreign.join('", "')}" is not part of the compiled toolchain. ${strictHint}`);
      }
    }
    const invoked = lock.artifacts.filter((a) => {
      const m = a.id.match(/skills\/([^/]+)\/SKILL\.md$/);
      return m && mentions(text, m[1]);
    });
    const bad = checkIds([...coreIds, ...invoked.map((a) => a.id)]);
    if (bad.length) {
      logUsage({ ts, event: 'expansion', decision: 'block', drifted: bad.length, session_id: sid });
      blockExit2(`TAUT gate: blocked — drifted artifacts: ${bad.join(', ')}. ${REPAIR_HINT}`);
    }
    process.exit(0);
  }

  if (EVENT === 'sessionstart') {
    const bad = checkIds([...byId.keys()]);
    logUsage({ ts, event: 'session_start', drifted: bad.length, session_id: sid });
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
    // without either repo present.
    try {
      const local = JSON.parse(fs.readFileSync(path.join(WS, '.taut', 'local.json'), 'utf8'));
      const axes = [
        { label: 'framework', root: local.frameworkRoot, pin: lock.framework?.commit },
        { label: 'data pack', root: local.dataRoot, pin: lock.data?.commit },
      ];
      for (const ax of axes) {
        if (!ax.root || !ax.pin || !isCommit(ax.pin)) continue;
        try {
          const git = { cwd: ax.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
          const head = execFileSync('git', ['rev-parse', 'HEAD'], git).trim();
          if (head && head !== ax.pin) {
            let n = '?';
            try { n = execFileSync('git', ['rev-list', '--count', `${ax.pin}..HEAD`], git).trim(); } catch { /* pin not in history */ }
            notes.push(`TAUT: the ${ax.label} is ${n} commit(s) ahead of this workspace (pin ${ax.pin.slice(0, 7)} → ${head.slice(0, 7)}). Actualize with \`taut update --workspace ${WS}\`.`);
          }
        } catch { /* this axis unreadable — stay silent for it */ }
      }
    } catch { /* no local binding — stay silent */ }
    if (notes.length) sessionContext(notes.join('\n'));
    process.exit(0);
  }

  process.exit(0); // unknown event — no-op
} catch (e) {
  // Fail-closed: an internal gate error must not silently wave tampered artifacts through.
  const reason = `TAUT gate: internal error (${e?.message ?? e}) — blocking as a precaution. ${REPAIR_HINT}`;
  logUsage({ ts, event: EVENT, decision: 'deny', cause: 'gate-error', session_id: sid });
  if (EVENT === 'pretooluse') denyTool(reason);
  if (EVENT === 'sessionstart') sessionContext(`⚠ ${reason}`);
  blockExit2(reason);
}
