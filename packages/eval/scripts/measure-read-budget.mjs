#!/usr/bin/env node
// What the baseline arm's `str_replace_editor view` and the fs arm's `read`
// actually deliver from the same file at the same budget.
//
// The two arms are given the same number — 16000 — but the number means
// different things in the two tools, so the profiles' claim that the read
// budget is equalised is a claim about a number and not about content. This
// script is what makes the residual checkable instead of asserted.
//
//   node packages/eval/scripts/measure-read-budget.mjs [options] [<path>...]
//
//     --budget <n>        the budget both arms are given (default 16000)
//     --line-cap <n>      the fs arm's `readMaxLineLength` (default 2000, the
//                         shipped value the profile leaves in place)
//     --exclude-tests     drop `__tests__/` and `.test.`/`.spec.` paths
//     --self-check <dir>  verify both renderers against the shipped packages
//                         installed under <dir>/node_modules, then exit
//
// The default corpus is every tracked `.ts .tsx .js .jsx .mjs .cjs .py` file in
// the repository, tests included. Source files are not the whole story — the
// budgets diverge most on long lines, which this corpus has almost none of — so
// a fixed set of synthetic worst cases is always reported alongside it.
//
// Reimplemented rather than imported: neither package exports its renderer, and
// both live in the toolchain build rather than in this workspace. That is a
// standing risk of transcription error, and the first version of this script
// had four — it dropped the baseline's 240-character truncation notice, dropped
// the fs arm's per-line truncation marker, counted the baseline's prompt line
// as a line of content, and counted a phantom trailing line for the fs arm.
// `--self-check` is the answer: it lifts the real functions out of an installed
// copy and asserts this file agrees with them, so the transcription is verified
// rather than trusted. Line references are to
// `@deepseek-ai/dsh-tool-str-replace-editor@0.1.0-rc.6` and
// `@deepseek-ai/dsh-tool-fs@0.1.0-rc.6`, the versions the toolchain pins.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py)$/;
const TEST = /(?:^|\/)__tests__\/|\.(?:test|spec)\./;

// `str-replace-editor/lib/index.js:24-26, 85-104`. One `slice` over the fully
// rendered string — the prompt line, then every line prefixed with a
// six-column right-aligned number and two spaces — and a fixed notice appended
// when it cut. There is no per-line cap and no line count cap, so a single very
// long line is delivered up to the whole budget.
const TRUNCATED_MESSAGE = `<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with \`grep -n\` in order to find the line numbers of what you are looking for.</NOTE>`;

function baseline(path, content, budget) {
  const all = content.split('\n');
  const prompt = `Here's the content of ${path} with line numbers (which has a total of ${all.length} lines)`;
  const numbered = all.map((line, i) => `${String(i + 1).padStart(6, ' ')}  ${line}`).join('\n');
  const rendered = `${prompt}:\n${numbered}\n`;
  const shown =
    rendered.length <= budget ? rendered : rendered.slice(0, budget) + TRUNCATED_MESSAGE;
  // Lines of the file the model can read. The prompt line is not one of them,
  // and a line the slice cut mid-way still delivers its prefix, so it counts.
  const body = shown.slice(shown.indexOf('\n') + 1);
  const lines = body === '' ? 0 : body.split('\n').length - (body.endsWith('\n') ? 1 : 0);
  return { lines, chars: shown.length, whole: rendered.length <= budget };
}

// `tool-fs/lib/index.js:28-48, 101-112`. Three caps, then an envelope outside
// all of them: each line is cut to `maxLineLength` characters **and given a
// marker naming the cut**, the running total of raw UTF-8 line bytes plus one
// separator is charged against `maxBytes`, and at most `limit` lines are
// returned. The `NNN: ` gutter, the `<path>/<type>/<content>` wrapper and the
// footer are added afterwards and cost the budget nothing.
//
// The marker is the reason `maxLineLength` cannot simply be raised to the
// budget: once a truncated line plus its marker exceeds `maxBytes`, the line
// does not fit at all and every line after it is dropped too.
function fsRead(path, content, { maxBytes, maxLineLength, limit }) {
  const all = content.split('\n');
  // `buildWindow` flushes a final partial line only when it is non-empty, so
  // the empty string after a trailing newline is not a line.
  if (all.at(-1) === '') all.pop();
  const shown = [];
  let bytes = 0;
  let capped = false;
  for (const raw of all) {
    if (shown.length >= limit) break;
    const stripped = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const line =
      stripped.length > maxLineLength
        ? `${stripped.substring(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)`
        : stripped;
    const cost = Buffer.byteLength(line, 'utf8') + (shown.length > 0 ? 1 : 0);
    if (bytes + cost > maxBytes) {
      capped = true;
      break;
    }
    bytes += cost;
    shown.push(line);
  }
  const footer = `(footer)`;
  const body =
    shown.length > 0
      ? `${shown.map((line, i) => `${i + 1}: ${line}`).join('\n')}\n\n${footer}`
      : footer;
  const envelope = `<path>${path}</path>\n<type>file</type>\n<content>\n${body}\n</content>`;
  return {
    lines: shown.length,
    chars: envelope.length,
    whole: !capped && shown.length === all.length,
  };
}

// Lift `formatFileView`, `maybeTruncate`, `truncateLine` and `consumeLine` out
// of an installed copy and check the transcriptions above against them. The
// packages do not export these, so they are sliced out of the built bundle by
// name; if a future version renames one, this fails loudly rather than
// silently checking nothing.
async function selfCheck(dir) {
  const editor = `${dir}/node_modules/@deepseek-ai/dsh-tool-str-replace-editor/lib/index.js`;
  const tools = `${dir}/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js`;
  const slice = (source, from, to) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to);
    if (start < 0 || end < 0 || end <= start) throw new Error(`cannot find ${from} .. ${to}`);
    return source.slice(start, end);
  };
  const load = async (code, names) =>
    import(`data:text/javascript,${encodeURIComponent(`${code}\nexport {${names.join(',')}};`)}`);

  const editorSource = await readFile(editor, 'utf8');
  const real = await load(
    slice(editorSource, 'const TRUNCATED_MESSAGE', 'async function listDirectory('),
    ['TRUNCATED_MESSAGE', 'formatFileView'],
  );
  const toolsSource = await readFile(tools, 'utf8');
  const realFs = await load(
    slice(toolsSource, 'function newAccumulator(', 'function stripCarriageReturn'),
    ['newAccumulator', 'consumeLine'],
  );

  if (real.TRUNCATED_MESSAGE !== TRUNCATED_MESSAGE) {
    throw new Error('the baseline truncation notice transcribed here is not the shipped one');
  }

  const shapes = {
    short: 'one\ntwo\nthree\n',
    'no trailing newline': 'one\ntwo',
    crlf: 'one\r\ntwo\r\nthree\r\n',
    'long line': `${'x'.repeat(20000)}\n${Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')}\n`,
    'long cjk line': `${'漢'.repeat(9000)}\nafter\n`,
    'many lines': `${Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n')}\n`,
    'non-ascii': `${'éèê'.repeat(3000)}\ntail\n`,
  };
  const budget = 16000;
  for (const cap of [2000, 8000, 16000]) {
    for (const [name, content] of Object.entries(shapes)) {
      const mineBase = baseline('f.txt', content, budget);
      const realBase = real.formatFileView('f.txt', content, budget, undefined);
      if (mineBase.chars !== realBase.length) {
        throw new Error(
          `baseline chars disagree on ${name}: ${mineBase.chars} vs ${realBase.length}`,
        );
      }
      const acc = realFs.newAccumulator();
      for (const raw of content.split('\n')) {
        realFs.consumeLine(acc, raw.endsWith('\r') ? raw.slice(0, -1) : raw, {
          offset: 1,
          limit: 2000,
          maxLineLength: cap,
          maxBytes: budget,
        });
      }
      const mineFs = fsRead('f.txt', content, {
        maxBytes: budget,
        maxLineLength: cap,
        limit: 2000,
      });
      // `consumeLine` is fed the split lines directly here, so it sees the
      // empty string after a trailing newline that `buildWindow` would not.
      const expected = acc.lines.length - (content.endsWith('\n') && !acc.truncatedByBytes ? 1 : 0);
      if (mineFs.lines !== expected) {
        throw new Error(
          `fs lines disagree on ${name} at cap ${cap}: ${mineFs.lines} vs ${expected}`,
        );
      }
    }
  }
  console.log(`self-check passed against the packages installed under ${dir}`);
}

// Options with a value, so a positional path is never eaten as one. The first
// version filtered by index and silently dropped the first path whenever
// `--budget` was absent.
const VALUED = new Set(['--budget', '--line-cap', '--self-check']);
const argv = process.argv.slice(2);
const options = new Map();
const roots = [];
for (let i = 0; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) roots.push(argv[i]);
  else if (VALUED.has(argv[i])) options.set(argv[i], argv[(i += 1)]);
  else options.set(argv[i], true);
}

if (options.has('--self-check')) {
  await selfCheck(options.get('--self-check'));
  process.exit(0);
}

const budget = Number(options.get('--budget') ?? 16000);
const lineCap = Number(options.get('--line-cap') ?? 2000);
const excludeTests = options.has('--exclude-tests');
const READ = { maxBytes: budget, maxLineLength: lineCap, limit: 2000 };

const { stdout } = await run('git', ['ls-files', '-z', ...roots], { maxBuffer: 64 * 1024 * 1024 });
const paths = stdout
  .split('\0')
  .filter((p) => p !== '' && SOURCE.test(p) && !(excludeTests && TEST.test(p)));

const totals = { baseLines: 0, fsLines: 0, baseChars: 0, fsChars: 0, bound: 0, starved: 0 };
const perFile = [];
for (const path of paths) {
  const content = await readFile(path, 'utf8').catch(() => undefined);
  if (content === undefined) continue;
  const b = baseline(path, content, budget);
  const f = fsRead(path, content, READ);
  totals.baseLines += b.lines;
  totals.fsLines += f.lines;
  totals.baseChars += b.chars;
  totals.fsChars += f.chars;
  if (b.whole && f.whole) continue;
  totals.bound += 1;
  // The failure mode that matters more than any ratio: the fs arm returns
  // nothing at all while the baseline returns content, which no offset
  // recovers because the offending line never fits.
  if (f.lines === 0 && b.lines > 0) totals.starved += 1;
  perFile.push({ path, lines: f.lines / b.lines, chars: f.chars / b.chars });
}

const ratio = (a, b) => (b === 0 ? Number.NaN : a / b).toFixed(3);
const extreme = (key, pick) =>
  perFile.reduce((best, entry) => (pick(entry[key], best[key]) ? entry : best), perFile[0]);

console.log(`corpus       ${paths.length} files${excludeTests ? ' (tests excluded)' : ''}`);
console.log(`budget       ${budget}, fs line cap ${lineCap}`);
console.log(`lines        ${ratio(totals.fsLines, totals.baseLines)}x  (fs / baseline)`);
console.log(`characters   ${ratio(totals.fsChars, totals.baseChars)}x`);
console.log(`bound        ${totals.bound} files where a budget binds for some arm`);
console.log(
  `starved      ${totals.starved} files where fs returns nothing and the baseline does not`,
);
console.log('among the bound files:');
for (const [key, label] of [
  ['lines', 'lines'],
  ['chars', 'characters'],
]) {
  const most = extreme(key, (a, b) => a > b);
  const least = extreme(key, (a, b) => a < b);
  console.log(`  ${label} most fs-favourable    ${most[key].toFixed(3)}x  ${most.path}`);
  console.log(`  ${label} least fs-favourable   ${least[key].toFixed(3)}x  ${least.path}`);
}

// The corpus above has almost no long lines, which is exactly where the two
// budgets diverge, so these are always reported with it.
console.log('synthetic worst cases:');
const WORST = {
  'one 20000-char ASCII line, then 200 short lines': `${'x'.repeat(20000)}\n${Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')}\n`,
  'one 9000-character CJK line, then one short line': `${'漢'.repeat(9000)}\nafter\n`,
  'a 200-line file of 400-character lines': `${Array.from({ length: 200 }, () => 'y'.repeat(400)).join('\n')}\n`,
};
for (const [name, content] of Object.entries(WORST)) {
  const b = baseline('f.txt', content, budget);
  const f = fsRead('f.txt', content, READ);
  console.log(`  ${name}`);
  console.log(
    `    baseline ${String(b.lines).padStart(4)} lines, ${String(b.chars).padStart(6)} chars`,
  );
  console.log(
    `    fs       ${String(f.lines).padStart(4)} lines, ${String(f.chars).padStart(6)} chars`,
  );
}
