import { sha256 } from './hash';
import type { DiffLine, Hunk, HunkView } from './types';

/** Split into lines that KEEP their terminators, so join('') reproduces the input exactly. */
export function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const i = content.indexOf('\n', start);
    if (i === -1) {
      if (start < content.length) out.push(content.slice(start));
      break;
    }
    out.push(content.slice(start, i + 1));
    start = i + 1;
  }
  return out;
}

export type EolStyle = 'lf' | 'crlf' | 'mixed' | 'none';

export function detectEol(content: string): EolStyle {
  let lf = 0;
  let crlf = 0;
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) {
    lf++;
    if (i > 0 && content.charCodeAt(i - 1) === 13) crlf++;
  }
  if (lf === 0) return 'none';
  if (crlf === 0) return 'lf';
  return crlf === lf ? 'crlf' : 'mixed';
}

/** Make model-produced text use the same line endings as the file it edits (avoids whole-file diffs). */
export function normalizeEol(text: string, style: EolStyle): string {
  if (style === 'crlf' && !text.includes('\r')) return text.replace(/\n/g, '\r\n');
  if (style === 'lf' && text.includes('\r\n')) return text.replace(/\r\n/g, '\n');
  return text;
}

type Op = 'E' | 'D' | 'I';

function backtrack(trace: Int32Array[], n: number, m: number, dEnd: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d >= 0; d--) {
    const w = trace[d];
    const get = (k: number) => w[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('E');
      x--;
      y--;
    }
    if (d > 0) ops.push(x === prevX ? 'I' : 'D');
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** Myers O(ND) diff. Returns null if the edit distance exceeds maxD (caller falls back to replace-all). */
function myers(a: string[], b: string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, d);
    }
  }
  return null;
}

export interface Block {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/** Minimal change blocks between two line arrays. */
export function diffBlocks(a: string[], b: string[], maxEditDistance = 4000): Block[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (am.length === 0 && bm.length === 0) return [];
  const whole: Block[] = [{ oldStart: pre, oldEnd: pre + am.length, newStart: pre, newEnd: pre + bm.length }];
  if (am.length === 0 || bm.length === 0) return whole;
  const ops = myers(am, bm, maxEditDistance);
  if (!ops) return whole;

  const blocks: Block[] = [];
  let ai = 0;
  let bi = 0;
  let open: Block | null = null;
  for (const op of ops) {
    if (op === 'E') {
      if (open) {
        open.oldEnd = pre + ai;
        open.newEnd = pre + bi;
        blocks.push(open);
        open = null;
      }
      ai++;
      bi++;
    } else {
      if (!open) open = { oldStart: pre + ai, oldEnd: 0, newStart: pre + bi, newEnd: 0 };
      if (op === 'D') ai++;
      else bi++;
    }
  }
  if (open) {
    open.oldEnd = pre + ai;
    open.newEnd = pre + bi;
    blocks.push(open);
  }
  return blocks;
}

export function hunkId(path: string, oldStart: number, oldLines: string[], newLines: string[]): string {
  return sha256(`${path}\0${oldStart}\0${oldLines.join('')}\0${newLines.join('')}`).slice(0, 12);
}

export interface DiffOptions {
  contextLines: number;
  mergeGap: number;
  maxEditDistance?: number;
}

/** Compute independently-applicable hunks (each replaces a range of the BASE file). */
export function computeHunks(path: string, a: string[], b: string[], opts: DiffOptions): Hunk[] {
  const raw = diffBlocks(a, b, opts.maxEditDistance);
  const merged: Block[] = [];
  for (const blk of raw) {
    const last = merged[merged.length - 1];
    if (last && blk.oldStart - last.oldEnd <= opts.mergeGap) {
      last.oldEnd = blk.oldEnd;
      last.newEnd = blk.newEnd;
    } else merged.push({ ...blk });
  }
  return merged.map((blk, index) => {
    const prevEnd = index > 0 ? merged[index - 1].oldEnd : 0;
    const nextStart = index + 1 < merged.length ? merged[index + 1].oldStart : a.length;
    const oldLines = a.slice(blk.oldStart, blk.oldEnd);
    const newLines = b.slice(blk.newStart, blk.newEnd);
    return {
      id: hunkId(path, blk.oldStart, oldLines, newLines),
      index,
      state: 'proposed' as const,
      oldStart: blk.oldStart,
      oldEnd: blk.oldEnd,
      newStart: blk.newStart,
      newEnd: blk.newEnd,
      oldLines,
      newLines,
      // Context is clamped so it never overlaps a neighbouring hunk's changed region.
      contextBefore: a.slice(Math.max(prevEnd, blk.oldStart - opts.contextLines), blk.oldStart),
      contextAfter: a.slice(blk.oldEnd, Math.min(nextStart, blk.oldEnd + opts.contextLines))
    };
  });
}

/** Rebuild file content from base lines with only the given hunks applied. */
export function applyHunks(baseLines: string[], hunks: Hunk[]): string {
  const sorted = [...hunks].sort((x, y) => x.oldStart - y.oldStart);
  const parts: string[] = [];
  let pos = 0;
  for (const h of sorted) {
    for (let i = pos; i < h.oldStart; i++) parts.push(baseLines[i]);
    for (const l of h.newLines) parts.push(l);
    pos = h.oldEnd;
  }
  for (let i = pos; i < baseLines.length; i++) parts.push(baseLines[i]);
  return parts.join('');
}

const stripEol = (l: string) => l.replace(/\r?\n$/, '');
const hasEol = (l: string) => l.endsWith('\n');

export function hunkCounts(h: Hunk): { oldCount: number; newCount: number } {
  const ctx = h.contextBefore.length + h.contextAfter.length;
  return { oldCount: ctx + h.oldLines.length, newCount: ctx + h.newLines.length };
}

export function renderHunk(h: Hunk): HunkView {
  const lines: DiffLine[] = [];
  let o = h.oldStart - h.contextBefore.length + 1;
  let n = h.newStart - h.contextBefore.length + 1;
  const flag = (l: string) => (hasEol(l) ? {} : { noNewlineAtEof: true });
  for (const l of h.contextBefore) lines.push({ type: 'context', text: stripEol(l), oldLine: o++, newLine: n++, ...flag(l) });
  for (const l of h.oldLines) lines.push({ type: 'remove', text: stripEol(l), oldLine: o++, ...flag(l) });
  for (const l of h.newLines) lines.push({ type: 'add', text: stripEol(l), newLine: n++, ...flag(l) });
  for (const l of h.contextAfter) lines.push({ type: 'context', text: stripEol(l), oldLine: o++, newLine: n++, ...flag(l) });
  const { oldCount, newCount } = hunkCounts(h);
  const oldStart = oldCount === 0 ? 0 : h.oldStart - h.contextBefore.length + 1;
  const newStart = newCount === 0 ? 0 : h.newStart - h.contextBefore.length + 1;
  return {
    id: h.id,
    index: h.index,
    state: h.state,
    header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    oldStart,
    oldCount,
    newStart,
    newCount,
    added: h.newLines.length,
    removed: h.oldLines.length,
    lines
  };
}

/** Standard unified diff for a chosen subset of hunks (usable with `git apply`). */
export function formatUnified(
  relPath: string,
  hunks: Hunk[],
  kind: 'modify' | 'create' | 'delete' = 'modify'
): string {
  const sorted = [...hunks].sort((x, y) => x.oldStart - y.oldStart);
  if (sorted.length === 0) return '';
  const out = [`--- ${kind === 'create' ? '/dev/null' : `a/${relPath}`}`, `+++ ${kind === 'delete' ? '/dev/null' : `b/${relPath}`}`];
  let delta = 0;
  const emit = (prefix: string, l: string) => {
    if (hasEol(l)) out.push(prefix + l.slice(0, -1));
    else {
      out.push(prefix + l);
      out.push('\\ No newline at end of file');
    }
  };
  for (const h of sorted) {
    const { oldCount, newCount } = hunkCounts(h);
    const base = h.oldStart - h.contextBefore.length;
    const oldStart = oldCount === 0 ? 0 : base + 1;
    const newStart = newCount === 0 ? 0 : base + 1 + delta;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const l of h.contextBefore) emit(' ', l);
    for (const l of h.oldLines) emit('-', l);
    for (const l of h.newLines) emit('+', l);
    for (const l of h.contextAfter) emit(' ', l);
    delta += h.newLines.length - h.oldLines.length;
  }
  return out.join('\n') + '\n';
}

/** Convenience: full unified diff between two strings. */
export function unifiedDiffText(
  relPath: string,
  before: string,
  after: string,
  opts: Partial<DiffOptions> = {}
): string {
  const ctx = opts.contextLines ?? 3;
  const hunks = computeHunks(relPath, splitLines(before), splitLines(after), {
    contextLines: ctx,
    mergeGap: opts.mergeGap ?? ctx * 2
  });
  return formatUnified(relPath, hunks);
}
