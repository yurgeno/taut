// D3 surface: the apply command (toggles through the compile chokepoint) and the acting
// panel (loopback server, token guard, actions via the CLI).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CLI, exists, run, suite } from './helpers.mjs';
import { startPanel } from '../lib/panel.mts';

const { TMP, reset, makePack, makeRepo, setup, commitAll } = suite('panel');

let repoB;
before(async () => {
  await reset();
  await makePack();
  repoB = await makeRepo('repo-beta');
});
after(reset);

const readManifest = async (ws) => JSON.parse(await fs.readFile(path.join(ws, 'manifest.json'), 'utf8'));

test('apply: skill toggle sweeps files, records skillsExcluded; update never resurrects; re-enable clears', async () => {
  const { ws } = await setup('apply', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: ['context7'], repos: [repoB],
  });
  assert.ok(await exists(path.join(ws, '.claude', 'skills', 'fx-final', 'SKILL.md')));

  await run(process.execPath, [CLI, 'apply', '--workspace', ws, '--disable-skill', 'fx-final']);
  let m = await readManifest(ws);
  assert.ok(!m.skills.includes('fx-final'));
  assert.deepEqual(m.skillsExcluded, ['fx-final'], '"all" selection records the exclusion');
  assert.equal(m.skillsSelection, 'all', 'the all-intent survives the toggle');
  assert.ok(!await exists(path.join(ws, '.claude', 'skills', 'fx-final')), 'files swept');
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);

  // A pin-moving update must keep following "all" for everything EXCEPT the exclusion.
  const lockPath = path.join(ws, 'taut.lock');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  // Any pin != HEAD moves the update; it need not be a REAL ancestor (this suite runs the
  // panel in-process against this checkout, and a release snapshot has no HEAD~1).
  lock.framework.commit = 'f'.repeat(40);
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
  await run(process.execPath, [CLI, 'update', '--workspace', ws]);
  m = await readManifest(ws);
  assert.ok(!m.skills.includes('fx-final'), 'update does not resurrect an excluded skill');
  assert.ok(m.skills.includes('fx-plan'), 'the rest of the payload still follows');

  await run(process.execPath, [CLI, 'apply', '--workspace', ws, '--enable-skill', 'fx-final']);
  m = await readManifest(ws);
  assert.ok(m.skills.includes('fx-final'));
  assert.deepEqual(m.skillsExcluded, [], 're-enable clears the exclusion');
  assert.ok(await exists(path.join(ws, '.claude', 'skills', 'fx-final', 'SKILL.md')));
});

test('apply: mcp toggle regates artifacts and sweeps .mcp.json when the last server leaves', async () => {
  const { ws } = await setup('apply-mcp', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: ['context7'], repos: [repoB],
  });
  assert.match(await fs.readFile(path.join(ws, '.claude', 'agents', 'fx-researcher.md'), 'utf8'), /context7/);

  await run(process.execPath, [CLI, 'apply', '--workspace', ws, '--disable-mcp', 'context7']);
  assert.ok(!await exists(path.join(ws, '.mcp.json')), 'last MCP server disabled → .mcp.json swept');
  const plan = await fs.readFile(path.join(ws, '.claude', 'agents', 'fx-researcher.md'), 'utf8');
  assert.ok(!plan.includes('context7'), 'docs-role capability recompiled OUT of the artifacts');
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);

  await run(process.execPath, [CLI, 'apply', '--workspace', ws, '--enable-mcp', 'context7']);
  assert.ok(await exists(path.join(ws, '.mcp.json')));
  assert.match(await fs.readFile(path.join(ws, '.claude', 'agents', 'fx-researcher.md'), 'utf8'), /context7/);
});

test('apply guards: atlas-required and unknown names refused with reasons', async () => {
  const { ws } = await setup('apply-guard', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB],
  });
  await assert.rejects(
    run(process.execPath, [CLI, 'apply', '--workspace', ws, '--enable-skill', 'fx-knowledge']),
    /requires Atlas/,
  );
  await assert.rejects(
    run(process.execPath, [CLI, 'apply', '--workspace', ws, '--enable-skill', 'nope']),
    /unknown skill/,
  );
  await assert.rejects(
    run(process.execPath, [CLI, 'apply', '--workspace', ws]),
    /nothing to apply/,
  );
});

test('panel: state contract, token guard, apply + repair through the server', async () => {
  const { ws } = await setup('panel-ws', {
    harness: 'claude-code', atlas: false, skills: 'all', mcp: [], repos: [repoB],
  });
  const p = await startPanel(ws, { port: 0 });
  const base = `http://127.0.0.1:${p.port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /TAUT panel/);

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.skills.length, 12, 'the whole catalog is listed');
    assert.equal(state.skills.filter((s) => s.installed).length, 10);
    const ku = state.skills.find((s) => s.name === 'fx-knowledge');
    assert.equal(ku.installed, false);
    assert.equal(ku.blocked, 'requires atlas', 'blocked skills carry the reason');
    assert.ok(state.mcp.every((m) => m.env.every((e) => typeof e.filled === 'boolean' && !('value' in e))),
      'env status is names + filled flags only — never values');
    assert.equal(state.status.current, true);

    let r = await fetch(`${base}/api/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skills: { disable: ['fx-final'] } }),
    });
    assert.equal(r.status, 403, 'mutation without the token is refused');

    r = await fetch(`${base}/api/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-taut-token': p.token },
      body: JSON.stringify({ skills: { disable: ['fx-final'] } }),
    });
    const applied = await r.json();
    assert.equal(applied.ok, true, applied.log);
    assert.match(applied.log, /workspace applied/);
    assert.ok(!await exists(path.join(ws, '.claude', 'skills', 'fx-final')));

    await fs.appendFile(path.join(ws, 'CLAUDE.md'), '\ndrift\n');
    r = await fetch(`${base}/api/repair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-taut-token': p.token },
    });
    const repaired = await r.json();
    assert.equal(repaired.ok, true, repaired.log);
    await run(process.execPath, [CLI, 'verify', '--workspace', ws]);

    const state2 = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state2.skills.find((s) => s.name === 'fx-final').installed, false);
    assert.deepEqual(state2.skillsExcluded, ['fx-final']);

    // Docs tab: the state lists the shipped documentation (LAWS first, then docs/),
    // /api/doc serves a file by name, and the name filter is traversal-proof.
    assert.ok(state2.docs.includes('LAWS.md'), 'LAWS listed');
    assert.ok(state2.docs.includes('FLOW-fx.md'), 'installed flow doc listed');
    const doc = await (await fetch(`${base}/api/doc?name=FLOW-fx.md`)).json();
    assert.match(doc.text, /# FLOW-fx/);
    const laws = await (await fetch(`${base}/api/doc?name=LAWS.md`)).json();
    assert.match(laws.text, /L9 — Contextual precedence/);
    let bad = await fetch(`${base}/api/doc?name=${encodeURIComponent('../LAWS.md')}`);
    assert.equal(bad.status, 400, 'path separators refused');
    bad = await fetch(`${base}/api/doc?name=${encodeURIComponent('..%2Fmanifest.md')}`);
    assert.equal(bad.status, 400);
    bad = await fetch(`${base}/api/doc?name=absent.md`);
    assert.equal(bad.status, 404);

    // Memory tab: tree over the sibling memory folder, per-file view, traversal-proof.
    await fs.mkdir(path.join(ws, 'memory', 'spec', 'T-7'), { recursive: true });
    await fs.writeFile(path.join(ws, 'memory', 'spec', 'T-7', 'report.md'), '# T-7 report\nfindings\n');
    await fs.writeFile(path.join(ws, 'memory', 'notes.txt'), 'plain notes\n');
    const mem = await (await fetch(`${base}/api/memory`)).json();
    assert.equal(mem.root, `${ws}-memory`, 'tree is rooted at the sibling memory folder');
    const spec = mem.tree.find((n) => n.name === 'spec' && n.type === 'dir');
    assert.ok(spec, 'spec dir listed');
    const t7 = spec.children.find((n) => n.name === 'T-7');
    assert.ok(t7.children.some((n) => n.name === 'report.md' && n.type === 'file'));
    assert.ok(!spec.children.some((n) => n.name === '.gitkeep'), 'dotfiles hidden');
    const f = await (await fetch(`${base}/api/memfile?path=${encodeURIComponent('spec/T-7/report.md')}`)).json();
    assert.match(f.text, /# T-7 report/);
    const plain = await (await fetch(`${base}/api/memfile?path=notes.txt`)).json();
    assert.match(plain.text, /plain notes/);
    let memBad = await fetch(`${base}/api/memfile?path=${encodeURIComponent('../ws/manifest.json')}`);
    assert.equal(memBad.status, 400, 'traversal out of the memory root refused');
    memBad = await fetch(`${base}/api/memfile?path=${encodeURIComponent('spec/.gitkeep')}`);
    assert.equal(memBad.status, 400, 'dotfiles unreachable');
    memBad = await fetch(`${base}/api/memfile?path=absent.md`);
    assert.equal(memBad.status, 404);
    memBad = await fetch(`${base}/api/memraw?path=notes.txt`);
    assert.equal(memBad.status, 400, 'memraw serves image extensions only');

    // Repo checklist plumbing: state lists connected repos; disconnect + reconnect (by
    // path) round-trip through /api/apply.
    const rb0 = state2.repos.find((x) => x.name === 'repo-beta');
    assert.ok(rb0 && rb0.connected === true && rb0.mandatory === false, 'connected repo listed, unlocked');
    r = await fetch(`${base}/api/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-taut-token': p.token },
      body: JSON.stringify({ repos: { disconnect: ['repo-beta'] } }),
    });
    const rOff = await r.json();
    assert.equal(rOff.ok, true, rOff.log);
    const state3 = await (await fetch(`${base}/api/state`)).json();
    assert.ok(!state3.repos.some((x) => x.name === 'repo-beta'),
      'disconnected repo leaves the list (its folder is outside the workspace root)');
    r = await fetch(`${base}/api/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-taut-token': p.token },
      body: JSON.stringify({ repos: { connect: [repoB] } }),
    });
    const rOn = await r.json();
    assert.equal(rOn.ok, true, rOn.log);
    const state4 = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state4.repos.find((x) => x.name === 'repo-beta')?.connected, true, 'reconnected by path');
  } finally {
    await p.close();
  }
});

test('apply: repo toggles — disconnect sweeps repo data, connect re-installs or scaffolds the descriptor', async () => {
  // Isolated pack copy: the scaffold-on-connect case writes into the pack.
  const pack2 = path.join(TMP, 'pack-repotoggle');
  await makePack(pack2);
  const root = path.join(TMP, 'toggleroot');
  for (const n of ['repo-core', 'repo-svc', 'repo-pdf']) await fs.mkdir(path.join(root, n, '.git'), { recursive: true });
  const ws = path.join(root, 'ws');
  const answersFile = path.join(TMP, 'toggle.answers.json');
  await fs.writeFile(answersFile, JSON.stringify({
    deployment: 'fxdep', harness: 'claude-code', atlas: false, skills: 'all', mcp: [],
    workspace: ws, repos: 'scan', data: pack2,
  }));
  await run(process.execPath, [CLI, 'setup', '--answers', answersFile, '--yes']);
  let m = await readManifest(ws);
  assert.ok(m.repos.some((r) => r.name === 'repo-pdf'));
  assert.deepEqual(m.runbooks.map((r) => r.name), ['ops-shared', 'spa-mock', 'stack-basic', 'stack-pdf']);

  // Disconnect: manifest/local rows go, the descriptor is swept, the bound runbook and
  // its generated wrapper leave — the same honest degradation as a setup without the repo.
  await run(process.execPath, [CLI, 'apply', '--workspace', ws, '--disconnect-repo', 'repo-pdf']);
  m = await readManifest(ws);
  assert.ok(!m.repos.some((r) => r.name === 'repo-pdf'));
  assert.equal(m.repoDocs['repo-pdf'], undefined);
  assert.ok(!await exists(path.join(ws, '.taut', 'repos', 'repo-pdf')), 'descriptor swept');
  assert.deepEqual(m.runbooks.map((r) => r.name), ['ops-shared', 'spa-mock', 'stack-basic'], 'bound runbook left');
  assert.ok(!await exists(path.join(ws, '.claude', 'skills', 'up-pdf')), 'stack wrapper swept');
  const local = JSON.parse(await fs.readFile(path.join(ws, '.taut', 'local.json'), 'utf8'));
  assert.equal(local.repoPaths['repo-pdf'], undefined);
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);

  // Mandatory repos are locked; unknown disconnects refused.
  await assert.rejects(
    run(process.execPath, [CLI, 'apply', '--workspace', ws, '--disconnect-repo', 'repo-core']),
    /mandatory/,
  );
  await assert.rejects(
    run(process.execPath, [CLI, 'apply', '--workspace', ws, '--disconnect-repo', 'ghost']),
    /not connected/,
  );

  // Reconnect by NAME (workspace-parent resolution): the covered descriptor re-installs,
  // the runbook + wrapper return.
  await run(process.execPath, [CLI, 'apply', '--workspace', ws, '--connect-repo', 'repo-pdf']);
  m = await readManifest(ws);
  assert.deepEqual(m.repoDocs['repo-pdf'], ['.taut/repos/repo-pdf/CLAUDE.md']);
  assert.ok(await exists(path.join(ws, '.taut', 'repos', 'repo-pdf', 'CLAUDE.md')));
  assert.deepEqual(m.runbooks.map((r) => r.name), ['ops-shared', 'spa-mock', 'stack-basic', 'stack-pdf']);
  assert.ok(await exists(path.join(ws, '.claude', 'skills', 'up-pdf', 'SKILL.md')), 'wrapper regenerated');

  // Connect an UNCOVERED known repo: the compile scaffolds its WORKSPACE-OWNED instance
  // descriptor (add ⇒ a descriptor exists); the pack is never written by a connect.
  await fs.mkdir(path.join(root, 'repo-opt', '.git'), { recursive: true });
  const r2 = await run(process.execPath, [CLI, 'apply', '--workspace', ws, '--connect-repo', 'repo-opt']);
  assert.match(r2.stdout, /still SKELETON: .*repo-opt/);
  assert.ok(!await exists(path.join(pack2, 'fxdep', 'repos', 'repo-opt')), 'connect never writes the pack');
  assert.match(await fs.readFile(path.join(ws, 'repos', 'repo-opt', 'descriptor.md'), 'utf8'),
    /STATUS: SKELETON/, 'instance skeleton exists immediately');
  m = await readManifest(ws);
  assert.ok(m.repos.some((r) => r.name === 'repo-opt'));
  assert.deepEqual(m.repoDocs['repo-opt'], ['repos/repo-opt/descriptor.md']);
  await run(process.execPath, [CLI, 'verify', '--workspace', ws]);

  // Panel state over a PROFILE workspace: mandatory locked, skeleton surfaced.
  const p = await startPanel(ws, { port: 0 });
  try {
    const base = `http://127.0.0.1:${p.port}`;
    const st = await (await fetch(`${base}/api/state`)).json();
    const core = st.repos.find((r) => r.name === 'repo-core');
    assert.equal(core.mandatory, true, 'mandatory flag reaches the panel');
    const opt = st.repos.find((r) => r.name === 'repo-opt');
    assert.equal(opt.skeleton, true, 'unfilled skeleton surfaced for distillation');
    assert.ok(core.descriptorFiles >= 1 && core.skeleton === false, 'real descriptors are not skeletons');

    // Data-only actualization through the panel: the pack moves (a doc lands as a
    // commit — connects no longer write the pack) → /api/update {dataOnly} re-pins the
    // DATA axis alone.
    await fs.writeFile(path.join(pack2, 'docs', 'NOTE.md'), '# a pack change\n');
    await commitAll(pack2, 'doc landed');
    const upd = await (await fetch(`${base}/api/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-taut-token': p.token },
      body: JSON.stringify({ dataOnly: true }),
    })).json();
    assert.equal(upd.ok, true, upd.log);
    assert.match(upd.log, /Updating data pin/);
    const lockAfter = JSON.parse(await fs.readFile(path.join(ws, 'taut.lock'), 'utf8'));
    assert.equal(lockAfter.data.canonical, true, 'data pin re-pinned at the now-clean pack HEAD');
  } finally {
    await p.close();
  }
});
