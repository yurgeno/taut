// TAUT integrity gate — opencode adapter. Compiled into a workspace as
// .opencode/plugins/taut-gate.js (auto-loaded by opencode from that folder; locked +
// gate-protected like every core artifact). Thin by design: ALL policy and every
// integrity decision live in the sibling gate (.taut/gate.mjs) — this plugin only
// translates opencode's hook surface onto the gate's stdin/stdout contract and enforces
// its verdict by throwing (opencode blocks a tool call whose `tool.execute.before` hook
// throws).
//
// Capability mapping (recorded, surfaced in the workspace instructions):
// - tool.execute.before  → gate `pretooluse` (deny = throw). Covers managed skills
//   (opencode invokes them through its native `skill` TOOL — a cleaner chokepoint than
//   claude-code, where direct /slash bypasses the Skill tool), subagents (task tool),
//   and lock-listed MCP servers.
// - session start        → gate `sessionstart` (telemetry + advisory). Surfacing the
//   banner into the session is BEST-EFFORT (toast when the SDK offers it) — a recorded
//   degradation, never a gate weakening: enforcement does not depend on it.
// - no prompt-time sweep → recorded degradation: opencode has no blocking prompt hook,
//   so drifted CORE artifacts are caught at the first managed tool call, not the first
//   prompt.
// Fail-closed scope: if the gate cannot run (node missing, gate unreadable), the
// GOVERNED surface (skill/task/agent tools) is blocked; harness built-ins stay usable —
// mirroring "harness built-ins are never gated".
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// <ws>/.opencode/plugins/taut-gate.js → the workspace root is two levels up; resolving
// from THIS file (not the hook's cwd or context) keeps the pairing tamper-stable.
const WS = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const GATE = path.join(WS, '.taut', 'gate.mjs');

const GOVERNED = new Set(['skill', 'Skill', 'task', 'Task', 'agent', 'Agent']);

function runGate(event, payload) {
  // The gate answers on stdout (hook JSON) and exits 0 even on deny; a non-zero exit or
  // an unparsable answer counts as "gate unavailable" for the caller to fail-close on.
  const out = execFileSync(process.execPath.endsWith('node') ? process.execPath : 'node',
    [GATE, event, '--harness', 'opencode'],
    { input: JSON.stringify(payload ?? {}), env: { ...process.env, CLAUDE_PROJECT_DIR: WS }, timeout: 30_000 });
  return JSON.parse(out.toString() || '{}');
}

export const TautGate = async ({ client }) => ({
  'tool.execute.before': async (input, output) => {
    const tool = input?.tool ?? '';
    let verdict;
    try {
      verdict = runGate('pretooluse', {
        tool_name: tool,
        tool_input: output?.args ?? {},
        session_id: input?.sessionID,
      });
    } catch (e) {
      if (GOVERNED.has(tool)) throw new Error(`TAUT gate unavailable (${e?.message ?? e}) — refusing to run managed tooling. Heal: taut repair --workspace ${WS}`);
      return; // built-ins are never gated — a broken gate must not brick the whole session
    }
    const d = verdict?.hookSpecificOutput;
    if (d?.permissionDecision === 'deny') throw new Error(d.permissionDecisionReason ?? 'TAUT gate: denied');
  },
  'session.created': async () => {
    // Telemetry + the actualization/integrity advisory. Best-effort by contract: the
    // toast API may differ across opencode versions — any failure here is swallowed
    // (enforcement lives in tool.execute.before, never in this banner).
    try {
      const res = runGate('sessionstart', {});
      const note = res?.hookSpecificOutput?.additionalContext;
      if (note) await client?.tui?.showToast?.({ body: { message: note, variant: 'warning' } });
    } catch { /* advisory only */ }
  },
});
