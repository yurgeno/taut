// Harness ADAPTER CAPABILITIES — what this engine's adapter does with a harness-neutral
// source on each harness, as DATA. Every per-harness surface (render targets, the
// "recorded degradation" sentences in the generated instructions, `status --json`) derives
// from here; a consumer (a linter, a studio, the panel) reads the same record instead of
// re-deriving it from prose in comments. Supporting a new harness = adding an entry here
// plus its adapter seams (install/render/gate) — packs and workspaces never change shape.
//
// The semantics fields are HARNESS facts the adapter honours, not opinions:
//   skillAllowlist  what a SKILL.md `allowed-tools` means once installed there —
//                   'grant' = pre-approves tools (Claude Code: a grant, not a restriction),
//                   'prose' = informational only (the body carries the discipline);
//   agentAllowlist  what an agent's `tools:` means — 'restrict' (native subagent allowlist),
//                   'dropped' (no counterpart in the rendered format), 'prose';
//   promptGate      how the integrity gate reaches a session — 'blocking' (prompt-time hook
//                   denies), 'banner' (best-effort session-start banner + tool-call checks).
export interface HarnessAdapter {
  id: string;
  title: string;
  skillsDir: string;          // where compiled skills land in the workspace
  agentsDir: string;          // where compiled subagents land
  agentFormat: 'md' | 'toml';
  instructionsFile: string;   // CLAUDE.md | AGENTS.md
  mcpConfig: string;          // .mcp.json | .codex/config.toml | opencode.json
  skillAllowlist: 'grant' | 'prose';
  agentAllowlist: 'restrict' | 'dropped' | 'prose';
  promptGate: 'blocking' | 'banner';
  mcpToolNaming: string;      // how the harness advertises an MCP tool
  degradations: { id: string; text: string }[];   // rendered VERBATIM into the instructions
}

export const HARNESS_CAPS: Record<string, HarnessAdapter> = {
  'claude-code': {
    id: 'claude-code',
    title: 'Claude Code',
    skillsDir: '.claude/skills',
    agentsDir: '.claude/agents',
    agentFormat: 'md',
    instructionsFile: 'CLAUDE.md',
    mcpConfig: '.mcp.json',
    skillAllowlist: 'grant',
    agentAllowlist: 'restrict',
    promptGate: 'blocking',
    mcpToolNaming: 'mcp__{server}__{tool}',
    degradations: [],
  },
  codex: {
    id: 'codex',
    title: 'Codex',
    skillsDir: '.agents/skills',
    agentsDir: '.codex/agents',
    agentFormat: 'toml',
    instructionsFile: 'AGENTS.md',
    mcpConfig: '.codex/config.toml',
    skillAllowlist: 'prose',
    agentAllowlist: 'dropped',
    promptGate: 'blocking',
    mcpToolNaming: 'mcp__{server}__{tool}',
    degradations: [
      { id: 'codex-skill-allowlist', text: 'Claude-Code frontmatter tool allowlists are informational here.' },
      { id: 'codex-agent-tools', text: 'A subagent `tools:` allowlist has no TOML counterpart and is dropped on render — the body carries the methodology; a deployment `agentSandbox` value renders as that agent\'s `sandbox_mode` (mechanical read-only where declared).' },
      { id: 'codex-hook-trust', text: 'Codex runs the project gate hooks only once this workspace\'s `.codex/` layer is trusted, and skips a hook whose command changed until it is approved again (`/hooks`) — after an update that rewires the gate, approve the hooks before working.' },
    ],
  },
  opencode: {
    id: 'opencode',
    title: 'opencode',
    skillsDir: '.agents/skills',
    agentsDir: '.opencode/agents',
    agentFormat: 'md',
    instructionsFile: 'AGENTS.md',
    mcpConfig: 'opencode.json',
    skillAllowlist: 'prose',
    agentAllowlist: 'prose',
    promptGate: 'banner',
    mcpToolNaming: '{server}_{tool}',
    degradations: [
      { id: 'opencode-no-prompt-sweep', text: 'there is no prompt-time integrity sweep — drifted core artifacts are caught at the first managed tool call instead of the first prompt' },
      { id: 'opencode-banner', text: 'the session-start banner is best-effort' },
      { id: 'opencode-allowlist', text: 'Claude-Code frontmatter tool allowlists are informational here' },
      { id: 'opencode-mcp-naming', text: 'MCP tools are advertised as `<serverKey>_<tool>`, not `mcp__<serverKey>__<tool>`' },
    ],
  },
};

// The adapter registry in canonical order — the engine's single source for "which
// harnesses exist" (constants.HARNESSES re-exports this list).
export const HARNESS_IDS: string[] = Object.keys(HARNESS_CAPS);

export const harnessCaps = (id: string): HarnessAdapter => {
  const h = HARNESS_CAPS[id];
  if (!h) throw new Error(`unknown harness "${id}" (adapters: ${HARNESS_IDS.join(', ')})`);
  return h;
};
