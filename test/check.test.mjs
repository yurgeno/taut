// Readiness-check surface (`taut check`): the deterministic session-readiness sweep —
// integrity, live gate self-test, repo reachability, shipped-data readability, memory,
// and the real MCP stdio handshake (probed against a local fake server, no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLI, run, suite } from './helpers.mjs';

const { TMP, reset, makePack, makeRepo, setup } = suite('check');
const FAKE_MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp.mjs');

let repoB;
before(async () => {
  await reset();
  await makePack();
  repoB = await makeRepo('repo-beta');
});
after(reset);

test('check: a member repo with no commits yet is reachable, not "git unreadable"', async () => {
  // The quickstart stubs a repo with `git init` — an UNBORN HEAD must read as a known
  // branch, not as a broken repo (rev-parse HEAD fails on a commitless branch).
  const fresh = path.join(TMP, 'repos', 'repo-fresh');
  await fs.mkdir(fresh, { recursive: true });
  await run('git', ['-C', fresh, 'init', '-q']);
  const { ws } = await setup('check-unborn', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [fresh],
  });
  const r = await run(process.execPath, [CLI, 'check', '--workspace', ws]);
  assert.match(r.stdout, /repo-fresh@\S+ \(no commits yet\)/);
  assert.doesNotMatch(r.stdout, /git unreadable/);
  assert.match(r.stdout, /READY/);
});

test('check: atlas row — engine binding verified when enabled; a vanished engine flips to NOT READY', async () => {
  const engineDir = path.join(TMP, 'atlas-engine');
  await fs.mkdir(engineDir, { recursive: true });
  await fs.writeFile(path.join(engineDir, 'atlas.mjs'), '// engine stub\n');
  const { ws } = await setup('check-atlas', {
    harness: 'claude-code', atlas: engineDir, skills: 'all', mcp: [], repos: [repoB],
  });
  const r = await run(process.execPath, [CLI, 'check', '--workspace', ws]);
  assert.match(r.stdout, /engine at .*atlas-engine/);
  await fs.rm(path.join(engineDir, 'atlas.mjs'));
  await assert.rejects(
    run(process.execPath, [CLI, 'check', '--workspace', ws]),
    (e) => e.code === 1 && /NOT READY/.test(e.stdout) && /no atlas\.mjs/.test(e.stdout),
  );
  await fs.writeFile(path.join(engineDir, 'atlas.mjs'), '// engine stub\n');
});

test('check: green workspace is READY; unreachable repo and drift flip it to NOT READY', async () => {
  const { ws } = await setup('check-green', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const r = await run(process.execPath, [CLI, 'check', '--workspace', ws]);
  assert.match(r.stdout, /READY/);
  assert.match(r.stdout, /integrity/);
  assert.match(r.stdout, /live gate allows managed/);
  assert.match(r.stdout, /repo-beta@/, 'repo branch reported');
  assert.match(r.stdout, /data file\(s\) readable/);
  assert.match(r.stdout, /no MCP servers configured/);

  // Unreachable repo path → NOT READY with the repo named.
  const localPath = path.join(ws, '.taut', 'local.json');
  const local = JSON.parse(await fs.readFile(localPath, 'utf8'));
  const saved = local.repoPaths['repo-beta'];
  local.repoPaths['repo-beta'] = path.join(TMP, 'nowhere');
  await fs.writeFile(localPath, JSON.stringify(local, null, 2) + '\n');
  await assert.rejects(
    run(process.execPath, [CLI, 'check', '--workspace', ws]),
    (e) => e.code === 1 && /NOT READY/.test(e.stdout) && /repo-beta/.test(e.stdout),
  );
  local.repoPaths['repo-beta'] = saved;
  await fs.writeFile(localPath, JSON.stringify(local, null, 2) + '\n');

  // Drifted artifact → integrity fails (and the JSON contract carries the verdict).
  await fs.appendFile(path.join(ws, '.claude', 'skills', 'fx-task', 'SKILL.md'), '\nhack\n');
  await assert.rejects(
    run(process.execPath, [CLI, 'check', '--workspace', ws, '--json']),
    (e) => {
      const out = JSON.parse(e.stdout);
      return e.code === 1 && out.verdict === 'NOT READY'
        && out.results.some((x) => x.area === 'integrity' && x.status === 'fail');
    },
  );
});

test('check: strict self-test enforced + a real MCP handshake against a local fake server', async () => {
  // A tiny pack whose catalog points "context7" at the local fake stdio server — the
  // handshake is REAL (spawn + JSON-RPC initialize) with zero network.
  const packRoot = path.join(TMP, 'check-pack');
  await fs.mkdir(path.join(packRoot, 'skills', 'base'), { recursive: true });
  await fs.mkdir(path.join(packRoot, 'catalog'), { recursive: true });
  await fs.writeFile(path.join(packRoot, 'skills', 'base', 'SKILL.md'),
    '---\nname: base\ndescription: base skill\n---\nbody\n');
  await fs.writeFile(path.join(packRoot, 'catalog', 'mcp.json'), JSON.stringify({
    servers: {
      context7: {
        role: 'docs', serverKey: 'context7', package: 'fake-mcp', pin: '1.0.0',
        command: process.execPath, args: [FAKE_MCP, '--serve'], env: ['FAKE_MCP_NAME'], fixedEnv: {},
      },
    },
    envHelp: {},
  }));
  const ws = path.join(TMP, 'ws', 'check-mcp');
  const answersFile = path.join(TMP, 'check-mcp.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'none', harness: 'claude-code', atlas: false, mode: 'strict',
    skills: ['base'], mcp: ['context7'], workspace: ws, repos: [repoB],
  }));
  const env = { env: { ...process.env, TAUT_DATA: packRoot } };
  await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes'], env);

  // The .mcp.json points every server at the workspace LAUNCHER — the handshake below
  // runs the real chain: .mcp.json → .taut/mcp-launch.mjs → server.
  const mcpJson = JSON.parse(await fs.readFile(path.join(ws, '.mcp.json'), 'utf8'));
  assert.equal(mcpJson.mcpServers.context7.command, 'node');
  assert.match(mcpJson.mcpServers.context7.args.join(' '), /mcp-launch\.mjs context7/);
  assert.equal(mcpJson.mcpServers.context7.env, undefined, 'no env placeholders — the launcher owns env');

  const r = await run(process.execPath, [CLI, 'check', '--workspace', ws]);
  assert.match(r.stdout, /strict regime enforced \(foreign probe denied\)/);
  assert.match(r.stdout, /mcp:context7/);
  assert.match(r.stdout, /server: fake-mcp/, 'the stdio initialize round-trip succeeded through the launcher');
  assert.match(r.stdout, /env EMPTY: FAKE_MCP_NAME/, 'declared-but-unfilled key warned');
  assert.match(r.stdout, /READY/);

  // Fill local.env — and ONLY local.env (nothing exported in this process): the value
  // must reach the server through the launcher. The server signals PRESENCE (ENV-DELIVERED)
  // so we prove delivery; the report must NOT contain the secret value itself (S5 redaction).
  const envPath = path.join(ws, '.taut', 'local.env');
  const envText = await fs.readFile(envPath, 'utf8');
  await fs.writeFile(envPath, envText.replace(/^FAKE_MCP_NAME=$/m, 'FAKE_MCP_NAME=env-injected-secret'));
  const r2 = await run(process.execPath, [CLI, 'check', '--workspace', ws]);
  assert.match(r2.stdout, /server: ENV-DELIVERED/, 'local.env value delivered with zero exports');
  assert.ok(!/env-injected-secret/.test(r2.stdout), 'the filled secret VALUE is redacted from the report');
  assert.ok(!/env EMPTY/.test(r2.stdout), 'warning cleared once filled');
});
