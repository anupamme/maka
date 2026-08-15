#!/usr/bin/env node
// What the baseline arm's `str_replace_editor view` and the fs arm's `read`
// actually deliver from the same file at the same budget.
//
// The two arms are given the same number — 16000 — but the number means
// different things in the two tools, so the profiles' claim that the read
// budget is equalised is a claim about a number and not about content. This
// script is what makes the residual checkable instead of asserted: it
// reimplements both renderers from the shipped code and reports the ratio over
// a corpus, both tails included.
//
//   node packages/eval/scripts/measure-read-budget.mjs [--budget 16000] [<dir>...]
//
// The default corpus is every tracked `.ts .tsx .js .jsx .mjs .cjs .py` file in
// the repository, tests included. `--exclude-tests` drops paths containing a
// `__tests__` segment or a `.test.`/`.spec.` infix, which is the only other
// file set the figures in the profiles have ever been quoted for.
//
// Reimplemented rather than imported: neither package exports its renderer, and
// both live in the toolchain build rather than in this workspace. The line
// references below are to `@deepseek-ai/dsh-tool-str-replace-editor@0.1.0-rc.6`
// and `@deepseek-ai/dsh-tool-fs@0.1.0-rc.6`, the versions the toolchain pins.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py)$/;
const TEST = /(?:^|\/)__tests__\/|\.(?:test|spec)\./;

// `str-replace-editor/lib/index.js:85-103`. One `slice` over the fully rendered
// string: the prompt line, then every line prefixed with a six-column
// right-aligned number and two spaces. There is no per-line cap and no line
// count cap, so a single very long line is delivered up to the whole budget.
function baseline(path, content, budget) {
  const all = content.split('\n');
  const prompt = `Here's the content of ${path} with line numbers (which has a total of ${all.length} lines)`;
  const numbered = all.map((line, i) => `${String(i + 1).padStart(6, ' ')}  ${line}`).join('\n');
  const rendered = `${prompt}:\n${numbered}\n`;
  const shown = rendered.length <= budget ? rendered : rendered.slice(0, budget);
  // Lines the model can actually read. A line the slice cut mid-way still
  // delivers its prefix, so it counts, which is the generous reading.
  return { lines: shown.split('\n').length - 1, chars: shown.length };
}

// `tool-fs/lib/index.js:28-48, 101-112`. Three caps, then an envelope outside
// all of them: each line is cut to `maxLineLength` characters, the running
// total of raw UTF-8 line bytes plus one separator is charged against
// `maxBytes`, and at most `limit` lines are returned. The `NNN: ` gutter, the
// `<path>/<type>/<content>` wrapper and the footer are added afterwards and
// cost the budget nothing.
function fs(path, content, { maxBytes, maxLineLength, limit }) {
  const all = content.split('\n');
  const shown = [];
  let bytes = 0;
  for (const raw of all) {
    if (shown.length >= limit) break;
    const line = raw.length > maxLineLength ? raw.slice(0, maxLineLength) : raw;
    const cost = Buffer.byteLength(line, 'utf8') + (shown.length > 0 ? 1 : 0);
    if (bytes + cost > maxBytes) break;
    bytes += cost;
    shown.push(line);
  }
  const body = shown.map((line, i) => `${i + 1}: ${line}`).join('\n');
  const envelope = `<path>${path}</path>\n<type>file</type>\n<content>\n${body}\n\n(footer)\n</content>`;
  return { lines: shown.length, chars: envelope.length };
}

const args = process.argv.slice(2);
const excludeTests = args.includes('--exclude-tests');
const budgetAt = args.indexOf('--budget');
const budget = budgetAt < 0 ? 16000 : Number(args[budgetAt + 1]);
const roots = args.filter((a, i) => !a.startsWith('--') && i !== budgetAt + 1);

const { stdout } = await run('git', ['ls-files', '-z', ...roots], { maxBuffer: 64 * 1024 * 1024 });
const paths = stdout
  .split('\0')
  .filter((p) => p !== '' && SOURCE.test(p) && !(excludeTests && TEST.test(p)));

const totals = { baseLines: 0, fsLines: 0, baseChars: 0, fsChars: 0, truncated: 0 };
const perFile = [];
for (const path of paths) {
  const content = await readFile(path, 'utf8').catch(() => undefined);
  if (content === undefined) continue;
  const b = baseline(path, content, budget);
  // The arm's own configuration, not the shipped defaults: `readMaxBytes` and
  // `readMaxLineLength` are both set to the budget in
  // harbor/deepseek-harness-fs-profile/cordis.patch.yml.
  const f = fs(path, content, { maxBytes: budget, maxLineLength: budget, limit: 2000 });
  totals.baseLines += b.lines;
  totals.fsLines += f.lines;
  totals.baseChars += b.chars;
  totals.fsChars += f.chars;
  const whole = content.split('\n').length;
  if (b.lines < whole || f.lines < whole) {
    totals.truncated += 1;
    perFile.push({ path, lines: f.lines / b.lines, chars: f.chars / b.chars });
  }
}

const ratio = (a, b) => (b === 0 ? Number.NaN : a / b).toFixed(3);
const extreme = (key, pick) =>
  perFile.reduce((best, entry) => (pick(entry[key], best[key]) ? entry : best), perFile[0]);

console.log(`corpus       ${paths.length} files${excludeTests ? ' (tests excluded)' : ''}`);
console.log(`budget       ${budget}`);
console.log(`lines        ${ratio(totals.fsLines, totals.baseLines)}x  (fs / baseline)`);
console.log(`characters   ${ratio(totals.fsChars, totals.baseChars)}x`);
console.log(`truncated    ${totals.truncated} files deliver less than the whole file to some arm`);
for (const [key, label] of [
  ['lines', 'lines'],
  ['chars', 'characters'],
]) {
  const most = extreme(key, (a, b) => a > b);
  const least = extreme(key, (a, b) => a < b);
  console.log(`${label} most fs-favourable    ${most[key].toFixed(3)}x  ${most.path}`);
  console.log(`${label} least fs-favourable   ${least[key].toFixed(3)}x  ${least.path}`);
}
