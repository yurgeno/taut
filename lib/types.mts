// TAUT compiler — the central data model: the shapes that cross
// module boundaries. Parse boundaries (frontmatter, pack-authored JSON, workspace files
// read back) stay `any` at the edge — the types below document the CONTRACT the compiler
// maintains once data is inside. Behavior-neutral by design: types only, no runtime code.

// CLI options as parsed by taut.mjs (the entry stays a thin plain-JS shell; every
// command consumes this shape).
export interface CliOpts {
  _: string[];
  skillsOn: string[];
  skillsOff: string[];
  mcpOn: string[];
  mcpOff: string[];
  reposOn: string[];
  reposOff: string[];
  harnessOn: string[];
  harnessOff: string[];
  answers?: string;
  workspace?: string;
  data?: string;
  yes?: boolean;
  json?: boolean;
  source?: boolean;
  fromDeployment?: boolean;
  dataOnly?: boolean;
  port?: number;
  mode?: string;
  chatLanguage?: string;
  help?: boolean;
}

// A connected member repo (name = folder basename, unique per workspace).
export interface Repo { name: string; path: string }

// Per-repo values in a deployment's known map (pack-authored; role/guards pass through
// into the generated manifest).
export interface KnownRepo { role?: string; guards?: unknown }

// A deployment profile = <project>/deployment.json + its resolved pack dir. The
// `manifest` bag passes VERBATIM into the generated manifest (compiler-owned keys
// stripped), so it stays loosely typed by design.
export interface Profile {
  name: string;
  description?: string;
  dir: string | null;
  mode?: string;
  repos?: { mandatory?: string[]; known?: Record<string, KnownRepo> };
  manifest?: Record<string, any>;
}

// metadata.taut — an artifact's own wiring declaration (frontmatter).
export interface TautWiring {
  agents?: string[];
  requires?: string[];
  mcp?: string[];
  repos?: string[];
  role?: string;
}

export interface SkillEntry { path: string; origin: string; description: string; meta: TautWiring }
export interface AgentEntry { path: string; origin: string }
export interface FlowDocEntry { name: string; description: string; sequence: string[]; path: string }
export interface RunbookEntry { name: string; description: string; repos: string[]; path: string }
export interface DocEntry { name: string; path: string }
export interface RepoDocFile { file: string; path: string }

// Everything the data pack (+ the selected deployment) can install, resolved by name.
export interface Catalog {
  skills: Map<string, SkillEntry>;
  agents: Map<string, AgentEntry>;
  flowDocs: FlowDocEntry[];
  laws: { path: string; summary: string[] } | null;
  runbooks: RunbookEntry[];
  docs: DocEntry[];
  repoDocs: Map<string, RepoDocFile[]>;
}

// The compile configuration — built by gatherConfig (setup) or cfgFromWorkspace
// (repair/update/apply), consumed by every install/render/lock step. The three derived
// fields at the bottom are (re)computed by relintRepoBindings.
export interface Cfg {
  workspace: string;
  profile: Profile | null;
  catalog: Catalog;
  // Enabled harnesses, canonical HARNESSES order, never empty. Every enabled harness
  // gets its full native artifact set (the trees are disjoint by construction).
  harnesses: string[];
  atlas: boolean;
  // Atlas engine folder — a machine-local PATH, persisted in .taut/local.json next to
  // the repo paths (never in the manifest). Setup REQUIRES it whenever atlas is
  // enabled; null on legacy workspaces that recorded only the flag.
  atlasRoot?: string | null;
  mode: string;
  // Session-communication language CHOSEN for this workspace — set only when the
  // deployment declares a choice (defaults.languages.chat = {options[], default});
  // null = the deployment fixes the language (flat value) or has none. The resolved
  // code compiles into the manifest as the flat defaults.languages.chat.
  chatLanguage?: string | null;
  skills: string[];
  skillsSelection: 'all' | 'custom';
  skillsExcluded: string[];
  mcp: string[];
  repos: Repo[];
  warnings: string[];
  runbooks?: RunbookEntry[];
  lintWarnings?: string[];
  repoExcludedSkills?: Set<string>;
}

// One MCP catalog entry (catalog/mcp.json — pack- or project-authored).
export interface McpServer {
  role: string;
  serverKey: string;
  package: string;
  pin: string;
  command: string;
  args: string[];
  env: string[];
  fixedEnv: Record<string, string>;
  usage?: string;
}

// One taut.lock artifact row. `source`/`from` drive verify --source re-derivation
// (absent `from` = the framework repo — v1-lock compatible); `transform: 'gates'`
// records the capability-marker pass.
export interface ArtifactRow {
  id: string;
  sha256: string;
  source?: string;
  from?: 'data';
  transform?: 'gates';
}

export interface Lock {
  lockVersion: number;
  framework: { commit: string | null; canonical: boolean };
  data?: { commit: string | null; canonical: boolean | null; pack: string | null };
  generatedAt: string;
  harnesses: string[];
  harness?: string; // legacy (lock v1/v2 scalar) — read-only fallback, never written
  // Model profile's session pin per enabled harness (modelTiers.sessionTier) — the
  // gate's session-start advisory compares the live model against it. Absent = no policy.
  session?: Record<string, { model?: string; effort?: string }>;
  atlas: boolean;
  mode?: string;
  artifacts: ArtifactRow[];
  mcp: { id: string; role: string; serverKey: string; package: string; pin: string; runner: string }[];
}

// What lies between a workspace's pinned commit and a repo HEAD (status/update).
export interface RepoDelta {
  head: string | null;
  behind: number | null;
  files: string[];
  pinKnown: boolean;
}

// Member instruction-file scan row (informational inventory in local.json).
export interface MemberFile { repo: string; file: string; signals: string[] }

// The machine contract: `status --json` prints it, the panel serves it.
export interface StatusData {
  workspace: string;
  deployment: string | null;
  harnesses: string[];
  atlas: boolean;
  generatedAt: string;
  framework: {
    pin: string | null;
    head: string | null;
    behind: number | null;
    pinKnown: boolean;
    canonical: boolean;
    changedFiles: string[];
  };
  data: {
    pack: string | null;
    root: string;
    pin: string | null;
    head: string | null;
    behind: number | null;
    pinKnown: boolean;
    canonical: boolean;
    changedFiles: string[];
  } | null;
  artifacts: { total: number; drifted: string[] };
  mcp: { id: string; pin: string; catalogPin: string | null }[];
  current: boolean;
}
