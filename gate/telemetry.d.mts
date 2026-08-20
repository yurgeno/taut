// Type surface of the telemetry adapter (gate/telemetry.mjs) for the TypeScript
// compiler modules that import it — the adapter itself stays plain JS (a shipped,
// self-contained workspace artifact, like the gate).
export declare const TELEMETRY_LEVELS: string[];
export declare function normalizeLevel(v: unknown): 'basic' | 'extended';
export declare function localDay(d?: Date): string;
export interface Telemetry {
  level: 'basic' | 'extended';
  log(entry: Record<string, unknown>): void;
}
export declare function createTelemetry(opts?: {
  workspace?: string;
  level?: unknown;
  meta?: Record<string, unknown> | null;
}): Telemetry;
