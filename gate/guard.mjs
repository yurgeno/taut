// TAUT command guard — compiled into a workspace as .taut/guard.mjs (next to the gate)
// and called by the gate for tool calls that are NOT skills, agents or MCP servers.
// It is the mechanical twin of a deployment's prohibitions: a law in an instruction file
// is context a sentence in the task can lift; a denied tool call is not.
//
// The pack declares VALUES (`manifest.safeguards` in its deployment config); the compiler
// carries them into taut.lock; this module only evaluates. Four sections:
//   tools    — tool names that are never called (exact names)
//   files    — workspace-relative files no tool and no shell command may touch
//   commands — programs that are never run (database clients, migration runners …)
//   git      — git subcommands that are never run, in ANY spelling
// `observe` lists sections that only RECORD what they would have denied.
//
// Why a parser and not a text match: a permission rule that matches the command text is
// passed by the ordinary `git -C <repo> push`, and a substring rule denies
// `grep -rn flyway build.gradle`. The guard finds the PROGRAM each part of a command line
// runs and judges that, so an everyday search does not trip it and an everyday spelling
// does not slip past it.
//
// Not covered, by construction: a command assembled at run time (variables, base64), a
// script FILE that makes the call, a database driver used from a language runtime, a git
// alias. The guard stops the forms a session actually writes; the system that owns the
// data (token scope, branch protection, database role) is what stops the rest.
//
// Self-contained (no imports), pure: `evaluate()` reads nothing and writes nothing.

export const SECTIONS = ['tools', 'files', 'commands', 'git'];

// ---- value validation (shared by the compiler; the gate trusts the lock) -------------

const TOOL_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const WORD_RE = /^[A-Za-z0-9_.+-]+=?\*?$/;
const GIT_RE = /^[a-z][a-z0-9-]*( --?[A-Za-z][A-Za-z0-9-]*)?$/;

// Returns the normalized value, or throws an Error whose message names the bad entry.
export function normalizeSafeguards(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('safeguards must be an object');
  const out = {};
  const list = (key) => {
    const v = raw[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim()))
      throw new Error(`safeguards.${key} must be an array of non-empty strings`);
    return [...new Set(v.map((x) => x.trim()))];
  };
  for (const k of Object.keys(raw)) {
    if (k !== '$comment' && k !== 'observe' && !SECTIONS.includes(k))
      throw new Error(`safeguards: unknown key "${k}" (known: ${SECTIONS.join(', ')}, observe)`);
  }
  const tools = list('tools');
  for (const t of tools) {
    // A tool rule written with parentheses or a wildcard is skipped by a harness's own
    // permission loader without a word — refuse it here, where someone will read the error.
    if (!TOOL_RE.test(t)) throw new Error(`safeguards.tools "${t}": an exact tool name is required (no parentheses, no wildcards)`);
  }
  const files = list('files').map((f) => f.replace(/^\.\//, ''));
  for (const f of files) {
    if (f.startsWith('/') || f.split('/').includes('..') || /[\s*?"'`$()]/.test(f))
      throw new Error(`safeguards.files "${f}": a plain workspace-relative path is required`);
  }
  const commands = list('commands');
  for (const c of commands) {
    if (!WORD_RE.test(c)) throw new Error(`safeguards.commands "${c}": a program name, optionally ending in * (prefix) or =* (an environment assignment)`);
  }
  const git = list('git');
  for (const g of git) {
    if (!GIT_RE.test(g)) throw new Error(`safeguards.git "${g}": "<subcommand>" or "<subcommand> <flag>" is required`);
  }
  const observe = list('observe');
  for (const o of observe) {
    if (!SECTIONS.includes(o)) throw new Error(`safeguards.observe "${o}": not one of ${SECTIONS.join(', ')}`);
  }
  if (tools.length) out.tools = tools;
  if (files.length) out.files = files;
  if (commands.length) out.commands = commands;
  if (git.length) out.git = git;
  if (observe.length) out.observe = observe;
  return Object.keys(out).some((k) => k !== 'observe') ? out : null;
}

// ---- shell reading -------------------------------------------------------------------

// Words of one command line, with the operators that separate its parts. Quotes are
// honoured (an operator inside quotes separates nothing); `$( … )` and backticks open a
// part of their own, also inside double quotes, because the shell runs them there too.
// A here-document body is TEXT handed to a program, not a command line: a note written to
// a file may quote `git push` without running it. The program that receives the body is
// still judged by its own name (`psql <<EOF` is psql).
function stripHeredocs(src) {
  const lines = String(src).split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    const m = lines[i].match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== m[2]) j += 1;
    i = j;
  }
  return kept.join('\n');
}

function tokenize(src) {
  const out = [];           // { op: true } | { w: string, quoted: boolean } | { sub: string }
  let cur = null;
  const word = () => (cur ??= { w: '', quoted: false });
  const end = () => { if (cur) { out.push(cur); cur = null; } };
  const op = () => { end(); if (!out.length || !out[out.length - 1].op) out.push({ op: true }); };
  const s = stripHeredocs(src);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { if (s[i + 1] === '\n') { i += 2; continue; } word().w += s[i + 1] ?? ''; i += 2; continue; }
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      const body = j === -1 ? s.slice(i + 1) : s.slice(i + 1, j);
      word().w += body; cur.quoted = true;
      i = j === -1 ? s.length : j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1; let body = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) { body += s[j + 1]; j += 2; continue; }
        body += s[j]; j += 1;
      }
      word().w += body; cur.quoted = true;
      for (const inner of substitutions(body)) { out.push({ sub: inner }); }
      i = j + 1; continue;
    }
    if (c === '$' && s[i + 1] === '(') { op(); i += 2; continue; }
    if (c === '`' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '\n') { op(); i += 1; continue; }
    if (c === '<' || c === '>') { end(); i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { end(); i += 1; continue; }
    if (c === '#' && !cur) { const j = s.indexOf('\n', i); i = j === -1 ? s.length : j; continue; }
    word().w += c; i += 1;
  }
  end();
  return out;
}

// The command texts inside `$( … )` and backticks of a double-quoted string.
function substitutions(body) {
  const found = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '$' && body[i + 1] === '(') {
      let depth = 1; let j = i + 2;
      while (j < body.length && depth > 0) { if (body[j] === '(') depth += 1; else if (body[j] === ')') depth -= 1; j += 1; }
      found.push(body.slice(i + 2, depth === 0 ? j - 1 : j)); i = j - 1;
    } else if (body[i] === '`') {
      const j = body.indexOf('`', i + 1);
      if (j !== -1) { found.push(body.slice(i + 1, j)); i = j; }
    }
  }
  return found;
}

// Programs that run ANOTHER program given as their arguments: the guard looks through them.
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'ionice', 'timeout',
  'stdbuf', 'xargs', 'watch', 'caffeinate', 'setsid', 'chronic', 'builtin', 'noglob', 'then', 'do', 'else', 'if', 'while', 'until', '!', '{']);
// A wrapper's flags that take a VALUE (`sudo -u postgres psql`): the value is not the program.
const WRAPPER_VALUE_FLAGS = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t'], doas: ['-u', '-C'],
  env: ['-u', '-C'], nice: ['-n'], ionice: ['-c', '-n', '-p'], timeout: ['-s', '-k'],
  xargs: ['-n', '-P', '-I', '-L', '-s', '-d', '-E', '-a'], watch: ['-n', '-d'],
};
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish']);
// Programs that hand their arguments to something that runs them: a database client named
// anywhere in their arguments is a database client being run. `need` narrows the look to
// the forms that execute (a compose service that happens to be called like a client is
// started with `up`, not run with `exec`).
const CARRIERS = {
  docker: ['exec', 'run'], podman: ['exec', 'run'], nerdctl: ['exec', 'run'], 'docker-compose': ['exec', 'run'],
  kubectl: ['exec', 'run'], oc: ['exec', 'run', 'rsh'],
  ssh: null, gradle: null, gradlew: null, mvn: null, mvnw: null, npx: null, npm: null, yarn: null, pnpm: null, make: null,
};
const BUILD_TOOLS = new Set(['gradle', 'gradlew', 'mvn', 'mvnw', 'npm', 'yarn', 'pnpm', 'make']);
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const base = (w) => w.slice(w.lastIndexOf('/') + 1);

// Does this word name the protected file — as a path of its own, at the end of a longer
// path, or inside a quoted string? A longer name that merely contains it does not count.
function namesFile(word, file) {
  for (let at = word.indexOf(file); at !== -1; at = word.indexOf(file, at + 1)) {
    const before = at === 0 ? '/' : word[at - 1];
    const after = word[at + file.length] ?? ' ';
    if (/[\/\s='":@,]/.test(before) && /[\s'":,;)]/.test(after)) return true;
  }
  return false;
}

function wordMatches(word, rule) {
  if (rule.endsWith('*')) return word.startsWith(rule.slice(0, -1));
  return word === rule;
}

// One part of a command line (between operators) → the program it runs and its arguments.
function program(words) {
  let i = 0;
  const assigns = [];
  for (;;) {
    // NAME=value before a program; the value may be quoted, the name never is
    while (i < words.length && ASSIGN_RE.test(words[i].w)) { assigns.push(words[i].w); i += 1; }
    if (i < words.length && !words[i].quoted && WRAPPERS.has(base(words[i].w))) {
      const valued = WRAPPER_VALUE_FLAGS[base(words[i].w)] ?? [];
      i += 1;
      // a wrapper's own flags and numeric arguments (timeout 30, nice -n 5, xargs -n1)
      while (i < words.length && !words[i].quoted && (/^-/.test(words[i].w) || /^\d+(\.\d+)?[smhd]?$/.test(words[i].w)))
        i += valued.includes(words[i].w) ? 2 : 1;
      continue;
    }
    break;
  }
  if (i >= words.length) return { exe: null, args: [], assigns };
  return { exe: base(words[i].w), args: words.slice(i + 1), assigns };
}

function gitVerdict(args, rules) {
  let j = 0;
  while (j < args.length && args[j].w.startsWith('-')) j += GIT_OPTS_WITH_VALUE.has(args[j].w) ? 2 : 1;
  const sub = args[j]?.w;
  if (!sub) return null;
  const rest = args.slice(j + 1).map((a) => a.w);
  for (const rule of rules) {
    const [rsub, flag] = rule.split(' ');
    if (rsub !== sub) continue;
    if (!flag) return rule;
    if (rest.includes(flag)) return rule;
    // a single-letter flag also rides in a cluster: `clean -fd`, `branch -fD`
    if (/^-[A-Za-z]$/.test(flag) && rest.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(flag[1]))) return rule;
  }
  return null;
}

// Every hit in one command line: [{ section, rule }]. `depth` bounds the recursion into
// `sh -c '…'` and command substitutions.
function scanCommand(src, sg, depth = 0) {
  const hits = [];
  if (depth > 6) return hits;
  const tokens = tokenize(src);
  const parts = [];
  let cur = [];
  for (const t of tokens) {
    if (t.sub !== undefined) { hits.push(...scanCommand(t.sub, sg, depth + 1)); continue; }
    if (t.op) { if (cur.length) parts.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) parts.push(cur);

  for (const words of parts) {
    // files: a protected path named anywhere on the line, whatever program reads it
    for (const f of sg.files ?? []) {
      if (words.some((x) => namesFile(x.w, f))) hits.push({ section: 'files', rule: f });
    }
    const { exe, args, assigns } = program(words);
    // commands: an environment assignment rule (PGPASSWORD=*) is judged wherever it stands
    for (const rule of (sg.commands ?? []).filter((r) => r.includes('='))) {
      const all = [...assigns, ...args.filter((a) => !a.quoted).map((a) => a.w)];
      if (all.some((w) => wordMatches(w, rule))) hits.push({ section: 'commands', rule });
    }
    if (!exe) continue;
    const progRules = (sg.commands ?? []).filter((r) => !r.includes('='));

    if (SHELLS.has(exe) || exe === 'eval') {
      // `sh -c '<line>'` / `eval <line>` run their argument as a command line
      const k = exe === 'eval' ? -1 : args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a.w));
      const inner = exe === 'eval' ? args.map((a) => a.w).join(' ') : (k !== -1 ? args[k + 1]?.w : undefined);
      if (inner) hits.push(...scanCommand(inner, sg, depth + 1));
      continue;
    }
    if (exe === 'find') {
      const k = args.findIndex((a) => ['-exec', '-execdir', '-ok', '-okdir'].includes(a.w));
      if (k !== -1) hits.push(...scanCommand(args.slice(k + 1).map((a) => a.w).filter((w) => w !== '{}' && w !== '+').join(' '), sg, depth + 1));
      continue;
    }
    if (exe === 'git' && sg.git?.length) {
      const rule = gitVerdict(args, sg.git);
      if (rule) hits.push({ section: 'git', rule });
    }
    for (const rule of progRules) if (wordMatches(exe, rule)) hits.push({ section: 'commands', rule });

    if (Object.hasOwn(CARRIERS, exe) && progRules.length) {
      const need = CARRIERS[exe];
      const plain = args.filter((a) => !a.quoted).map((a) => a.w);
      if (need && !plain.some((w) => need.includes(w))) continue;
      const build = BUILD_TOOLS.has(exe);
      const candidates = [];
      for (let a = 0; a < args.length; a++) {
        const { w, quoted } = args[a];
        // an excluded build task is not a task being run
        if (build && (w === '-x' || w === '--exclude-task')) { a += 1; continue; }
        if (quoted) { hits.push(...scanCommand(w, sg, depth + 1)); continue; }
        if (w.startsWith('-')) continue;
        candidates.push(base(w), ...(build ? w.split(':').filter(Boolean) : []));
      }
      for (const rule of progRules) if (candidates.some((w) => wordMatches(w, rule))) hits.push({ section: 'commands', rule });
    }
  }
  return hits;
}

// ---- the verdict ---------------------------------------------------------------------

// Tool names differ per harness (`mcp__server__tool` vs `server_tool`): compare on a
// spelling both share.
const toolKey = (n) => String(n).replace(/^mcp__/, '').replace(/__/g, '_');

// → null (nothing to say) | { section, rule, observe: boolean, reason: string }
// The FIRST enforced hit wins; an observed hit is returned only when nothing is enforced.
export function evaluate(toolName, toolInput, safeguards) {
  const sg = safeguards;
  if (!sg || typeof sg !== 'object') return null;
  const observed = new Set(sg.observe ?? []);
  const ti = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const hits = [];

  if ((sg.tools ?? []).some((t) => toolKey(t) === toolKey(toolName))) hits.push({ section: 'tools', rule: String(toolName) });

  const command = typeof ti.command === 'string' ? ti.command
    : Array.isArray(ti.command) ? ti.command.map(String).join(' ')
      : typeof ti.cmd === 'string' ? ti.cmd : null;
  if (command !== null) {
    hits.push(...scanCommand(command, sg));
  } else {
    // a file tool (read / write / edit): the path it names
    for (const key of ['file_path', 'filePath', 'path', 'notebook_path']) {
      const p = ti[key];
      if (typeof p !== 'string') continue;
      const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
      for (const f of sg.files ?? []) if (norm === f || norm.endsWith('/' + f)) hits.push({ section: 'files', rule: f });
    }
  }
  if (!hits.length) return null;
  const hit = hits.find((h) => !observed.has(h.section)) ?? hits[0];
  return { section: hit.section, rule: hit.rule, observe: observed.has(hit.section), reason: REASONS[hit.section](hit.rule) };
}

const TAIL = 'This is a workspace safeguard, not a prompt: a message in chat cannot lift it. If the task needs this step, stop and hand it to the owner.';
const REASONS = {
  tools: (r) => `TAUT safeguard: the tool "${r}" is not available in this workspace. ${TAIL}`,
  files: (r) => `TAUT safeguard: "${r}" is protected in this workspace and is not read or written by a session. ${TAIL}`,
  commands: (r) => `TAUT safeguard: "${r.replace(/=?\*$/, '')}" is not run from a session in this workspace (the deployment's safeguards forbid it). ${TAIL}`,
  git: (r) => `TAUT safeguard: \`git ${r}\` is not run from a session in this workspace. Leave the change in the working tree and report it. ${TAIL}`,
};
