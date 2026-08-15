#!/usr/bin/env node
// TAUT MCP launcher — compiled into a workspace as .taut/mcp-launch.mjs and set as the
// COMMAND of every MCP server in .mcp.json / .codex/config.toml. Purpose: make
// .taut/local.env the ONLY thing a developer touches — no `set -a; source …` before
// launching the harness. The harness starts this launcher; it reads local.env ITSELF,
// resolves the real server spec from .taut/mcp-servers.json, and execs the server with
// the merged environment, piping stdio through untouched.
//
// Env precedence (documented in the generated local.env header):
//   parent process env  <  FILLED local.env values  <  spec.fixedEnv
// - an EMPTY local.env line never erases a var exported in the parent environment;
// - fixedEnv is framework-mandated config (e.g. READ_ONLY_MODE) — never user-overridable.
// Self-contained (node builtins only); locked + gate-protected like every core artifact.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WS = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // <ws>/.taut/..
const id = process.argv[2] ?? '';

let spec;
try { spec = JSON.parse(fs.readFileSync(path.join(WS, '.taut', 'mcp-servers.json'), 'utf8'))[id]; }
catch { /* handled below */ }
if (!spec) {
  process.stderr.write(`taut mcp-launch: unknown or unreadable server spec "${id}" (.taut/mcp-servers.json) — run \`taut repair\`\n`);
  process.exit(1);
}

const env = { ...process.env };
try {
  for (const line of fs.readFileSync(path.join(WS, '.taut', 'local.env'), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && m[2]) env[m[1]] = m[2];
  }
} catch { /* no local.env — parent env only */ }
Object.assign(env, spec.fixedEnv ?? {});

const child = spawn(spec.command, spec.args ?? [], { env, stdio: 'inherit' });
child.on('error', (e) => { process.stderr.write(`taut mcp-launch: ${spec.command} failed to start — ${e.message}\n`); process.exit(1); });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
