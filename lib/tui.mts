// TAUT compiler — interactive terminal widgets for `setup`: the banner, a plain
// text question, and the checklist/radio picker. Raw-mode ANSI, zero dependencies.
import process from 'node:process';
import * as readline from 'node:readline/promises';

import { bold, cyan, dim, green } from './util.mts';

export function banner(cmd: string): void {
  process.stdout.write(`\n${bold('TAUT')} ${dim('·')} ${cyan(cmd)}\n${dim('─'.repeat(44))}\n\n`);
}

export async function askText(q: string, def?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = `${cyan('?')} ${bold(q)}${def !== undefined ? ` ${dim(`(${def})`)}` : ''} ${dim('›')} `;
  const a = (await rl.question(prompt)).trim();
  rl.close();
  return a === '' && def !== undefined ? def : a;
}

export interface TuiItem<T> { label: string; value: T; hint?: string; locked?: boolean; checked?: boolean }
interface TuiOpts { multi?: boolean; allowEmpty?: boolean; summary?: (picked: any) => string }

// Checklist / radio picker: ↑/↓ (or j/k) move, space toggles, "a" all/none, enter confirms.
// Items may carry `locked: true` (always selected, space/a cannot deselect — used for
// deployment-mandatory repos) and `checked: false` (unchecked by default).
// On confirm the widget collapses into a single "✔ title · summary" line.
// Overloads: multi:true resolves to a list of picked values, single-select to one value.
export function tuiSelect<T>(title: string, items: TuiItem<T>[], opts: TuiOpts & { multi: true }): Promise<T[]>;
export function tuiSelect<T>(title: string, items: TuiItem<T>[], opts?: TuiOpts & { multi?: false }): Promise<T>;
export function tuiSelect<T>(title: string, items: TuiItem<T>[], { multi = false, allowEmpty = false, summary }: TuiOpts = {}): Promise<T | T[]> {
  const { stdin, stdout } = process;
  let cursor = 0;
  let lineCount = 0;
  const checked = new Set<number>();
  if (multi) items.forEach((it, i) => { if (it.locked || it.checked !== false) checked.add(i); });

  const render = () => {
    const keys = multi ? '↑/↓ · space · a all/none · enter' : '↑/↓ · enter';
    const lines = [`${cyan('?')} ${bold(title)}  ${dim(keys)}`];
    items.forEach((it, i) => {
      const on = multi ? checked.has(i) : i === cursor;
      const mark = it.locked ? green('◉') : on ? green('◉') : dim('◯');
      const hint = [it.locked ? 'required' : null, it.hint].filter(Boolean).join(' · ');
      lines.push(` ${i === cursor ? cyan('❯') : ' '} ${mark} ${i === cursor ? it.label : dim(it.label)}${hint ? `  ${dim(hint)}` : ''}`);
    });
    if (lineCount) stdout.write(`\x1b[${lineCount}A`);
    stdout.write(lines.map((l) => `\x1b[2K${l}`).join('\n') + '\n');
    lineCount = lines.length;
  };

  return new Promise((resolve) => {
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\x1b[?25h');
    };
    const onData = (buf: Buffer) => {
      const s = buf.toString('utf8');
      if (s === '\x03') { cleanup(); stdout.write('\n'); process.exit(130); }
      else if (s === '\x1b[A' || s === 'k') cursor = (cursor - 1 + items.length) % items.length;
      else if (s === '\x1b[B' || s === 'j') cursor = (cursor + 1) % items.length;
      else if (multi && s === ' ') {
        if (!items[cursor].locked) { if (checked.has(cursor)) checked.delete(cursor); else checked.add(cursor); }
      } else if (multi && (s === 'a' || s === 'A')) {
        const unlocked = items.map((it, i) => (it.locked ? -1 : i)).filter((i) => i >= 0);
        const allOn = unlocked.every((i) => checked.has(i));
        for (const i of unlocked) { if (allOn) checked.delete(i); else checked.add(i); }
      } else if (s === '\r' || s === '\n') {
        if (multi && !allowEmpty && checked.size === 0) return;
        cleanup();
        const picked = multi ? [...checked].sort((a, b) => a - b).map((i) => items[i].value) : items[cursor].value;
        const text = summary ? summary(picked)
          : multi ? `${(picked as T[]).length} selected` : String(items[cursor].label);
        stdout.write(`\x1b[${lineCount}A\x1b[J${green('✔')} ${bold(title)} ${dim('·')} ${text}\n`);
        resolve(picked);
        return;
      }
      render();
    };
    stdout.write('\x1b[?25l');
    render();
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}
