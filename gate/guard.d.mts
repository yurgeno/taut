// Type surface of the command guard (gate/guard.mjs) for the TypeScript compiler modules
// that import it — the guard itself stays plain JS (a shipped, self-contained workspace
// artifact, like the gate).
export declare const SECTIONS: string[];
export interface Safeguards {
  tools?: string[];
  files?: string[];
  commands?: string[];
  git?: string[];
  observe?: string[];
}
export declare function normalizeSafeguards(raw: unknown): Safeguards | null;
export declare function evaluate(toolName: string, toolInput: unknown, safeguards: Safeguards | null | undefined):
  { section: string; rule: string; observe: boolean; reason: string } | null;
