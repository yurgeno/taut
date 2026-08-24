// TAUT panel — the ACTING local UI: one loopback HTTP server serving a
// self-contained page (lib/panel.html — kept as a real HTML file so the client code
// needs no JS-string escaping) + a small JSON API. Reads are computed in-process
// (statusData + the artifact catalog); MUTATIONS shell out to this framework's own CLI
// (update / repair / apply) — the CLI is the single semantic surface, its output is the
// action log verbatim, and a failing action can never take the server down. CSRF stance
// for a mutating localhost panel: bind 127.0.0.1 only; POST requires a per-session
// token in a CUSTOM header (cross-origin that forces a preflight we never answer) + an
// Origin check; responses carry no CORS headers, so foreign pages cannot read anything.
// Secrets: the page sees env var NAMES and a filled/empty flag — never values.
// Three tabs: Control (skills/MCP toggles + actions), Docs — a
// browser over the workspace's shipped documentation (.taut/docs/*.md + LAWS.md),
// rendered client-side by a mini markdown subset.
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { FW_ROOT, HARNESSES, MCP_CATALOG, initDataFor } from './constants.mts';
import { atlasRequired, lintRepoBindings, loadCatalog } from './artifacts.mts';
import { listDeployments, scanRepos } from './config.mts';
import { statusData } from './commands.mts';
import { memoryRootFor } from './install.mts';
import { exists, expandHome, fail, readIfExists } from './util.mts';
import type { CliOpts } from './types.mts';

const CLI = path.join(FW_ROOT, 'taut.mjs');
const PAGE = readFileSync(path.join(FW_ROOT, 'lib', 'panel.html'), 'utf8');
const renderPage = (token: string): string => PAGE.replace('%%TOKEN%%', token);

// ---------------------------------------------------------------- docs (read-only)

// The Docs tab lists the workspace's SHIPPED documentation: .taut/LAWS.md first,
// then every markdown in .taut/docs/. Names only — content is served per file.
// Legacy fallback: a pre-rename workspace keeps its docs under .federation/ until its
// first recompile migrates the layout — the panel must still show them.
async function docsRoot(ws: string): Promise<string> {
  const modern = path.join(ws, '.taut');
  try { await fs.access(modern); return modern; } catch { return path.join(ws, '.federation'); }
}

async function listDocs(ws: string): Promise<string[]> {
  const root = await docsRoot(ws);
  const out: string[] = [];
  if (await readIfExists(path.join(root, 'LAWS.md')) !== null) out.push('LAWS.md');
  let names: string[] = [];
  try {
    names = (await fs.readdir(path.join(root, 'docs')))
      .filter((f) => f.endsWith('.md')).sort();
  } catch { /* no docs dir shipped */ }
  return [...out, ...names];
}

const DOC_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/; // no separators — traversal-proof

async function readDoc(ws: string, name: string): Promise<string | null> {
  if (!DOC_NAME.test(name)) return null;
  const root = await docsRoot(ws);
  const p = name === 'LAWS.md'
    ? path.join(root, 'LAWS.md')
    : path.join(root, 'docs', name);
  return readIfExists(p, 1024 * 1024);
}

// ---------------------------------------------------------------- memory (read-only)

// The Memory tab browses the workspace's INSTANCE data (the sibling memory folder) —
// strictly read-only: the panel never writes there (the guarantee stays structural).
// Dotfiles are hidden; entry/depth caps guard a runaway tree as memory grows.
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.jsonl', '.patch', '.diff', '.log',
  '.yaml', '.yml', '.csv', '.html', '.xml', '.mjs', '.js', '.ts']);
const IMG_TYPE: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
const MEM_TEXT_CAP = 512 * 1024;

interface MemNode { name: string; type: 'dir' | 'file'; children?: MemNode[]; size?: number | null }

async function memoryTree(root: string): Promise<{ tree: MemNode[]; truncated: boolean }> {
  let count = 0;
  let truncated = false;
  const walk = async (dir: string, depth: number): Promise<MemNode[]> => {
    if (depth > 12) return [];
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
    entries = entries.filter((e) => !e.name.startsWith('.'));
    entries.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name));
    const out: MemNode[] = [];
    for (const e of entries) {
      if (count >= 5000) { truncated = true; break; }
      count += 1;
      if (e.isDirectory()) out.push({ name: e.name, type: 'dir', children: await walk(path.join(dir, e.name), depth + 1) });
      else if (e.isFile()) {
        let size: number | null = null;
        try { size = (await fs.stat(path.join(dir, e.name))).size; } catch { /* raced away */ }
        out.push({ name: e.name, type: 'file', size });
      }
    }
    return out;
  };
  return { tree: await walk(root, 0), truncated };
}

// Structural path validation — segments only, no dotfiles, no traversal; the resolved
// path must stay inside the memory root (belt).
function memPath(root: string, rel: string): string | null {
  if (!rel || rel.length > 1024) return null;
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) return null;
  const abs = path.resolve(root, ...parts);
  return abs.startsWith(root + path.sep) ? abs : null;
}

async function readMemFile(root: string, rel: string): Promise<{ code: number; body: any }> {
  const abs = memPath(root, rel);
  if (!abs) return { code: 400, body: { error: 'bad path' } };
  let st: import('node:fs').Stats | null = null;
  try { st = await fs.stat(abs); } catch { /* absent */ }
  if (!st?.isFile()) return { code: 404, body: { error: `no such file: ${rel}` } };
  const ext = path.extname(abs).toLowerCase();
  if (IMG_TYPE[ext]) return { code: 200, body: { name: rel, image: true, size: st.size } };
  const buf = await fs.readFile(abs);
  const slice = buf.subarray(0, MEM_TEXT_CAP);
  if (!TEXT_EXT.has(ext) && slice.includes(0))
    return { code: 200, body: { name: rel, binary: true, size: st.size } };
  return {
    code: 200,
    body: { name: rel, size: st.size, truncated: buf.length > MEM_TEXT_CAP, text: slice.toString('utf8') },
  };
}

// ---------------------------------------------------------------- state (read-only)

async function stateFor(ws: string): Promise<any> {
  const status = await statusData(ws);
  const manifest = JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));
  const profile = manifest.deployment
    ? (await listDeployments()).find((d) => d.name === manifest.deployment) ?? null : null;
  const catalog = await loadCatalog(profile);
  const local = JSON.parse(
    await readIfExists(path.join(ws, '.taut', 'local.json'), 1024 * 1024)
    ?? await readIfExists(path.join(ws, '.federation', 'local.json'), 1024 * 1024)
    ?? '{}');
  const connected = new Set<string>(Object.keys(local.repoPaths ?? {}));
  const repoExcluded = lintRepoBindings(
    [...catalog.skills].map(([n, s]) => ({ kind: 'skill', name: n, repos: s.meta.repos })),
    profile, connected, []);
  const atlasReq = atlasRequired(catalog);
  const atlas = Boolean(manifest.atlas?.enabled);
  const installed = new Set(manifest.skills ?? []);

  const skills = [...catalog.skills].map(([name, s]) => ({
    name,
    description: s.description,
    origin: s.origin,
    installed: installed.has(name),
    excluded: (manifest.skillsExcluded ?? []).includes(name),
    blocked: (!atlas && atlasReq.includes(name)) ? 'requires atlas'
      : repoExcluded.has(name)
        ? `repo-excluded: ${(s.meta.repos ?? []).filter((r) => !connected.has(r)).join(', ')}`
        : null,
    agents: s.meta.agents ?? [],
  }));

  // local.env: names + filled/empty only — a secret VALUE never crosses this boundary.
  const envText = await readIfExists(path.join(ws, '.taut', 'local.env'))
    ?? await readIfExists(path.join(ws, '.federation', 'local.env')) ?? '';
  const envStatus: Record<string, boolean> = {};
  for (const line of envText.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) envStatus[m[1]] = m[2].length > 0;
  }
  const installedMcp = new Set(Object.values<any>(manifest.mcp ?? {}).map((m) => m.id));
  const mcp = Object.entries(MCP_CATALOG).map(([id, c]) => ({
    id,
    role: c.role,
    package: c.package,
    pin: c.pin,
    installed: installedMcp.has(id),
    env: c.env.map((k) => ({ name: k, filled: envStatus[k] ?? false })),
  }));

  // Repo checklist: the union of CONNECTED repos (local.json paths)
  // and profile-KNOWN repos found by scanning the workspace-parent root (connectable
  // candidates; without a profile every scanned repo is offered). Each row carries its
  // descriptor coverage — files in the pack + whether any is still an unfilled skeleton
  // (an add of an uncovered repo scaffolds one; the chip tells the owner to distill).
  const repoRows = new Map<string, { name: string; path: string; connected: boolean }>();
  for (const [n, p] of Object.entries<string>(local.repoPaths ?? {})) repoRows.set(n, { name: n, path: p, connected: true });
  const scan = await scanRepos(path.dirname(ws), [ws]);
  const knownNames = profile
    ? new Set([...(profile.repos?.mandatory ?? []), ...Object.keys(profile.repos?.known ?? {})])
    : null;
  for (const r of scan.repos) {
    if (repoRows.has(r.name)) continue;
    if (knownNames && !knownNames.has(r.name)) continue;
    repoRows.set(r.name, { name: r.name, path: r.path, connected: false });
  }
  const mandatorySet = new Set(profile?.repos?.mandatory ?? []);
  const repos = await Promise.all([...repoRows.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(async (r) => {
      // Coverage comes from either home: the pack's shipped files, or the workspace-owned
      // instance descriptor (repos/<name>/descriptor.md) that the compile scaffolds for
      // repos the pack does not cover.
      const paths = (catalog.repoDocs?.get(r.name) ?? []).map((f) => f.path);
      if (!paths.length) {
        const inst = path.join(ws, 'repos', r.name, 'descriptor.md');
        if (await exists(inst)) paths.push(inst);
      }
      let skeleton = false;
      for (const f of paths) {
        const text = await readIfExists(f, 256 * 1024);
        if (text?.includes('STATUS: SKELETON')) { skeleton = true; break; }
      }
      return {
        ...r,
        mandatory: mandatorySet.has(r.name),
        role: profile?.repos?.known?.[r.name]?.role ?? null,
        descriptorFiles: paths.length,
        skeleton,
      };
    }));

  return {
    status,
    deployment: manifest.deployment ?? null,
    harnesses: manifest.harnesses ?? (manifest.harness ? [manifest.harness] : []),
    harnessesAvailable: [...HARNESSES],
    atlas,
    mode: manifest.mode ?? 'normal',
    skillsSelection: manifest.skillsSelection ?? 'custom',
    skillsExcluded: manifest.skillsExcluded ?? [],
    skills,
    agents: manifest.agents ?? [],
    mcp,
    repos,
    docs: await listDocs(ws),
    memoryRoot: local.memoryRoot ?? null,
  };
}

// ---------------------------------------------------------------- actions (via CLI)

function runCli(args: string[]): Promise<{ ok: boolean; log: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout, stderr) => resolve({
        ok: !err,
        log: `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim(),
      }));
  });
}

// ---------------------------------------------------------------- server

export async function startPanel(ws: string, { port = 0, data = null }: { port?: number; data?: string | null } = {}): Promise<{ server: Server; token: string; port: number; close: () => Promise<unknown> }> {
  await initDataFor({ explicit: data, ws }); // reads (state/catalog) need the pack
  const token = crypto.randomBytes(16).toString('hex');
  let busy = false;
  let boundPort = 0; // filled on listen; the Host/Origin guards below pin to it

  // DNS-rebinding guard: a foreign page that re-points a hostname at 127.0.0.1 still
  // sends its own Host header — reject anything but this loopback origin, so even GETs
  // (which carry the token in the served page) can't be read cross-origin.
  const hostOk = (host: string | undefined): boolean =>
    host === `127.0.0.1:${boundPort}` || host === `localhost:${boundPort}`;

  const server = createServer(async (req, res) => {
    const send = (code: number, body: any, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(type === 'application/json' ? JSON.stringify(body, null, 2) : body);
    };
    try {
      if (!hostOk(req.headers.host)) return send(403, { error: 'bad host' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const { pathname } = url;
      if (req.method === 'GET' && pathname === '/') return send(200, renderPage(token), 'text/html; charset=utf-8');
      if (req.method === 'GET' && pathname === '/api/state') return send(200, await stateFor(ws));
      if (req.method === 'GET' && pathname === '/api/doc') {
        const name = url.searchParams.get('name') ?? '';
        if (!DOC_NAME.test(name)) return send(400, { error: 'bad doc name' });
        const text = await readDoc(ws, name);
        if (text === null) return send(404, { error: `no such doc: ${name}` });
        return send(200, { name, text });
      }
      if (req.method === 'GET' && pathname === '/api/memory') {
        const root = memoryRootFor(ws);
        return send(200, { root, ...(await memoryTree(root)) });
      }
      if (req.method === 'GET' && pathname === '/api/memfile') {
        const r = await readMemFile(memoryRootFor(ws), url.searchParams.get('path') ?? '');
        return send(r.code, r.body);
      }
      if (req.method === 'GET' && pathname === '/api/memraw') {
        // Raw bytes for IMAGE extensions only (rendered via <img>, never executed).
        const abs = memPath(memoryRootFor(ws), url.searchParams.get('path') ?? '');
        const type = abs ? IMG_TYPE[path.extname(abs).toLowerCase()] : null;
        if (!abs || !type) return send(400, { error: 'not an image path' });
        try {
          const buf = await fs.readFile(abs);
          if (buf.length > 10 * 1024 * 1024) return send(413, { error: 'image too large' });
          // sandbox: an SVG written into memory by an agent must not run script in the
          // panel's origin if opened directly; nosniff keeps the declared type honest.
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store',
            'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' });
          return res.end(buf);
        } catch { return send(404, { error: 'no such file' }); }
      }
      if (req.method === 'POST') {
        if (req.headers['x-taut-token'] !== token) return send(403, { error: 'bad or missing token' });
        const origin = req.headers.origin;
        if (origin && origin !== `http://127.0.0.1:${boundPort}` && origin !== `http://localhost:${boundPort}`)
          return send(403, { error: 'bad origin' });
        if (busy) return send(409, { error: 'another action is still running' });
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1024 * 1024) return send(413, { error: 'request body too large' });
        }
        const payload = body ? JSON.parse(body) : {};
        let args: string[] | null = null;
        if (pathname === '/api/check') args = ['check', '--workspace', ws];
        else if (pathname === '/api/repair') args = ['repair', '--workspace', ws];
        else if (pathname === '/api/update') args = ['update', '--workspace', ws, ...(payload.fromDeployment ? ['--from-deployment'] : []), ...(payload.dataOnly ? ['--data-only'] : [])];
        else if (pathname === '/api/apply') {
          args = ['apply', '--workspace', ws];
          for (const s of payload.skills?.enable ?? []) args.push('--enable-skill', s);
          for (const s of payload.skills?.disable ?? []) args.push('--disable-skill', s);
          for (const m of payload.mcp?.enable ?? []) args.push('--enable-mcp', m);
          for (const m of payload.mcp?.disable ?? []) args.push('--disable-mcp', m);
          for (const r of payload.repos?.connect ?? []) args.push('--connect-repo', r);
          for (const r of payload.repos?.disconnect ?? []) args.push('--disconnect-repo', r);
          for (const h of payload.harness?.enable ?? []) args.push('--enable-harness', h);
          for (const h of payload.harness?.disable ?? []) args.push('--disable-harness', h);
          if (payload.mode) args.push('--mode', String(payload.mode));
        }
        if (!args) return send(404, { error: 'unknown endpoint' });
        busy = true;
        try { return send(200, await runCli(args)); } finally { busy = false; }
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(500, { error: (e as Error).message });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      boundPort = (server.address() as AddressInfo).port; // pins the Host/Origin guards
      resolve({
        server,
        token,
        port: boundPort,
        close: () => new Promise((r) => { server.close(r); }),
      });
    });
  });
}

export async function cmdPanel(opts: CliOpts): Promise<void> {
  const ws = path.resolve(expandHome(opts.workspace ?? process.cwd()));
  if (await readIfExists(path.join(ws, 'manifest.json')) === null)
    fail(`no manifest.json in ${ws} — not a TAUT workspace`);
  if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535))
    fail(`invalid --port (expected an integer 0-65535)`);
  const { port } = await startPanel(ws, { port: opts.port ?? 0, data: opts.data ?? null });
  const url = `http://127.0.0.1:${port}/`;
  process.stdout.write(`TAUT panel · ${url}\n  workspace: ${ws}\n  loopback-only; mutating actions token-guarded. Ctrl-C to stop.\n`);
  try {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch { /* open the printed URL manually */ }
}
