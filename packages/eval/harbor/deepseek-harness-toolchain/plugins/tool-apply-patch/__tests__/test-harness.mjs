// A registered `apply_patch` over a real temporary directory.
//
// The Harness API is not faked: `@deepseek-ai/dsh-tools` and
// `@deepseek-ai/dsh-fs` are the versions the toolchain installs, so a schema
// this build would reject fails in a test rather than in a benchmark run.
// Neither is the filesystem — `*** Delete File:` and `*** Move to:` go through
// `ctx.fs.processPath` to real syscalls, which an in-memory store could not
// observe. What stands in for `dsh-fs-local` is a thin provider over a
// temporary directory, and every assertion reads that directory back.
//
// Not a `.test.mjs` file, so `node --test` does not pick it up.

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { FsError } from '@deepseek-ai/dsh-fs';
import { apply } from '../index.mjs';

/**
 * Mount `apply_patch` over a fresh temporary directory seeded with `files`.
 *
 * @param {{files?: Record<string, string>, sandboxMode?: string}} options
 * @returns {Promise<{
 *   root: string,
 *   run: (input: string) => Promise<string>,
 *   events: Array<[string, string, string]>,
 *   intents: string[],
 *   read: (path: string) => Promise<string>,
 *   exists: (path: string) => Promise<boolean>,
 *   tree: () => Promise<Record<string, string>>,
 * }>}
 */
export async function harness({
  files = {},
  sandboxMode,
  deciders = {},
  signal,
  afterStat,
  denyWrites,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maka-apply-patch-'));
  const events = [];
  const intents = [];
  const asked = [];
  const guards = [];
  const versions = [];
  const truth = [];
  const written = [];
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, typeof content === 'string' ? 'utf8' : undefined);
  }

  // Every provider call translates an already-aborted signal into
  // `FsError('FS_ABORTED')` (`dsh-fs-local` `throwIfAborted`), and a fake that
  // silently ignores the signal cannot notice a call that stopped passing it —
  // six separate mutations of `index.mjs` survived the whole suite for exactly
  // that reason. `calls` records what each one was handed.
  const calls = [];
  const aborting = (verb, callSignal) => {
    calls.push({ verb, signal: callSignal });
    if (callSignal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED');
  };

  // `dsh-fs-local` splits these two: `displayPath` is the lexical
  // `resolve(cwd, path)`, `targetKey` is derived from its realpath. Collapsing
  // them here would hide what a symlink does.
  const target = async (path) => ({
    displayPath: path,
    targetKey: await realpath(path).catch(() => path),
  });
  const version = async (path) => {
    const info = await stat(path).catch(() => undefined);
    return info === undefined ? undefined : `${info.size}:${info.mtimeMs}`;
  };

  const registered = [];
  const ctx = {
    fs: {
      sandboxMode,
      resolve: async (path, options) => {
        assert.equal(options.cwd, root, 'the session cwd must reach the provider');
        aborting('resolve', options.signal);
        return target(isAbsolute(path) ? path : resolve(options.cwd, path));
      },
      stat: async (target, statSignal) => {
        const { targetKey } = target;
        aborting('stat', statSignal);
        const info = await stat(targetKey).catch(() => undefined);
        // The one thing a real filesystem does that an in-process fake cannot:
        // change underneath a turn. `afterStat` opens exactly the window
        // between a stat and the syscall that acts on its answer, which is the
        // only window in which `rm`'s `force` flag is observable at all.
        await afterStat?.(target);
        if (info === undefined) return undefined;
        // `dsh-fs-local` reports three kinds, not two: a FIFO or a device is
        // `other`, and the tool's `info.type !== 'file'` guards are untestable
        // against a fake that calls everything a file.
        const type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
        return { type, version: `${info.size}:${info.mtimeMs}` };
      },
      // `dsh-fs-local` `readWholeText` rejects a NUL in the first sample bytes
      // and decodes with `new TextDecoder('utf-8', {fatal: true})`, so a binary
      // or invalid-UTF-8 file raises `FS_NOT_TEXT` rather than arriving with
      // U+FFFD where a byte used to be. Reading it as lossy UTF-8 here meant a
      // fixture could pin corrupted output as correct.
      readText: async (target, readSignal) => {
        aborting('read', readSignal);
        const raw = await readFile(target.targetKey);
        if (raw.subarray(0, 8192).includes(0)) {
          throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT');
        }
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(raw);
        } catch (cause) {
          throw new FsError(`cannot read "${target.displayPath}": not text`, 'FS_NOT_TEXT', {
            cause,
          });
        }
      },
      // `readWholeBytes`: no decoding and no binary rejection, a stat-size
      // short-circuit above `maxBytes`, and `FS_TOO_LARGE` when it binds.
      readBytes: async (target, readSignal, maxBytes) => {
        aborting('read', readSignal);
        assert.equal(typeof maxBytes, 'number', 'readBytes takes a byte cap');
        const info = await stat(target.targetKey).catch(() => undefined);
        if (info === undefined) {
          throw new FsError(`cannot read "${target.displayPath}"`, 'FS_NOT_FOUND');
        }
        if (!info.isFile()) {
          throw new FsError(`"${target.displayPath}" is not a regular file`, 'FS_NOT_REGULAR_FILE');
        }
        if (info.size > maxBytes) {
          throw new FsError(
            `cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`,
            'FS_TOO_LARGE',
          );
        }
        return readFile(target.targetKey);
      },
      // The write guards `dsh-fs-local` enforces, enforced here too. A fake that
      // records the guard and writes anyway would pass whatever guard this tool
      // passed it, including none.
      //
      // The signal and the sandbox policy are recorded rather than ignored:
      // dropping either from the call is invisible to a three-parameter fake,
      // and both were dropped at some point without a test noticing.
      writeText: async ({ targetKey }, content, expected, writeSignal, sandboxPolicy) => {
        aborting('write', writeSignal);
        if (denyWrites) {
          throw new FsError(`cannot write "${targetKey}"`, 'FS_SANDBOX_DENIED');
        }
        intents.push(expected === undefined ? 'unconditional' : expected.kind);
        guards.push({ signal: writeSignal, sandboxPolicy });
        const existing = await stat(targetKey).catch(() => undefined);
        if (existing !== undefined && !existing.isFile()) {
          throw new FsError(`${targetKey} is not a regular file`, 'FS_NOT_REGULAR_FILE');
        }
        const current = await version(targetKey);
        if (expected?.kind === 'createIfAbsent' && current !== undefined) {
          throw new FsError(`${targetKey} already exists`, 'FS_NOT_OBSERVED');
        }
        if (expected?.kind === 'replaceIfVersion' && current !== expected.version) {
          throw new FsError(`${targetKey} changed since it was read`, 'FS_STALE_VERSION');
        }
        // `dsh-fs-local` creates the parent, in `writeFileAtomic`. Leaving that
        // out here made the tool carry an `ensureParent` of its own that no
        // mounted provider needed — a fake weaker than the real thing does not
        // just fail to catch bugs, it invents code.
        await mkdir(dirname(targetKey), { recursive: true });
        await writeFile(targetKey, content);
        const outcome = { version: await version(targetKey) };
        written.push(outcome.version);
        return outcome;
      },
      processPath: ({ targetKey }) => targetKey,
    },
    get: () => (sandboxMode === undefined ? undefined : { resolve: () => ({ mode: sandboxMode }) }),
    // The version travels with the observation. Recording only the kind left
    // every version the tool publishes unasserted, and an observation policy
    // downstream keys on exactly that.
    // An observation is a claim about the filesystem at the moment it is made,
    // so what the filesystem actually held at that moment is recorded with it.
    // Without that, swapping the `absent` emission and the unlink it describes
    // produces an identical event list, and the tool announces a removal that
    // has not happened.
    emit: (event, subject, observation) => {
      events.push([event, subject.displayPath.slice(root.length + 1), observation.kind]);
      versions.push(observation.version);
      truth.push(existsSync(subject.displayPath) ? 'present' : 'absent');
    },
    // A waterfall that only ever calls the fallback cannot observe a decider's
    // answer being asked for and then thrown away, which is what happened on
    // the move-destination path. `deciders` installs one, and `asked` records
    // every event the tool consulted whether a decider answered or not.
    waterfall: async (event, target, _exec, fallback) => {
      asked.push(event);
      const decider = deciders[event];
      return decider === undefined ? fallback() : decider(target);
    },
    tools: { register: (tool) => registered.push(tool) },
  };
  apply(ctx, {});

  const [tool] = registered;
  const exec = { signal, agent: { session: { header: { cwd: root } } } };
  const walk = async (dir, out) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, out);
      else out[relative(root, path)] = await readFile(path, 'utf8');
    }
    return out;
  };

  return {
    root,
    events,
    intents,
    asked,
    guards,
    calls,
    versions,
    truth,
    written,
    tool,
    run: (input) => tool.execute({ input }, exec),
    read: (path) => readFile(join(root, path), 'utf8'),
    exists: (path) =>
      stat(join(root, path)).then(
        () => true,
        () => false,
      ),
    tree: () => walk(root, {}),
  };
}
