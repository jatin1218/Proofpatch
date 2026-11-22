import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHunks, computeHunks, detectEol, formatUnified, normalizeEol, splitLines, unifiedDiffText } from '../src';

const opts = { contextLines: 3, mergeGap: 6 };

// Deterministic PRNG so failures are reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomText(r: () => number, maxLines: number, alphabet: number): string {
  const n = Math.floor(r() * maxLines);
  let out = '';
  for (let i = 0; i < n; i++) out += `L${Math.floor(r() * alphabet)}` + (i === n - 1 && r() < 0.3 ? '' : '\n');
  return out;
}

test('splitLines keeps terminators and round-trips exactly', () => {
  for (const s of ['', 'a', 'a\n', 'a\nb', 'a\r\nb\r\n', '\n\n', 'x\n\ny']) {
    assert.equal(splitLines(s).join(''), s);
  }
});

test('fuzz: accepting all hunks reproduces the new text; accepting none reproduces the base', () => {
  const r = rng(42);
  for (let i = 0; i < 400; i++) {
    const a = randomText(r, 40, 6);
    const b = randomText(r, 40, 6);
    const al = splitLines(a);
    const hunks = computeHunks('f.txt', al, splitLines(b), opts);
    assert.equal(applyHunks(al, hunks), b, `all-accepted mismatch (case ${i})`);
    assert.equal(applyHunks(al, []), a);
  }
});

test('fuzz: every subset of hunks applies cleanly and each hunk is independent', () => {
  const r = rng(7);
  for (let i = 0; i < 150; i++) {
    const a = randomText(r, 50, 8);
    const b = randomText(r, 50, 8);
    const al = splitLines(a);
    const hunks = computeHunks('f.txt', al, splitLines(b), { contextLines: 2, mergeGap: 0 });
    for (let j = 0; j < hunks.length; j++) {
      const only = applyHunks(al, [hunks[j]]);
      // The result must equal base with exactly this hunk's range replaced.
      const expected = al.slice(0, hunks[j].oldStart).join('') + hunks[j].newLines.join('') + al.slice(hunks[j].oldEnd).join('');
      assert.equal(only, expected);
    }
    // Hunk ranges never overlap.
    for (let j = 1; j < hunks.length; j++) assert.ok(hunks[j].oldStart >= hunks[j - 1].oldEnd);
  }
});

test('hunks are minimal and separated by context for distant edits', () => {
  const base = Array.from({ length: 40 }, (_, i) => `l${i}\n`).join('');
  const next = base.replace('l5\n', 'L5\n').replace('l30\n', 'L30\n');
  const hunks = computeHunks('f', splitLines(base), splitLines(next), opts);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].oldLines, ['l5\n']);
  assert.deepEqual(hunks[1].newLines, ['L30\n']);
});

test('nearby edits merge into one hunk with the default merge gap, and split with mergeGap 0', () => {
  const base = Array.from({ length: 20 }, (_, i) => `l${i}\n`).join('');
  const next = base.replace('l5\n', 'X\n').replace('l8\n', 'Y\n');
  assert.equal(computeHunks('f', splitLines(base), splitLines(next), opts).length, 1);
  assert.equal(computeHunks('f', splitLines(base), splitLines(next), { contextLines: 3, mergeGap: 0 }).length, 2);
});

test('missing trailing newline is a real difference and is preserved', () => {
  const hunks = computeHunks('f', splitLines('a\nb\n'), splitLines('a\nb'), opts);
  assert.equal(hunks.length, 1);
  assert.equal(applyHunks(splitLines('a\nb\n'), hunks), 'a\nb');
  assert.match(formatUnified('f', hunks), /\\ No newline at end of file/);
});

test('unified diff output has git-style headers and counts', () => {
  const d = unifiedDiffText('src/x.py', 'a\nb\nc\n', 'a\nB\nc\n');
  assert.equal(d, '--- a/src/x.py\n+++ b/src/x.py\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
});

test('EOL detection and normalisation avoid whole-file CRLF diffs', () => {
  assert.equal(detectEol('a\r\nb\r\n'), 'crlf');
  assert.equal(detectEol('a\nb\n'), 'lf');
  assert.equal(detectEol('a\r\nb\n'), 'mixed');
  assert.equal(detectEol('abc'), 'none');
  assert.equal(normalizeEol('x\ny\n', 'crlf'), 'x\r\ny\r\n');
  assert.equal(normalizeEol('x\r\ny\r\n', 'lf'), 'x\ny\n');
});

test('large file with a small change stays fast (prefix/suffix trimming + bounded Myers)', () => {
  const base = Array.from({ length: 50000 }, (_, i) => `row ${i}\n`);
  const next = [...base];
  next[25000] = 'changed\n';
  const t = Date.now();
  const hunks = computeHunks('big', base, next, opts);
  assert.equal(hunks.length, 1);
  assert.ok(Date.now() - t < 2000);
});

test('totally different huge inputs fall back to a single replace-all hunk instead of hanging', () => {
  const a = Array.from({ length: 6000 }, (_, i) => `a${i}\n`);
  const b = Array.from({ length: 6000 }, (_, i) => `b${i}\n`);
  const hunks = computeHunks('f', a, b, { ...opts, maxEditDistance: 500 });
  assert.equal(hunks.length, 1);
  assert.equal(applyHunks(a, hunks), b.join(''));
});
