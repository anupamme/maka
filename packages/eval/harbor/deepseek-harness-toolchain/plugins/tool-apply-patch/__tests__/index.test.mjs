// What this tool does over the Harness filesystem seam, as opposed to what the
// port computes.
//
// The hunk semantics are pinned by codex-fixtures.test.mjs against the real
// `codex` binary. What is left, and what is here, is everything the reference
// has no equivalent of: the write guards `ctx.fs` takes, the `fs/observed`
// trail, delete and rename going out through `processPath`, and the refusals a
// confining provider forces.

import { strict as assert } from 'node:assert';
import { chmod, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { harness } from './test-harness.mjs';

let mounted;
const run = (input) => mounted.run(input);
const read = (path) => mounted.read(path);
const exists = (path) => mounted.exists(path);
const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

afterEach(() => rm(mounted.root, { recursive: true, force: true }));

describe('apply_patch', () => {
  beforeEach(async () => {
    mounted = await harness({ files: { 'app.py': 'def greet():\n    print("Hi")\n' } });
  });

  it('reports what it changed the way Codex reports it', async () => {
    // `print_summary`, verbatim. The summary is part of the contract: it is how
    // the model learns that a rename landed as `M <new path>` rather than as a
    // delete and an add.
    await writeFile(join(mounted.root, 'stale.txt'), 'gone soon\n');
    const result = await run(
      patch(
        '*** Add File: a.txt',
        '+alpha',
        '*** Update File: app.py',
        '@@ def greet():',
        '-    print("Hi")',
        '+    print("Hello")',
        '*** Delete File: stale.txt',
      ),
    );
    assert.equal(result, 'Success. Updated the following files:\nA a.txt\nM app.py\nD stale.txt');
    assert.equal(await read('a.txt'), 'alpha\n');
    assert.equal(await read('app.py'), 'def greet():\n    print("Hello")\n');
    assert.equal(await exists('stale.txt'), false);
  });

  it('creates the parent directories a new file needs', async () => {
    // Codex creates a missing parent rather than refusing, and a model writing
    // a module into a package it is also creating depends on it.
    await run(patch('*** Add File: pkg/sub/mod.py', '+x = 1'));
    assert.equal(await read('pkg/sub/mod.py'), 'x = 1\n');
  });

  it('guards a create against the absence it observed', async () => {
    await run(patch('*** Add File: fresh.txt', '+x'));
    assert.deepEqual(mounted.intents, ['createIfAbsent']);
  });

  it('guards an update against the version it read', async () => {
    await run(patch('*** Update File: app.py', '@@', '-    print("Hi")', '+    print("Hello")'));
    assert.deepEqual(mounted.intents, ['replaceIfVersion']);
  });

  it('guards an overwriting Add File against the version it read', async () => {
    // Codex has no already-exists refusal on `*** Add File:`; it reads what is
    // there, records it as overwritten, and writes. The file it read is still
    // the file it must not clobber blindly, so the guard is the version rather
    // than an absence that does not hold.
    const result = await run(patch('*** Add File: app.py', '+clobbered'));
    assert.equal(await read('app.py'), 'clobbered\n');
    assert.equal(result, 'Success. Updated the following files:\nA app.py');
    assert.deepEqual(mounted.intents, ['replaceIfVersion']);
  });

  it('deletes a symlink and not what it points at', async () => {
    // The provider's target key is realpath-derived, so removing it would have
    // deleted the pointee and left the link dangling. Codex unlinks the path the
    // patch named.
    await writeFile(join(mounted.root, 'real.py'), 'kept\n');
    await symlink(join(mounted.root, 'real.py'), join(mounted.root, 'link.py'));
    await run(patch('*** Delete File: link.py'));
    assert.equal(await exists('link.py'), false, 'the link itself is gone');
    assert.equal(await read('real.py'), 'kept\n', 'the file it pointed at survives');
  });

  it('renames and patches in one operation', async () => {
    const result = await run(
      patch(
        '*** Update File: app.py',
        '*** Move to: src/main.py',
        '@@ def greet():',
        '-    print("Hi")',
        '+    print("Hello")',
      ),
    );
    assert.equal(await exists('app.py'), false);
    assert.equal(await read('src/main.py'), 'def greet():\n    print("Hello")\n');
    // `AffectedPaths` records a rename as a modification of its destination.
    assert.equal(result, 'Success. Updated the following files:\nM src/main.py');
    // The source file's version cannot guard a different file, so the
    // destination write is unconditional.
    assert.deepEqual(mounted.intents, ['unconditional']);
  });

  it('overwrites an existing rename destination', async () => {
    // Codex records what was overwritten and proceeds rather than refusing.
    await writeFile(join(mounted.root, 'taken.py'), 'old\n');
    await run(
      patch(
        '*** Update File: app.py',
        '*** Move to: taken.py',
        '@@ def greet():',
        '-    print("Hi")',
        '+    print("Hello")',
      ),
    );
    assert.equal(await read('taken.py'), 'def greet():\n    print("Hello")\n');
    assert.equal(await exists('app.py'), false);
  });

  it('refuses an envelope that names one path twice', async () => {
    // `try_verify_apply_patch_args` collects the hunks into a map keyed by
    // resolved path and refuses a duplicate key before reading anything
    // (invocation.rs:232). Composing them instead — which the standalone
    // binary does — would give this arm a second edit the model's own Codex
    // would have rejected.
    await assert.rejects(
      run(
        patch(
          '*** Update File: app.py',
          '@@',
          '-    print("Hi")',
          '+    print("Hello")',
          '*** Update File: app.py',
          '@@',
          '-    print("Hello")',
          '+    print("Hey")',
        ),
      ),
      /multiple operations target app\.py/u,
    );
    assert.equal(await read('app.py'), 'def greet():\n    print("Hi")\n');
  });

  it('lets a rename land on a path a later section then fails to find', async () => {
    // A rename's destination is not a key: verification holds `move_path` as a
    // value (invocation.rs:232-280), so both sections pass pass one — the second
    // is computed against the pre-patch `other.py`. Pass two then renames first,
    // and the second section reads what the rename left. Confirmed against the
    // reference binary, which leaves exactly this state.
    await writeFile(join(mounted.root, 'other.py'), 'x = 1\n');
    await assert.rejects(
      run(
        patch(
          '*** Update File: app.py',
          '*** Move to: other.py',
          '@@',
          '-    print("Hi")',
          '+    print("Hello")',
          '*** Update File: other.py',
          '@@',
          '-x = 1',
          '+x = 2',
        ),
      ),
      /Failed to find expected lines in other\.py/u,
    );
    assert.equal(await exists('app.py'), false);
    assert.equal(await read('other.py'), 'def greet():\n    print("Hello")\n');
  });

  it('writes nothing when a later section fails to apply', async () => {
    // The map is built over the pre-patch tree, so a hunk the model guessed at
    // fails while nothing has been written yet. The standalone binary, which
    // applies as it goes, would have left `created.txt` behind.
    await assert.rejects(
      run(
        patch(
          '*** Add File: created.txt',
          '+alpha',
          '*** Update File: app.py',
          '@@',
          '-    print("nothing like this")',
          '+    print("Hello")',
        ),
      ),
      /Failed to find expected lines in app\.py/u,
    );
    assert.equal(await exists('created.txt'), false);
    assert.deepEqual(mounted.intents, [], 'nothing reached the provider');
  });

  it('names the file whose hunk failed', async () => {
    // `Invalid Context 0` alone leaves the model guessing which of several
    // sections to rewrite. Upstream names the resolved absolute path; this
    // names the path the model wrote, which is the string it has to fix.
    await assert.rejects(run(patch('*** Update File: app.py', '@@', '-nope', '+x')), {
      code: 'FS_EDIT_NOT_FOUND',
      message: /^Failed to find expected lines in app\.py:\nnope$/u,
    });
  });

  it('refuses to update a file that does not exist', async () => {
    await assert.rejects(run(patch('*** Update File: missing.py', '@@', '-a', '+b')), {
      code: 'FS_NOT_FOUND',
    });
  });

  it('refuses to delete a file that does not exist', async () => {
    await assert.rejects(run(patch('*** Delete File: missing.py')), { code: 'FS_NOT_FOUND' });
  });

  it('refuses to update something that is not a regular file', async () => {
    await assert.rejects(run(patch('*** Update File: .', '@@', '-a', '+b')), {
      code: 'FS_NOT_REGULAR_FILE',
    });
  });

  it('deletes a file moved onto itself, and reports success', async () => {
    // Not a refusal and not a no-op. `*** Move to:` writes the destination and
    // then unlinks the source, in that order (lib.rs), so naming the source as
    // the destination unlinks what was just written. The reference binary does
    // this, prints `M app.py`, and exits 0; reproducing it is the point of the
    // arm, and refusing it — which this did — would hide a real footgun of the
    // contract behind a guard Codex does not have.
    assert.equal(
      await run(
        patch(
          '*** Update File: app.py',
          '*** Move to: app.py',
          '@@',
          '-    print("Hi")',
          '+    print("Hello")',
        ),
      ),
      'Success. Updated the following files:\nM app.py',
    );
    assert.equal(await exists('app.py'), false);
  });

  it('surfaces a syntax error unchanged', async () => {
    await assert.rejects(run('*** Add File: a.txt\n+x'), { name: 'SyntaxError' });
  });

  it('records what it observed before writing', async () => {
    await run(
      patch(
        '*** Update File: app.py',
        '@@ def greet():',
        '-    print("Hi")',
        '+    print("Hello")',
      ),
    );
    assert.deepEqual(mounted.events, [
      ['fs/observed', 'app.py', 'present'],
      ['fs/observed', 'app.py', 'present'],
    ]);
  });

  it('records a confirmed absence when creating', async () => {
    await run(patch('*** Add File: fresh.txt', '+x'));
    assert.deepEqual(mounted.events, [
      ['fs/observed', 'fresh.txt', 'absent'],
      ['fs/observed', 'fresh.txt', 'present'],
    ]);
  });

  it('records both ends of a rename', async () => {
    await run(
      patch(
        '*** Update File: app.py',
        '*** Move to: moved.py',
        '@@',
        '-    print("Hi")',
        '+    print("Hello")',
      ),
    );
    assert.deepEqual(mounted.events, [
      ['fs/observed', 'app.py', 'present'],
      ['fs/observed', 'moved.py', 'absent'],
      ['fs/observed', 'moved.py', 'present'],
      ['fs/observed', 'app.py', 'absent'],
    ]);
    // And each of them true when it was published: emitting the source's
    // `absent` before the unlink leaves the event list identical.
    assert.deepEqual(mounted.truth, ['present', 'absent', 'present', 'absent']);
  });

  it('presents the paths a patch touches', () => {
    assert.deepEqual(mounted.tool.presentCall({ input: patch('*** Delete File: a.py') }), {
      card: 'generic',
      title: 'apply_patch a.py',
      kind: 'edit',
      locations: [{ path: 'a.py' }],
    });
  });

  it('falls back to a bare card when the patch does not parse', () => {
    assert.deepEqual(mounted.tool.presentCall({ input: 'not a patch' }), {
      card: 'generic',
      title: 'apply_patch',
      kind: 'edit',
    });
  });
});

describe('apply_patch under a confining provider', () => {
  beforeEach(async () => {
    mounted = await harness({ files: { 'app.py': 'x = 1\n' }, sandboxMode: 'workspace-write' });
  });

  // Delete and rename are the two operations `ctx.fs` cannot express, so they
  // reach the filesystem through `processPath`. Under a provider that confines,
  // that path is the way out of the sandbox — so they refuse instead, before
  // anything is written.
  it('refuses to delete', async () => {
    await assert.rejects(run(patch('*** Delete File: app.py')), /Delete File.*unavailable/su);
    assert.equal(await exists('app.py'), true);
  });

  it('refuses to rename', async () => {
    await assert.rejects(
      run(patch('*** Update File: app.py', '*** Move to: b.py', '@@', '-x = 1', '+x = 2')),
      /Move to.*unavailable/su,
    );
    assert.equal(await exists('app.py'), true);
  });

  it('still edits in place', async () => {
    await run(patch('*** Update File: app.py', '@@', '-x = 1', '+x = 2'));
    assert.equal(await read('app.py'), 'x = 2\n');
  });

  it('creates a missing parent through the provider and not around it', async () => {
    // There was an `ensureParent` here that ran `mkdir` on a `processPath`
    // before every write — the same way out of the sandbox that delete and
    // rename refuse for. It was never needed: `dsh-fs-local` creates the parent
    // itself, in `writeFileAtomic`, under whatever the provider enforces. The
    // tool now has no call that creates a directory, so there is nothing left
    // to guard and this asserts the behaviour that replaced it.
    await run(patch('*** Add File: sub/dir/x.txt', '+x'));
    assert.equal(await read('sub/dir/x.txt'), 'x\n');
  });
});

// The seam between this tool and the provider: the guards it hands to
// `writeText`, the deciders it consults, the signal it carries, and the
// vocabulary its failures arrive in.
//
// This block exists because none of it was covered. Replacing both waterfall
// calls with `undefined`, dropping the signal and the sandbox policy from the
// `writeText` call, and forcing the move destination's observation to `absent`
// each left the whole suite green.
describe('apply_patch at the provider seam', () => {
  const two = { 'a.txt': 'a\n', 'dest.txt': 'PRECIOUS\n' };
  const move = patch('*** Update File: a.txt', '*** Move to: dest.txt', '@@', '-a', '+A');

  it('consults no decider for a move destination it will overwrite anyway', async () => {
    // Asking `fs/write-intent` and then discarding the answer is worse than not
    // asking: a decider that refuses to clobber is recorded as consulted and
    // the file is overwritten regardless. The destination write is
    // unconditional by Codex's own semantics, so nothing is asked.
    const mounted = await harness({
      files: two,
      deciders: { 'fs/write-intent': () => ({ kind: 'createIfAbsent' }) },
    });
    try {
      await mounted.run(move);
      // Not one waterfall: the source is removed rather than written, and the
      // destination write is unconditional.
      assert.deepEqual(mounted.asked, []);
      assert.deepEqual(mounted.intents, ['unconditional']);
      assert.equal(await mounted.read('dest.txt'), 'A\n');
    } finally {
      await rm(mounted.root, { recursive: true, force: true });
    }
  });

  it('hands an edit decider its own version, not the one it read', async () => {
    const mounted = await harness({
      files: { 'a.txt': 'a\n' },
      deciders: { 'fs/edit-intent': () => ({ version: 'not-the-current-one' }) },
    });
    try {
      await assert.rejects(
        mounted.run(patch('*** Update File: a.txt', '@@', '-a', '+A')),
        (error) => error.code === 'FS_STALE_VERSION',
      );
      assert.deepEqual(mounted.intents, ['replaceIfVersion']);
      assert.equal(await mounted.read('a.txt'), 'a\n');
    } finally {
      await rm(mounted.root, { recursive: true, force: true });
    }
  });

  it('carries the turn signal and the sandbox policy into every write', async () => {
    const signal = AbortSignal.timeout(600000);
    const mounted = await harness({
      files: { 'a.txt': 'a\n' },
      sandboxMode: 'danger-full-access',
      signal,
    });
    try {
      await mounted.run(patch('*** Update File: a.txt', '@@', '-a', '+A'));
      assert.equal(mounted.guards.length, 1);
      assert.equal(mounted.guards[0].signal, signal);
      assert.deepEqual(mounted.guards[0].sandboxPolicy, { mode: 'danger-full-access' });
    } finally {
      await rm(mounted.root, { recursive: true, force: true });
    }
  });

  it('stops between operations when the turn is aborted, in the seam vocabulary', async () => {
    const controller = new AbortController();
    controller.abort();
    const mounted = await harness({ files: { 'a.txt': 'a\n' }, signal: controller.signal });
    try {
      await assert.rejects(
        mounted.run(patch('*** Add File: b.txt', '+b')),
        (error) => error.code === 'FS_ABORTED',
      );
      assert.equal(await mounted.exists('b.txt'), false);
    } finally {
      await rm(mounted.root, { recursive: true, force: true });
    }
  });

  it('refuses the whole envelope when a file it would delete is not text', async () => {
    // Upstream's verify pass reads a delete target — `read_file_text`, which
    // maps invalid UTF-8 to `InvalidData` (`invocation.rs:247`,
    // `file-system/src/lib.rs:434-443`) — so a binary file refuses the envelope
    // before anything is written. Statting it instead applied the delete.
    const mounted = await harness({ files: { 'a.txt': 'a\n' } });
    try {
      await writeFile(join(mounted.root, 'blob.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
      await assert.rejects(
        mounted.run(patch('*** Delete File: blob.bin', '*** Update File: a.txt', '@@', '-a', '+A')),
        (error) => error.code === 'FS_NOT_TEXT',
      );
      assert.equal(await mounted.exists('blob.bin'), true);
      assert.equal(await mounted.read('a.txt'), 'a\n');
    } finally {
      await rm(mounted.root, { recursive: true, force: true });
    }
  });

  it('does not claim to have observed a file it never read', async () => {
    // `*** Add File:` over an existing path. Upstream's verify pass does not
    // stat it and does not read it; emitting `present` off a stat told an
    // observation policy the file had been seen, and it is exactly such a
    // policy that would otherwise refuse the blind overwrite.
    const mounted = await harness({ files: { 'a.txt': 'PRECIOUS\n' } });
    try {
      await mounted.run(patch('*** Add File: a.txt', '+new'));
      assert.deepEqual(mounted.events, [['fs/observed', 'a.txt', 'present']]);
      assert.deepEqual(mounted.asked, ['fs/edit-intent']);
    } finally {
      await rm(mounted.root, { recursive: true, force: true });
    }
  });

  it('records what a rename is about to replace', async () => {
    // The one case `observed(stat(destination))` exists for. Every other test
    // moves onto an absent path, where a forced `{kind:'absent'}` is
    // indistinguishable from reading the destination.
    const mounted = await harness({ files: two });
    try {
      await mounted.run(move);
      assert.deepEqual(mounted.events, [
        ['fs/observed', 'a.txt', 'present'],
        ['fs/observed', 'dest.txt', 'present'],
        ['fs/observed', 'dest.txt', 'present'],
        ['fs/observed', 'a.txt', 'absent'],
      ]);
    } finally {
      await rm(mounted.root, { recursive: true, force: true });
    }
  });

  it('reports a delete of a file that went away underneath the turn', async () => {
    // `force: false` is only observable against a file that disappears between
    // the stat that found it and the unlink that acts on that answer. With
    // `force: true` the turn reports `D b.txt` for a delete it did not perform.
    let mounted;
    let stats = 0;
    mounted = await harness({
      files: { 'b.txt': 'b\n' },
      // Pass one stats and reads it; the file goes away after pass two's stat,
      // which is the answer the unlink acts on.
      afterStat: async (target) => {
        if (target.displayPath.endsWith('b.txt') && (stats += 1) === 2) {
          await rm(join(mounted.root, 'b.txt'));
        }
      },
    });
    try {
      await assert.rejects(
        mounted.run(patch('*** Delete File: b.txt')),
        (error) =>
          error.code === 'FS_IO_ERROR' && /^Cannot delete b\.txt: ENOENT$/.test(error.message),
      );
    } finally {
      await rm(mounted.root, { recursive: true, force: true });
    }
  });

  it('reports a failed unlink in the seam vocabulary, naming the path the model wrote', async () => {
    const mounted = await harness({ files: { 'keep/x.txt': 'x\n' } });
    try {
      await chmod(join(mounted.root, 'keep'), 0o555);
      await assert.rejects(mounted.run(patch('*** Delete File: keep/x.txt')), (error) => {
        assert.equal(error.code, 'FS_IO_ERROR');
        assert.match(error.message, /^Cannot delete keep\/x\.txt: EACCES$/);
        return true;
      });
    } finally {
      await chmod(join(mounted.root, 'keep'), 0o755).catch(() => {});
      await rm(mounted.root, { recursive: true, force: true });
    }
  });

  it('keys the duplicate check lexically, as upstream does, and names the offender', async () => {
    // `PathUri::join` resolves no symlink, so upstream sees two distinct keys
    // here and applies both sections in order — confirmed against the binary.
    // Keying on the provider's realpath-derived target key refused it.
    const mounted = await harness({ files: { 'a.txt': 'alpha\nbeta\n' } });
    try {
      await symlink('a.txt', join(mounted.root, 'link.txt'));
      await mounted.run(
        patch(
          '*** Update File: a.txt',
          '@@',
          '-alpha',
          '+ALPHA',
          '*** Update File: link.txt',
          '@@',
          '-beta',
          '+BETA',
        ),
      );
      assert.equal(await mounted.read('a.txt'), 'ALPHA\nBETA\n');

      await assert.rejects(
        mounted.run(
          patch('*** Update File: a.txt', '@@', '-ALPHA', '+X', '*** Delete File: a.txt'),
        ),
        (error) => error.message === 'multiple operations target a.txt',
      );
    } finally {
      await rm(mounted.root, { recursive: true, force: true });
    }
  });
});

// The seam's remaining surface: what each provider call is handed, what the
// observation trail publishes, and the one vocabulary a sandbox denial reaches
// the model in.
//
// Every test here was written against a mutation that survived the suite.
describe('apply_patch seam details', () => {
  it('consults the create decider and honours what it says', async () => {
    // `resolveIntent`'s create branch had no coverage at all: replacing the
    // waterfall with a literal `{kind:'createIfAbsent'}`, and renaming the
    // event, both left the suite green.
    const mounted = await harness({
      files: {},
      deciders: { 'fs/write-intent': () => ({ kind: 'replaceIfVersion', version: 'nope' }) },
    });
    try {
      await assert.rejects(
        mounted.run(patch('*** Add File: fresh.txt', '+x')),
        (error) => error.code === 'FS_STALE_VERSION',
      );
      assert.deepEqual(mounted.asked, ['fs/write-intent']);
      assert.deepEqual(mounted.intents, ['replaceIfVersion']);
    } finally {
      await rm(mounted.root, { recursive: true, force: true });
    }
  });

  it('hands the turn signal to every provider call, not only the writes', async () => {
    const signal = AbortSignal.timeout(600000);
    const mounted = await harness({
      files: { 'a.txt': 'a\n', 'dest.txt': 'x\n' },
      sandboxMode: undefined,
      signal,
    });
    try {
      await mounted.run(
        patch(
          '*** Add File: new.txt',
          '+n',
          '*** Update File: a.txt',
          '*** Move to: dest.txt',
          '@@',
          '-a',
          '+A',
        ),
      );
      // Both passes, both operations, every verb.
      assert.deepEqual([...new Set(mounted.calls.map(({ verb }) => verb))].sort(), [
        'read',
        'resolve',
        'stat',
        'write',
      ]);
      assert.ok(mounted.calls.length >= 8, `only ${mounted.calls.length} provider calls`);
      const unsignalled = mounted.calls.filter((call) => call.signal !== signal);
      assert.deepEqual(unsignalled, [], 'a provider call did not carry the turn signal');
      // Three writes, and the move destination's unconditional one is among
      // them. It is the write a confining provider never reaches, so this is
      // the only place its signal can be checked.
      assert.deepEqual(mounted.intents, ['createIfAbsent', 'unconditional']);
      for (const guard of mounted.guards) assert.equal(guard.signal, signal);
    } finally {
      await rm(mounted.root, { recursive: true, force: true });
    }
  });

  it('carries the sandbox policy into every write', async () => {
    // The earlier version of this assertion ran a single in-place update, so
    // `guards.length` was 1 and "every write" was one write.
    const signal = AbortSignal.timeout(600000);
    const mounted = await harness({
      files: { 'a.txt': 'a\n' },
      sandboxMode: 'danger-full-access',
      signal,
    });
    try {
      await mounted.run(
        patch('*** Add File: b.txt', '+b', '*** Update File: a.txt', '@@', '-a', '+A'),
      );
      assert.equal(mounted.guards.length, 2);
      assert.deepEqual(mounted.intents, ['createIfAbsent', 'replaceIfVersion']);
      for (const guard of mounted.guards) {
        assert.equal(guard.signal, signal);
        assert.deepEqual(guard.sandboxPolicy, { mode: 'danger-full-access' });
      }
    } finally {
      await rm(mounted.root, { recursive: true, force: true });
    }
  });

  it('publishes the version it was given, on both sides of a write', async () => {
    const mounted = await harness({ files: { 'a.txt': 'a\n' } });
    try {
      const summary = await mounted.run(patch('*** Update File: a.txt', '@@', '-a', '+A'));
      assert.ok(summary.startsWith('Success.'));
      // Pre-write `present` carries the version the stat returned; post-write
      // `present` carries the version the write returned; they differ, and
      // neither is undefined.
      assert.deepEqual(
        mounted.events.map(([, path, kind]) => `${path}:${kind}`),
        ['a.txt:present', 'a.txt:present'],
      );
      const [read, published] = mounted.versions;
      assert.equal(typeof read, 'string');
      // The published version must be the one `writeText` returned, not merely
      // a different string from the one that was read.
      assert.equal(published, mounted.written.at(-1));
      assert.notEqual(read, published);
    } finally {
      await rm(mounted.root, { recursive: true, force: true });
    }
  });

  it('reports a sandbox denial in the policy vocabulary', async () => {
    // `MutationPolicy.mapError` is the only thing that speaks to the model
    // about a denial, and reducing it to `return error` survived the suite.
    const mounted = await harness({
      files: {},
      sandboxMode: 'workspace-write',
      denyWrites: true,
    });
    try {
      await assert.rejects(mounted.run(patch('*** Add File: a.txt', '+x')), (error) => {
        assert.equal(error.code, 'FS_SANDBOX_DENIED');
        assert.match(error.message, /workspace-write/);
        return true;
      });
    } finally {
      await rm(mounted.root, { recursive: true, force: true });
    }
  });

  it('announces a removal only after it has happened', async () => {
    // Emitting the source `absent` before the unlink makes the trail a lie
    // whenever the unlink then fails, and both orderings passed.
    const mounted = await harness({ files: { 'a.txt': 'a\n' } });
    try {
      await mounted.run(patch('*** Delete File: a.txt'));
      assert.deepEqual(mounted.events, [
        ['fs/observed', 'a.txt', 'present'],
        ['fs/observed', 'a.txt', 'absent'],
      ]);
      // Each observation against what the filesystem actually held when it was
      // published. The event list alone is identical either way round.
      assert.deepEqual(mounted.truth, ['present', 'absent']);
      assert.equal(await mounted.exists('a.txt'), false);
    } finally {
      await rm(mounted.root, { recursive: true, force: true });
    }
  });
});
