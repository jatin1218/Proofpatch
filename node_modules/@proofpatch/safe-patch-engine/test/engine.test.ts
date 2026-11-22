import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { MemoryFileSystem, NodeFileSystem, PatchEngine, EMPTY_FINGERPRINT, sha256 } from '../src';
import { dirSnapshot, lines, makeEngine, makeWorkspace } from './helpers';

test('proposing never touches disk; accepted hunks appear in the overlay view only', async () => {
  const ws = await makeWorkspace({ 'a.txt': lines(30) });
  const eng = makeEngine(ws.root);
  const before = await dirSnapshot(ws.root);

  const next = lines(30).replace('line 3\n', 'THREE\n').replace('line 25\n', 'TWENTYFIVE\n');
  const res = await eng.proposeFile({ path: 'a.txt', newContent: next });
  assert.ok(res.ok);
  assert.equal(res.ok && res.hunkCount, 2);

  assert.deepEqual(await dirSnapshot(ws.root), before, 'disk untouched after propose');
  assert.equal(await eng.view.readFile('a.txt'), lines(30), 'nothing staged yet');
  assert.equal(eng.getStagedFingerprint(), EMPTY_FINGERPRINT);

  const cs = eng.getChangeSet()!;
  await eng.setHunkDecision(cs.files[0].hunks[0].id, 'accepted');
  assert.match(await eng.view.readFile('a.txt'), /THREE/);
  assert.doesNotMatch(await eng.view.readFile('a.txt'), /TWENTYFIVE/);
  assert.deepEqual(await dirSnapshot(ws.root), before, 'disk still untouched after accept');
  await ws.cleanup();
});

test('per-hunk review: accept one, reject one, apply writes only the accepted hunk; undo restores', async () => {
  const ws = await makeWorkspace({ 'a.txt': lines(30) });
  const eng = makeEngine(ws.root);
  const next = lines(30).replace('line 3\n', 'THREE\n').replace('line 25\n', 'TWENTYFIVE\n');
  await eng.proposeFile({ path: 'a.txt', newContent: next });
  const [h1, h2] = eng.getChangeSet()!.files[0].hunks;
  await eng.setHunkDecision(h1.id, 'accepted');
  await eng.setHunkDecision(h2.id, 'rejected');

  const applied = await eng.apply();
  assert.ok(applied.ok);
  assert.equal(await ws.read('a.txt'), lines(30).replace('line 3\n', 'THREE\n'));
  assert.equal(eng.getChangeSet(), null, 'change set closed after apply');

  const undone = await eng.undo();
  assert.ok(undone.ok);
  assert.equal(await ws.read('a.txt'), lines(30));
  await ws.cleanup();
});

test('apply refuses while hunks are undecided (no unreviewed apply) unless ignorePending', async () => {
  const ws = await makeWorkspace({ 'a.txt': lines(30) });
  const eng = makeEngine(ws.root);
  await eng.proposeFile({ path: 'a.txt', newContent: lines(30).replace('line 3\n', 'X\n').replace('line 25\n', 'Y\n') });
  const [h1] = eng.getChangeSet()!.files[0].hunks;
  await eng.setHunkDecision(h1.id, 'accepted');
  const r = await eng.apply();
  assert.ok(!r.ok && r.code === 'PENDING_HUNKS' && r.pending === 1);
  assert.equal(await ws.read('a.txt'), lines(30));
  const r2 = await eng.apply({ ignorePending: true });
  assert.ok(r2.ok);
  await ws.cleanup();
});

test('apply with nothing accepted writes nothing', async () => {
  const ws = await makeWorkspace({ 'a.txt': 'x\n' });
  const eng = makeEngine(ws.root);
  await eng.proposeFile({ path: 'a.txt', newContent: 'y\n' });
  await eng.setAllDecisions('rejected');
  const r = await eng.apply();
  assert.ok(!r.ok && r.code === 'NOTHING_STAGED');
  assert.equal(await ws.read('a.txt'), 'x\n');
  await ws.cleanup();
});

test('conflict: a file edited on disk after the proposal blocks apply and NOTHING is written (multi-file)', async () => {
  const ws = await makeWorkspace({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const eng = makeEngine(ws.root);
  const events: string[] = [];
  eng.on('conflict', () => events.push('conflict'));
  await eng.proposeFile({ path: 'a.txt', newContent: 'A\n' });
  await eng.proposeFile({ path: 'b.txt', newContent: 'B\n' });
  await eng.setAllDecisions('accepted');

  await ws.write('b.txt', 'b edited by the developer\n'); // concurrent edit

  const r = await eng.apply();
  assert.ok(!r.ok && r.code === 'CONFLICT');
  assert.equal(!r.ok && r.conflicts?.length, 1);
  assert.equal(!r.ok && r.conflicts?.[0].path, 'b.txt');
  assert.equal(!r.ok && r.conflicts?.[0].reason, 'modified-externally');
  assert.match((!r.ok && r.conflicts?.[0].diskDiff) || '', /\+b edited by the developer/);
  assert.equal(await ws.read('a.txt'), 'a\n', 'a.txt must NOT have been written');
  assert.equal(await ws.read('b.txt'), 'b edited by the developer\n');
  assert.deepEqual(events, ['conflict']);
  assert.equal((await eng.checkConflicts()).length, 1);
  await ws.cleanup();
});

test('conflict kinds: deleted-externally and created-externally', async () => {
  const ws = await makeWorkspace({ 'a.txt': 'a\n' });
  const eng = makeEngine(ws.root);
  await eng.proposeFile({ path: 'a.txt', newContent: 'A\n' });
  await eng.proposeFile({ path: 'new.txt', newContent: 'n\n' });
  await eng.setAllDecisions('accepted');
  await fsp.rm(path.join(ws.root, 'a.txt'));
  await ws.write('new.txt', 'someone else made this\n');
  const r = await eng.apply();
  assert.ok(!r.ok && r.code === 'CONFLICT');
  const reasons = !r.ok ? r.conflicts!.map((c) => c.reason).sort() : [];
  assert.deepEqual(reasons, ['created-externally', 'deleted-externally']);
  await ws.cleanup();
});

test('a write failure mid-apply rolls back every file already written', async () => {
  const mem = new MemoryFileSystem({ '/ws/a.txt': 'a\n', '/ws/b.txt': 'b\n', '/ws/c.txt': 'c\n' });
  const eng = new PatchEngine({ workspaceRoot: '/ws', fs: mem, undoDir: '/undo' });
  for (const f of ['a', 'b', 'c']) await eng.proposeFile({ path: `${f}.txt`, newContent: `${f.toUpperCase()}\n` });
  await eng.setAllDecisions('accepted');
  mem.failWhen = (op, abs) => op === 'write' && abs === '/ws/c.txt';

  const r = await eng.apply();
  assert.ok(!r.ok && r.code === 'WRITE_FAILED' && r.rolledBack === true);
  assert.equal(mem.files.get('/ws/a.txt'), 'a\n');
  assert.equal(mem.files.get('/ws/b.txt'), 'b\n');
  assert.equal(mem.files.get('/ws/c.txt'), 'c\n');
  const [rec] = await eng.listUndo();
  assert.equal(rec.status, 'rolled-back');
});

test('create and delete files: apply then undo restores exactly', async () => {
  const ws = await makeWorkspace({ 'old.txt': 'old content\n', 'keep.txt': 'keep\n' });
  const eng = makeEngine(ws.root);
  const before = await dirSnapshot(ws.root);
  await eng.proposeFile({ path: 'src/new/file.txt', newContent: 'brand new\n' });
  await eng.proposeDelete({ path: 'old.txt' });
  await eng.setAllDecisions('accepted');
  const r = await eng.apply();
  assert.ok(r.ok);
  assert.equal(await ws.read('src/new/file.txt'), 'brand new\n');
  assert.equal(await ws.exists('old.txt'), false);

  const u = await eng.undo();
  assert.ok(u.ok);
  assert.equal(await ws.exists('src/new/file.txt'), false);
  const after = await dirSnapshot(ws.root);
  assert.deepEqual(after, before);
  await ws.cleanup();
});

test('empty file create/delete works through synthetic hunks', async () => {
  const ws = await makeWorkspace({ 'empty.txt': '' });
  const eng = makeEngine(ws.root);
  await eng.proposeFile({ path: 'blank.txt', newContent: '' });
  await eng.proposeDelete({ path: 'empty.txt' });
  await eng.setAllDecisions('accepted');
  assert.ok((await eng.apply()).ok);
  assert.equal(await ws.read('blank.txt'), '');
  assert.equal(await ws.exists('empty.txt'), false);
  await ws.cleanup();
});

test('undo refuses when the file changed after apply (would clobber newer edits); force overrides', async () => {
  const ws = await makeWorkspace({ 'a.txt': 'one\n' });
  const eng = makeEngine(ws.root);
  await eng.proposeFile({ path: 'a.txt', newContent: 'two\n' });
  await eng.setAllDecisions('accepted');
  assert.ok((await eng.apply()).ok);
  await ws.write('a.txt', 'two plus my own edit\n');

  const u = await eng.undo();
  assert.ok(!u.ok && u.code === 'UNDO_CONFLICT');
  assert.equal(await ws.read('a.txt'), 'two plus my own edit\n');
  const forced = await eng.undo({ force: true });
  assert.ok(forced.ok);
  assert.equal(await ws.read('a.txt'), 'one\n');
  await ws.cleanup();
});

test('undo is durable across engine instances (journal on disk) and multi-step', async () => {
  const ws = await makeWorkspace({ 'a.txt': '1\n' });
  const e1 = makeEngine(ws.root);
  for (const v of ['2\n', '3\n']) {
    await e1.proposeFile({ path: 'a.txt', newContent: v });
    await e1.setAllDecisions('accepted');
    assert.ok((await e1.apply()).ok);
  }
  const e2 = makeEngine(ws.root); // "restart"
  assert.ok((await e2.undo()).ok);
  assert.equal(await ws.read('a.txt'), '2\n');
  assert.ok((await e2.undo()).ok);
  assert.equal(await ws.read('a.txt'), '1\n');
  const none = await e2.undo();
  assert.ok(!none.ok && none.code === 'NOTHING_TO_UNDO');
  await ws.cleanup();
});

test('crash recovery rolls back an interrupted apply and flags unknown content', async () => {
  const ws = await makeWorkspace({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  const eng = makeEngine(ws.root);
  for (const f of ['a', 'b', 'c']) await eng.proposeFile({ path: `${f}.txt`, newContent: `${f.toUpperCase()}\n` });
  await eng.setAllDecisions('accepted');
  assert.ok((await eng.apply()).ok);

  // Simulate a crash mid-apply: journal says "applying", a.txt got written, b.txt was edited by someone else.
  const [rec] = await eng.listUndo();
  const undoFile = path.join(ws.root + '-undo', `${rec.id}.json`);
  rec.status = 'applying';
  await fsp.writeFile(undoFile, JSON.stringify(rec));
  await ws.write('b.txt', 'b unknown\n');
  await ws.write('c.txt', 'c\n'); // c never written

  const fresh = makeEngine(ws.root);
  const report = await fresh.recover();
  assert.equal(report.inspected, 1);
  assert.deepEqual(report.rolledBack, ['a.txt']);
  assert.equal(report.needsAttention.length, 1);
  assert.equal(report.needsAttention[0].path, 'b.txt');
  assert.equal(await ws.read('a.txt'), 'a\n');
  assert.equal(await ws.read('b.txt'), 'b unknown\n', 'unknown content is never touched');
  assert.equal((await fresh.listUndo())[0].status, 'needs-attention');
  await ws.cleanup();
});

test('cancelTurn drops that turn\'s proposals, keeps other turns, ignores late proposals, disk stays clean', async () => {
  const ws = await makeWorkspace({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const eng = makeEngine(ws.root);
  const before = await dirSnapshot(ws.root);
  await eng.proposeFile({ path: 'a.txt', newContent: 'A\n', turnId: 't1' });
  await eng.proposeFile({ path: 'b.txt', newContent: 'B\n', turnId: 't2' });
  await eng.setAllDecisions('accepted');

  const c = await eng.cancelTurn('t2');
  assert.deepEqual(c.removedFiles, ['b.txt']);
  const late = await eng.proposeFile({ path: 'b.txt', newContent: 'B2\n', turnId: 't2' });
  assert.ok(!late.ok && late.code === 'TURN_CANCELLED');
  assert.equal(eng.getChangeSet()!.files.length, 1);
  assert.equal(await eng.view.readFile('b.txt'), 'b\n');
  assert.deepEqual(await dirSnapshot(ws.root), before);

  await eng.cancelTurn('t1');
  assert.equal(eng.getChangeSet(), null);
  assert.equal(eng.getStagedFingerprint(), EMPTY_FINGERPRINT);
  await ws.cleanup();
});

test('discard clears the change set without writing', async () => {
  const ws = await makeWorkspace({ 'a.txt': 'a\n' });
  const eng = makeEngine(ws.root);
  await eng.proposeFile({ path: 'a.txt', newContent: 'A\n' });
  await eng.setAllDecisions('accepted');
  assert.equal(await eng.discard(), true);
  assert.equal(await ws.read('a.txt'), 'a\n');
  assert.equal(eng.hasStagedChanges(), false);
  await ws.cleanup();
});

test('proposeEdits: exact match, ambiguity and not-found are reported; edits accumulate; CRLF respected', async () => {
  const ws = await makeWorkspace({ 'a.txt': 'alpha\nbeta\nalpha\n', 'crlf.txt': 'one\r\ntwo\r\n' });
  const eng = makeEngine(ws.root);

  const amb = await eng.proposeEdits({ path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] });
  assert.ok(!amb.ok && amb.code === 'EDIT_AMBIGUOUS' && amb.details?.matches === 2);
  const nf = await eng.proposeEdits({ path: 'a.txt', edits: [{ oldText: 'gamma', newText: 'x' }] });
  assert.ok(!nf.ok && nf.code === 'EDIT_NOT_FOUND');

  assert.ok((await eng.proposeEdits({ path: 'a.txt', edits: [{ oldText: 'beta', newText: 'BETA' }] })).ok);
  assert.ok((await eng.proposeEdits({ path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'A', replaceAll: true }] })).ok);

  const crlf = await eng.proposeEdits({ path: 'crlf.txt', edits: [{ oldText: 'one\ntwo', newText: 'uno\ndos' }] });
  assert.ok(crlf.ok && crlf.added === 2 && crlf.removed === 2, 'only the changed lines differ, not the whole file');

  await eng.setAllDecisions('accepted');
  assert.equal(await eng.view.readFile('a.txt'), 'A\nBETA\nA\n');
  assert.equal(await eng.view.readFile('crlf.txt'), 'uno\r\ndos\r\n');
  await ws.cleanup();
});

test('proposeFile with LF text for a CRLF file is normalised (no whole-file diff)', async () => {
  const ws = await makeWorkspace({ 'w.txt': 'a\r\nb\r\nc\r\n' });
  const eng = makeEngine(ws.root);
  const r = await eng.proposeFile({ path: 'w.txt', newContent: 'a\nB\nc\n' });
  assert.ok(r.ok && r.added === 1 && r.removed === 1);
  await ws.cleanup();
});

test('proposing identical content is a no-op; re-proposing keeps decisions for unchanged hunks', async () => {
  const ws = await makeWorkspace({ 'a.txt': lines(40) });
  const eng = makeEngine(ws.root);
  const same = await eng.proposeFile({ path: 'a.txt', newContent: lines(40) });
  assert.ok(same.ok && same.noChange && eng.getChangeSet() === null);

  const v1 = lines(40).replace('line 3\n', 'X\n');
  await eng.proposeFile({ path: 'a.txt', newContent: v1 });
  await eng.setAllDecisions('accepted');
  const v2 = v1.replace('line 35\n', 'Y\n'); // agent refines the proposal
  await eng.proposeFile({ path: 'a.txt', newContent: v2 });
  const hs = eng.getChangeSet()!.files[0].hunks;
  assert.equal(hs.length, 2);
  assert.deepEqual(hs.map((h) => h.state).sort(), ['accepted', 'proposed']);
  await ws.cleanup();
});

test('path safety: traversal, .git, secrets, binary, directories and symlink escapes are refused', async () => {
  const ws = await makeWorkspace({ 'ok.txt': 'x\n', 'bin.dat': 'a\0b', 'sub/inner.txt': 'i\n' });
  const outside = await makeWorkspace({ 'secret.txt': 'top secret\n' });
  await fsp.symlink(outside.root, path.join(ws.root, 'link'));
  await fsp.symlink(path.join(outside.root, 'secret.txt'), path.join(ws.root, 'filelink.txt'));
  const eng = makeEngine(ws.root);

  const code = async (p: string, content = 'z\n') => {
    const r = await eng.proposeFile({ path: p, newContent: content });
    return r.ok ? 'OK' : r.code;
  };
  assert.equal(await code('../escape.txt'), 'PATH_OUTSIDE_WORKSPACE');
  assert.equal(await code('sub/../../escape.txt'), 'PATH_OUTSIDE_WORKSPACE');
  assert.equal(await code(path.join(outside.root, 'x.txt')), 'PATH_OUTSIDE_WORKSPACE');
  assert.equal(await code('.git/config'), 'PATH_PROTECTED');
  assert.equal(await code('.proofpatch/undo/x.json'), 'PATH_PROTECTED');
  assert.equal(await code('.env'), 'PATH_SECRET');
  assert.equal(await code('certs/server.pem'), 'PATH_SECRET');
  assert.equal(await code('.env.example'), 'OK');
  assert.equal(await code('bin.dat'), 'BINARY_FILE');
  assert.equal(await code('ok.txt', 'a\0b'), 'BINARY_FILE');
  assert.equal(await code('sub'), 'NOT_A_FILE');
  assert.equal(await code('link/new.txt'), 'PATH_OUTSIDE_WORKSPACE', 'write through a symlinked dir');
  assert.equal(await code('filelink.txt'), 'PATH_OUTSIDE_WORKSPACE', 'write through a symlink to an outside file');
  await fsp.symlink(path.join(ws.root, 'ok.txt'), path.join(ws.root, 'innerlink.txt'));
  assert.equal(await code('innerlink.txt'), 'NOT_A_FILE', 'symlinks are never written through, even inside the workspace');
  const big = new PatchEngine({ workspaceRoot: ws.root, undoDir: ws.root + '-undo', maxFileBytes: 10 });
  assert.equal((await big.proposeFile({ path: 'ok.txt', newContent: 'x'.repeat(100) }) as any).code, 'FILE_TOO_LARGE');
  assert.equal(await outside.read('secret.txt'), 'top secret\n');
  await ws.cleanup();
  await outside.cleanup();
});

test('overlay view is consistent: read, exists, list, search and overlayState agree', async () => {
  const ws = await makeWorkspace({ 'src/a.py': 'def foo():\n    pass\n', 'src/b.py': 'x = 1\n', '.env': 'KEY=abc\n', 'node_modules/m/i.js': 'foo' });
  const eng = makeEngine(ws.root);
  await eng.proposeFile({ path: 'src/a.py', newContent: 'def foo():\n    return 42\n' });
  await eng.proposeFile({ path: 'src/c.py', newContent: 'foo_new = 1\n' });
  await eng.proposeDelete({ path: 'src/b.py' });
  assert.deepEqual((await eng.view.listFiles()).files, ['src/a.py', 'src/b.py'], 'nothing accepted: disk view');
  await eng.setAllDecisions('accepted');

  assert.deepEqual((await eng.view.listFiles()).files, ['src/a.py', 'src/c.py'], 'secrets/node_modules hidden; created shown; deleted hidden');
  assert.equal(await eng.view.exists('src/b.py'), false);
  assert.equal(await eng.view.exists('src/c.py'), true);
  const s = await eng.view.search('return 42');
  assert.deepEqual(s.matches.map((m) => `${m.path}:${m.line}`), ['src/a.py:2']);
  assert.equal((await eng.view.search('pass')).matches.length, 0, 'old text is gone from the staged view');
  assert.deepEqual((await eng.view.search('foo', { globs: ['**/c.py'] })).matches.map((m) => m.path), ['src/c.py']);
  const st = await eng.view.overlayState();
  assert.deepEqual([st.modified, st.created, st.deleted], [['src/a.py'], ['src/c.py'], ['src/b.py']]);
  const lr = await eng.view.readLines('src/a.py', 2, 99);
  assert.deepEqual([lr.startLine, lr.endLine, lr.totalLines, lr.text], [2, 2, 2, '    return 42\n']);
  await assert.rejects(() => eng.view.readFile('src/b.py'), /deleted in the staged view/);
  await ws.cleanup();
});

test('fingerprint: deterministic, changes with accepted content, reverts when unaccepted; events fire', async () => {
  const ws = await makeWorkspace({ 'a.txt': lines(40) });
  const eng = makeEngine(ws.root);
  const fps: string[] = [];
  eng.on('staged-changed', (e: { fingerprint: string }) => fps.push(e.fingerprint));

  await eng.proposeFile({ path: 'a.txt', newContent: lines(40).replace('line 3\n', 'X\n').replace('line 35\n', 'Y\n') });
  assert.equal(fps.length, 0, 'proposing alone stages nothing, so no staged-changed');
  const [h1, h2] = eng.getChangeSet()!.files[0].hunks;
  await eng.setHunkDecision(h1.id, 'accepted');
  const f1 = eng.getStagedFingerprint();
  await eng.setHunkDecision(h2.id, 'accepted');
  const f2 = eng.getStagedFingerprint();
  assert.notEqual(f1, f2);
  await eng.setHunkDecision(h2.id, 'rejected');
  assert.equal(eng.getStagedFingerprint(), f1, 'same accepted set -> same fingerprint');
  await eng.setHunkDecision(h1.id, 'proposed');
  assert.equal(eng.getStagedFingerprint(), EMPTY_FINGERPRINT);
  assert.deepEqual(fps, [f1, f2, f1, EMPTY_FINGERPRINT]);
  await ws.cleanup();
});

test('materializeSnapshot contains exactly the accepted content, rest of workspace copied, workspace untouched', async () => {
  const ws = await makeWorkspace({ 'a.txt': lines(40), 'keep.txt': 'keep\n', 'node_modules/x/i.js': 'dep', '.git/HEAD': 'ref' });
  const eng = makeEngine(ws.root);
  await eng.proposeFile({ path: 'a.txt', newContent: lines(40).replace('line 3\n', 'X\n').replace('line 35\n', 'Y\n') });
  const [h1, h2] = eng.getChangeSet()!.files[0].hunks;
  await eng.setHunkDecision(h1.id, 'accepted');
  await eng.setHunkDecision(h2.id, 'rejected');
  await eng.proposeFile({ path: 'n.txt', newContent: 'new\n' });
  await eng.setFileDecision('n.txt', 'accepted');
  const before = await dirSnapshot(ws.root);

  const snap = await eng.materializeSnapshot();
  assert.equal(snap.fingerprint, eng.getStagedFingerprint());
  assert.deepEqual(snap.stagedFiles, ['a.txt', 'n.txt']);
  const got = await dirSnapshot(snap.dir);
  assert.equal(got['a.txt'], lines(40).replace('line 3\n', 'X\n'));
  assert.equal(got['n.txt'], 'new\n');
  assert.equal(got['keep.txt'], 'keep\n');
  assert.ok(!('node_modules/x/i.js' in got) && !('.git/HEAD' in got));
  assert.deepEqual(await dirSnapshot(ws.root), before, 'workspace untouched');

  await assert.rejects(() => eng.materializeSnapshot({ dest: path.join(ws.root, 'inside') }), /outside|inside/i);
  await eng.disposeSnapshot(snap.dir);
  assert.equal(await fsp.access(snap.dir).then(() => true, () => false), false);
  await assert.rejects(() => eng.disposeSnapshot(ws.root), /not created as a snapshot/);
  await ws.cleanup();
});

test('unified diff export of accepted hunks matches content and applies with git', async () => {
  const ws = await makeWorkspace({ 'a.txt': lines(20) });
  const eng = makeEngine(ws.root);
  await eng.proposeFile({ path: 'a.txt', newContent: lines(20).replace('line 4\n', 'FOUR\nEXTRA\n') });
  await eng.setAllDecisions('accepted');
  const diff = eng.toUnifiedDiff();
  assert.match(diff, /^--- a\/a.txt\n\+\+\+ b\/a.txt\n@@ /);
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('git', ['init', '-q'], { cwd: ws.root });
    await fsp.writeFile(path.join(ws.root, 'p.diff'), diff);
    execFileSync('git', ['apply', '--check', 'p.diff'], { cwd: ws.root });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // git not installed: skip
    throw e;
  }
  await ws.cleanup();
});

test('NodeFileSystem atomic write preserves file mode and leaves no temp files', async () => {
  const ws = await makeWorkspace({ 'run.sh': '#!/bin/sh\necho hi\n' });
  await fsp.chmod(path.join(ws.root, 'run.sh'), 0o755);
  const eng = makeEngine(ws.root);
  await eng.proposeFile({ path: 'run.sh', newContent: '#!/bin/sh\necho bye\n' });
  await eng.setAllDecisions('accepted');
  assert.ok((await eng.apply()).ok);
  const st = await fsp.stat(path.join(ws.root, 'run.sh'));
  if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o755);
  assert.deepEqual((await fsp.readdir(ws.root)).filter((n) => n.includes('pp-tmp')), []);
  await ws.cleanup();
});

test('concurrent operations are serialised: parallel proposals and decisions never corrupt state', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 20; i++) files[`f${i}.txt`] = `v${i}\n`;
  const ws = await makeWorkspace(files);
  const eng = makeEngine(ws.root);
  await Promise.all(Object.keys(files).map((f) => eng.proposeFile({ path: f, newContent: `changed ${f}\n` })));
  assert.equal(eng.getChangeSet()!.files.length, 20);
  await Promise.all(eng.getChangeSet()!.files.flatMap((f) => f.hunks.map((h) => eng.setHunkDecision(h.id, 'accepted'))));
  const r = await eng.apply();
  assert.ok(r.ok && r.files.length === 20);
  for (const f of Object.keys(files)) assert.equal(await ws.read(f), `changed ${f}\n`);
  assert.ok(NodeFileSystem && sha256);
  await ws.cleanup();
});
