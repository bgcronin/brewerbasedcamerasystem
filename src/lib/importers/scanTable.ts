/**
 * Rebuilds the table printed on a clinic list.
 *
 * A page arrives as positioned pieces of text (PDF text items, or the words
 * OCR found, each with its box). Rows come from the pieces that share a line;
 * columns come from the vertical gutters that run down the whole page, so a
 * value is always read from its own column and never guessed from the words
 * around it. Where a page has no usable gutters (a ragged photo, or text with
 * no positions) the lines are laid out by the order of their dates, times and
 * numbers instead, with the same rule: one value per cell, nothing bridging
 * two cells.
 *
 * Nothing is thrown away quietly. A line that is not a row is either the
 * heading, or listed in `notUsed`, or kept as an unread row for the user.
 */
import { parseDate } from '../dates';
import { looksLikeHeader } from './mapping';
import {
  dominantMrnShape,
  doubtfulMrn,
  findAnchors,
  isDamagedDate,
  isDateCell,
  isFurniture,
  isMrnCell,
  isPhoneLike,
  isRecentDate,
  isRuleOnly,
  isSexCell,
  isTimeCell,
  mrnShape,
  repairMrn,
  type MrnPattern,
} from './shapes';

export interface Box {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** OCR confidence, 0–100. Absent for PDF text. */
  conf?: number;
}

export interface PageInput {
  page: number;
  ocr: boolean;
  /** Positioned text. */
  boxes?: Box[];
  /** Slope of the text lines (dy/dx), from OCR baselines, for a photo taken at a slight angle. */
  skew?: number;
  /** Plain lines, when positions are not known. */
  lines?: { text: string; conf?: number }[];
}

export type ColKind = 'time' | 'mrn' | 'date' | 'sex' | 'phone' | 'text' | 'empty';

/** Something the reader was unsure of. `col` ties it to one cell; without it, it is about the whole row. */
export interface ReadIssue {
  col?: number;
  reason: string;
  /** Text from a second printed line was joined on: worth a look only when it lands in a name. */
  joined?: boolean;
}

export interface ScanRow {
  cells: string[];
  /** Lowest OCR confidence among the words of each cell. */
  conf: (number | undefined)[];
  /** The line as printed. */
  source: string;
  page: number;
  issues: ReadIssue[];
  /** The line looked like part of the table but could not be laid out. */
  unread?: boolean;
}

export interface PageTable {
  page: number;
  mode: 'grid' | 'lines';
  kinds: ColKind[];
  header: string[] | null;
  rows: ScanRow[];
  notUsed: string[];
}

const median = (nums: number[]): number => {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const UNREAD = 'This line couldn’t be laid out like the rest of the list';
const hasDigit = (s: string) => /\d/.test(s);

/* ───────────────────────── lines from boxes ───────────────────────── */

interface Seg {
  text: string;
  x0: number;
  x1: number;
  conf?: number;
  /** Reading order within the row (a row can be made of two printed lines). */
  order: number;
}

interface Line {
  segs: Seg[];
  y: number;
  h: number;
  text: string;
}

/** A PDF item that holds several columns ("09:00   H100234   SMITH") is cut at its wide gaps. */
function splitWide(b: Box): Box[] {
  if (!/\t| {2,}/.test(b.text.trim())) return [b];
  const out: Box[] = [];
  const per = (b.x1 - b.x0) / Math.max(1, b.text.length);
  for (const m of b.text.matchAll(/[^\t ]+(?: [^\t ]+)*/g)) {
    out.push({ ...b, text: m[0], x0: b.x0 + m.index * per, x1: b.x0 + (m.index + m[0].length) * per });
  }
  return out;
}

function buildLines(input: PageInput): { lines: Line[]; unit: number } {
  const skew = input.skew ?? 0;
  const boxes = (input.boxes ?? [])
    .filter((b) => b.text.trim())
    .flatMap(splitWide)
    .map((b) => {
      const cx = (b.x0 + b.x1) / 2;
      const shift = skew * cx;
      return { ...b, text: b.text.trim(), y0: b.y0 - shift, y1: b.y1 - shift };
    });
  if (!boxes.length) return { lines: [], unit: 10 };
  const solid = boxes.filter((b) => (b.text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 2);
  const unit = median((solid.length ? solid : boxes).map((b) => b.y1 - b.y0)) || 10;

  // Rows: boxes whose vertical centres agree. Tall boxes first, so a comma or a dash joins the line it sits on.
  const groups: { cy: number; h: number; boxes: Box[] }[] = [];
  for (const b of [...boxes].sort((a, c) => c.y1 - c.y0 - (a.y1 - a.y0))) {
    const cy = (b.y0 + b.y1) / 2;
    let best: (typeof groups)[number] | undefined;
    let bestD = Infinity;
    for (const g of groups) {
      const d = Math.abs(g.cy - cy);
      if (d <= 0.5 * Math.max(g.h, Math.min(b.y1 - b.y0, unit)) && d < bestD) {
        best = g;
        bestD = d;
      }
    }
    if (best) best.boxes.push(b);
    else groups.push({ cy, h: Math.min(b.y1 - b.y0, unit * 1.6), boxes: [b] });
  }
  groups.sort((a, b) => a.cy - b.cy);

  const lines = groups.map((g) => {
    g.boxes.sort((a, b) => a.x0 - b.x0);
    // Words closer than a wide space belong to one cell. A heading set in large type has wider spaces to match.
    const tall = Math.max(unit, median(g.boxes.map((b) => b.y1 - b.y0)));
    const segGap = tall * (input.ocr ? 0.6 : 0.75);
    const segs: Seg[] = [];
    for (const b of g.boxes) {
      const last = segs[segs.length - 1];
      const gap = last ? b.x0 - last.x1 : Infinity;
      if (last && gap < segGap) {
        last.text += (input.ocr || gap > unit * 0.12 ? ' ' : '') + b.text;
        last.x1 = Math.max(last.x1, b.x1);
        if (b.conf != null) last.conf = Math.min(last.conf ?? 100, b.conf);
      } else segs.push({ text: b.text, x0: b.x0, x1: b.x1, conf: b.conf, order: 0 });
    }
    return { segs, y: g.cy, h: g.h, text: segs.map((s) => s.text).join('   ') };
  });
  return { lines, unit };
}

/* ───────────────────────── shared: kinds, zones, loose lines ───────────────────────── */

function voteKind(cells: string[], ocr: boolean): ColKind {
  const vals = cells.map((c) => c.trim()).filter(Boolean);
  if (!vals.length) return 'empty';
  const share = (pred: (v: string) => boolean) => vals.filter(pred).length / vals.length;
  const need = vals.length >= 3 ? 0.6 : 1;
  if (share((v) => isDateCell(v) || (ocr && isDamagedDate(v))) >= need) return 'date';
  if (share(isTimeCell) >= need) return 'time';
  if (share(isSexCell) >= need) return 'sex';
  if (share(isPhoneLike) >= need) return 'phone';
  if (share((v) => isMrnCell(v) || (ocr && (!!repairMrn(v) || doubtfulMrn(v)) && (v.match(/\d/g) ?? []).length >= 3 && v.length <= 16 && !/\s/.test(v))) >= need) return 'mrn';
  return 'text';
}

function cellFits(kind: ColKind, cell: string, ocr: boolean): boolean {
  const v = cell.trim();
  if (!v) return false;
  if (kind === 'date') return isDateCell(v) || (ocr && isDamagedDate(v));
  if (kind === 'time') return isTimeCell(v);
  if (kind === 'mrn') return isMrnCell(v) || (ocr && (!!repairMrn(v) || doubtfulMrn(v)) && (v.match(/\d/g) ?? []).length >= 3 && v.length <= 16 && !/\s/.test(v));
  return false;
}

/** Does a line outside the table carry something that could be a patient's hospital number or date of birth? */
function carriesIdentity(text: string, ocr: boolean, pattern: MrnPattern | undefined): boolean {
  for (const a of findAnchors(text, ocr)) {
    if (a.kind === 'mrn' && !isPhoneLike(a.text) && (!pattern || mrnShape(a.text) === pattern.shape || mrnShape(repairMrn(a.text, pattern) ?? '') === pattern.shape)) return true;
    if (a.kind === 'date') {
      const iso = parseDate(a.text, 'DMY', true);
      if (iso && !isRecentDate(iso)) return true;
    }
  }
  return false;
}

function hasClockTime(text: string): boolean {
  return findAnchors(text).some((a) => a.kind === 'time');
}

const emptyRow = (n: number, source: string, page: number, reason = UNREAD): ScanRow => ({
  cells: Array.from({ length: n }, () => ''),
  conf: Array.from({ length: n }, () => undefined),
  source,
  page,
  issues: [{ reason }],
  unread: true,
});

/* ───────────────────────── grid: columns from gutters ───────────────────────── */

type Span = [number, number];

function gutters(cands: Line[], unit: number, ocr: boolean): Span[] {
  const n = cands.length;
  const tol = n >= 8 ? Math.floor(n * 0.12) : n >= 4 ? 1 : 0;
  const minW = unit * (ocr ? 0.8 : 0.9);
  const events: [number, number][] = [];
  for (const l of cands) for (const s of l.segs) events.push([s.x0, 1], [s.x1, -1]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const free: Span[] = [];
  let cover = 0;
  let start: number | null = null;
  let seen = false;
  for (const [x, d] of events) {
    const before = cover;
    cover += d;
    if (before > tol && cover <= tol) start = x;
    else if (cover > tol) {
      if (seen && start !== null && x - start >= minW) free.push([start, x]);
      start = null;
      seen = true;
    }
  }
  return free;
}

interface Grid {
  spans: Span[];
  unit: number;
}

/** Which column each piece of a line falls in. `crossing` when one piece runs over a gutter into the next column. */
function layOut(line: Line, grid: Grid): { cells: string[]; conf: (number | undefined)[]; crossing: boolean; stray: string[] } {
  const k = grid.spans.length;
  const parts: Seg[][] = Array.from({ length: k }, () => []);
  const stray: string[] = [];
  let crossing = false;
  for (const s of line.segs) {
    const overlaps = grid.spans.map(([a, b]) => Math.max(0, Math.min(b, s.x1) - Math.max(a, s.x0)));
    const hit = overlaps.filter((o) => o > grid.unit * 0.35).length;
    if (hit >= 2) crossing = true;
    let best = 0;
    for (let i = 1; i < k; i++) if (overlaps[i] > overlaps[best]) best = i;
    if (overlaps[best] <= 0) {
      // Sitting in a gutter: a remnant of a ruling line, or something that belongs to no column.
      if (!/^[|Il!\[\]_\-–—.:·•*]{1,2}$/.test(s.text)) stray.push(s.text);
      continue;
    }
    parts[best].push(s);
  }
  const cells = parts.map((p) => p.sort((a, b) => a.order - b.order || a.x0 - b.x0).map((s) => s.text).join(' '));
  const conf = parts.map((p) => (p.some((s) => s.conf != null) ? Math.min(...p.map((s) => s.conf ?? 100)) : undefined));
  return { cells, conf, crossing, stray };
}

function readGrid(input: PageInput, lines: Line[], unit: number, reuse?: Grid): { table: PageTable; grid: Grid } | undefined {
  const ocr = input.ocr;
  const anchorCount = (l: Line) => findAnchors(l.text, ocr).length;
  // Lines to find the columns from: laid out in several pieces, with at least two dates, times or numbers, and not page furniture.
  const cands = lines.filter((l) => l.segs.length >= 3 && anchorCount(l) >= 2 && !isFurniture(l.text));
  let grid: Grid | undefined;
  if (cands.length >= 3) {
    const free = gutters(cands, unit, ocr);
    const minX = Math.min(...cands.flatMap((l) => l.segs.map((s) => s.x0)));
    const maxX = Math.max(...cands.flatMap((l) => l.segs.map((s) => s.x1)));
    const spans: Span[] = [];
    let left = minX - unit;
    for (const [a, b] of free) {
      spans.push([left, a]);
      left = b;
    }
    spans.push([left, maxX + unit]);
    if (spans.length >= 3) grid = { spans, unit };
  }
  if (!grid && reuse && cands.length) grid = reuse;
  if (!grid) return undefined;

  const laid = new Map<Line, ReturnType<typeof layOut>>();
  for (const l of lines) laid.set(l, layOut(l, grid));
  const aligned = cands.filter((l) => !laid.get(l)!.crossing);
  if (aligned.length < Math.max(1, Math.ceil(cands.length * 0.7))) return undefined;

  const k = grid.spans.length;
  const kinds: ColKind[] = Array.from({ length: k }, (_, c) => voteKind(aligned.map((l) => laid.get(l)!.cells[c]), ocr));
  const anchorCols = kinds.map((kd, c) => (kd === 'date' || kd === 'time' || kd === 'mrn' ? c : -1)).filter((c) => c >= 0);
  if (!anchorCols.length) return undefined;
  const need = Math.min(2, anchorCols.length);
  const isBody = (l: Line) => {
    const lo = laid.get(l)!;
    return !lo.crossing && anchorCols.filter((c) => cellFits(kinds[c], lo.cells[c], ocr)).length >= need;
  };
  const bodyFlags = lines.map(isBody);
  if (bodyFlags.filter(Boolean).length < Math.max(1, Math.ceil(cands.length * 0.6))) return undefined;

  // The heading row: words, no numbers, sitting in the columns. Take the one nearest above the first patient.
  const firstBody = bodyFlags.indexOf(true);
  const lastBody = bodyFlags.lastIndexOf(true);
  const headingLike = (l: Line, i: number) => {
    if (bodyFlags[i] || hasDigit(l.text)) return false;
    const lo = laid.get(l)!;
    const cells = (lo.crossing ? l.segs.map((s) => s.text) : lo.cells).filter(Boolean);
    return cells.length >= 2 && looksLikeHeader(cells);
  };
  let headingIndex = -1;
  for (let i = firstBody - 1; i >= 0 && headingIndex < 0; i--) if (headingLike(lines[i], i) && !laid.get(lines[i])!.crossing) headingIndex = i;
  const header: string[] | null = headingIndex >= 0 ? [...laid.get(lines[headingIndex])!.cells] : null;
  const sameAsHeader = (l: Line) => !!header && laid.get(l)!.cells.join('|').toLowerCase() === header.join('|').toLowerCase();
  const headingAt = new Set<number>();
  lines.forEach((l, i) => {
    if (i === headingIndex || (headingIndex >= 0 && !bodyFlags[i] && sameAsHeader(l))) headingAt.add(i);
  });

  const zoneStart = headingIndex >= 0 ? headingIndex : firstBody;
  const pattern = dominantMrnShape(lines.filter((_, i) => bodyFlags[i]).flatMap((l) => anchorCols.filter((c) => kinds[c] === 'mrn').slice(0, 1).map((c) => laid.get(l)!.cells[c])));
  const pitch = median(lines.slice(1).map((l, i) => l.y - lines[i].y).filter((_, i) => bodyFlags[i] && bodyFlags[i + 1])) || unit * 2;

  const rows: ScanRow[] = [];
  const notUsed: string[] = [];
  let overflow = false;
  const extra = new Map<ScanRow, string[]>();
  let prev: { row: ScanRow; y: number } | undefined;
  lines.forEach((l, i) => {
    if (isRuleOnly(l.text) || headingAt.has(i)) return;
    const lo = laid.get(l)!;
    if (bodyFlags[i]) {
      const row: ScanRow = { cells: lo.cells, conf: lo.conf, source: l.text, page: input.page, issues: [] };
      if (lo.stray.length) {
        extra.set(row, lo.stray);
        overflow = true;
      }
      rows.push(row);
      prev = { row, y: l.y };
      return;
    }
    const inBody = i > zoneStart && i < lastBody;
    // A second printed line of the row above: text only, each piece inside one column, close underneath.
    const continues = prev && !lo.crossing && !findAnchors(l.text, ocr).length && l.y - prev.y <= pitch * 1.15 && lo.cells.every((c, ci) => !c || kinds[ci] === 'text' || kinds[ci] === 'empty');
    if (continues && prev && (inBody || i === lastBody + 1)) {
      lo.cells.forEach((c, ci) => {
        if (!c) return;
        const had = prev!.row.cells[ci];
        prev!.row.cells[ci] = had ? `${had} ${c}` : c;
        prev!.row.issues.push({ col: ci, reason: `“${c}” was printed on the line below and has been joined on`, joined: true });
      });
      prev.row.source += ' / ' + l.text;
      prev.y = l.y;
      return;
    }
    const identity = carriesIdentity(l.text, ocr, pattern);
    const furniture = isFurniture(l.text) && !identity && !(inBody && hasClockTime(l.text));
    if (!furniture && (inBody || identity)) {
      const row: ScanRow = lo.crossing
        ? emptyRow(k, l.text, input.page, 'Some of this line runs across two columns, so it couldn’t be split up')
        : { cells: lo.cells, conf: lo.conf, source: l.text, page: input.page, issues: [{ reason: UNREAD }], unread: true };
      rows.push(row);
      prev = undefined;
      return;
    }
    notUsed.push(l.text);
  });

  if (overflow) {
    kinds.push('text');
    if (header) header.push('Other');
    for (const r of rows) {
      r.cells.push((extra.get(r) ?? []).join(' '));
      r.conf.push(undefined);
    }
  }
  return { table: { page: input.page, mode: 'grid', kinds, header, rows, notUsed }, grid };
}

/* ───────────────────────── lines: columns from the order of dates, times and numbers ───────────────────────── */

interface Item {
  kind: 'time' | 'date' | 'mrn' | 'sex' | 'text';
  text: string;
}

function itemsOf(text: string, ocr: boolean, sexAfterDate: boolean): Item[] {
  const items: Item[] = [];
  const cells = text.split(/\t+| {2,}|\s[|¦]\s/).map((c) => c.trim()).filter(Boolean);
  for (const cell of cells) {
    // A cell that is nothing but a time ("9.30", "09:30-09:45") is one, though the same digits inside a sentence may not be.
    if (isTimeCell(cell)) {
      items.push({ kind: 'time', text: cell });
      continue;
    }
    const anchors = findAnchors(cell, ocr);
    let at = 0;
    const pushText = (raw: string, wholeCell: boolean) => {
      let t = raw.replace(/^[\s:;,|]+|[\s:;|]+$/g, '');
      if (!t) return;
      const prevKind = items[items.length - 1]?.kind;
      if (isSexCell(t) && (wholeCell || prevKind === 'date' || prevKind === 'mrn')) {
        items.push({ kind: 'sex', text: t });
        return;
      }
      const lead = t.match(/^([MF])\s+(\S.*)$/);
      if (lead && sexAfterDate && prevKind === 'date') {
        items.push({ kind: 'sex', text: lead[1] });
        t = lead[2];
      }
      items.push({ kind: 'text', text: t });
    };
    for (const a of anchors) {
      pushText(cell.slice(at, a.start), false);
      items.push({ kind: a.kind, text: a.text });
      at = a.end;
    }
    pushText(cell.slice(at), anchors.length === 0);
  }
  return items;
}

const sigOf = (items: Item[]) => items.filter((i) => i.kind !== 'text').map((i) => i.kind[0]).join('');

/** All the ways `sig` can be read as `dom` with some anchors missing. */
function embeddings(sig: string, dom: string, limit = 2): number[][] {
  const out: number[][] = [];
  const walk = (si: number, di: number, acc: number[]) => {
    if (out.length >= limit) return;
    if (si === sig.length) {
      out.push(acc);
      return;
    }
    for (let d = di; d < dom.length; d++) if (dom[d] === sig[si]) walk(si + 1, d + 1, [...acc, d]);
  };
  walk(0, 0, []);
  return out;
}

function readLines(input: PageInput, texts: { text: string; conf?: number }[]): PageTable {
  const ocr = input.ocr;
  const clean = texts.map((t) => ({ ...t, text: t.text.replace(/\s+$/, '') })).filter((t) => t.text.trim());

  // Is there a lone M or F after the date on most lines? Then it is the sex column, even when single-spaced.
  const probe = clean.map((t) => itemsOf(t.text, ocr, false));
  const withDate = probe.filter((it) => it.some((i) => i.kind === 'date'));
  const sexAfter = withDate.filter((it) => it.some((i, n) => n > 0 && it[n - 1].kind === 'date' && (i.kind === 'sex' || (i.kind === 'text' && /^[MF]\s/.test(i.text))))).length;
  const sexAfterDate = withDate.length >= 2 && sexAfter / withDate.length >= 0.7;

  let parsed = clean.map((t) => ({ ...t, items: itemsOf(t.text, ocr, sexAfterDate) }));
  const anchorsIn = (items: Item[]) => items.filter((i) => i.kind === 'time' || i.kind === 'date' || i.kind === 'mrn').length;

  // Records printed over two lines (name above its numbers, or the date of birth underneath): join each pair.
  const isCand = parsed.map((p) => anchorsIn(p.items) >= 2);
  const n = isCand.filter(Boolean).length;
  if (n >= 2) {
    const first = isCand.indexOf(true);
    const last = isCand.lastIndexOf(true);
    const loose = (i: number) => i >= 0 && i < parsed.length && !isCand[i] && !isRuleOnly(parsed[i].text) && !looksLikeHeader(parsed[i].text.split(/\t+| {2,}/).map((c) => c.trim()).filter(Boolean)) && !isFurniture(parsed[i].text);
    const before = parsed.filter((_, i) => isCand[i] && loose(i - 1) && (i - 2 < 0 || isCand[i - 2] || i - 1 < first)).length;
    const after = parsed.filter((_, i) => isCand[i] && loose(i + 1) && (i + 2 >= parsed.length || isCand[i + 2] || i + 1 > last)).length;
    const between = parsed.filter((_, i) => i > first && i < last && loose(i)).length;
    const join = (dir: -1 | 1) => {
      const out: typeof parsed = [];
      const used = new Set<number>();
      parsed.forEach((p, i) => {
        if (used.has(i)) return;
        if (isCand[i] && loose(i + dir) && !used.has(i + dir)) {
          used.add(i + dir);
          const text = dir < 0 ? `${parsed[i + dir].text}   ${p.text}` : `${p.text}   ${parsed[i + dir].text}`;
          if (dir < 0) out.pop();
          out.push({ text, conf: Math.min(p.conf ?? 100, parsed[i + dir].conf ?? 100), items: itemsOf(text, ocr, sexAfterDate) });
        } else out.push(p);
      });
      return out;
    };
    if (before >= Math.ceil(n * 0.8) && between <= before && between >= before - 1) parsed = join(-1);
    else if (after >= Math.ceil(n * 0.8) && between <= after && between >= after - 1) parsed = join(1);
  }

  const cand = parsed.map((p) => anchorsIn(p.items) >= 2);
  const sigs = new Map<string, number>();
  parsed.forEach((p, i) => cand[i] && sigs.set(sigOf(p.items), (sigs.get(sigOf(p.items)) ?? 0) + 1));
  const total = cand.filter(Boolean).length;
  const ranked = [...sigs.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  const notUsed: string[] = [];
  if (!total) {
    return { page: input.page, mode: 'lines', kinds: [], header: null, rows: [], notUsed: parsed.filter((p) => !isRuleOnly(p.text)).map((p) => p.text) };
  }
  // The layout most lines share. A longer layout wins a tie, so a line missing a value is the odd one out.
  let dom = ranked[0][0];
  for (const [s, c] of ranked) if (c === ranked[0][1] && s.length > dom.length) dom = s;

  // Text cells between anchors: gap g sits before anchor g (the last gap follows the last anchor).
  const gapsOf = (items: Item[], slots: number[]): string[][] => {
    const gaps: string[][] = Array.from({ length: dom.length + 1 }, () => []);
    let ai = 0;
    for (const it of items) {
      if (it.kind === 'text') gaps[ai < slots.length ? slots[ai] : dom.length].push(it.text);
      else ai++;
    }
    return gaps;
  };
  const matching = parsed.filter((p, i) => cand[i] && sigOf(p.items) === dom);
  const identity = Array.from({ length: dom.length }, (_, i) => i);
  const sub = Array.from({ length: dom.length + 1 }, (_, g) => {
    const counts = matching.map((p) => gapsOf(p.items, identity)[g].length);
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    const mode = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
    if (mode > 0) return mode;
    return counts.filter((c) => c > 0).length >= Math.max(1, matching.length * 0.15) ? 1 : 0;
  });
  // Column positions: gap 0 columns, anchor 0, gap 1 columns, anchor 1, …, last gap, then one for anything left over.
  const gapStart: number[] = [];
  const anchorCol: number[] = [];
  let col = 0;
  for (let g = 0; g <= dom.length; g++) {
    gapStart.push(col);
    col += sub[g];
    if (g < dom.length) anchorCol.push(col++);
  }
  const otherCol = col;
  const width = col + 1;

  const place = (p: (typeof parsed)[number], slots: number[], page: number): ScanRow => {
    const cells = Array.from({ length: width }, () => '');
    const issues: ReadIssue[] = [];
    const anchors = p.items.filter((i) => i.kind !== 'text');
    anchors.forEach((a, i) => {
      if (i < slots.length) cells[anchorCol[slots[i]]] = a.text;
      else cells[otherCol] = [cells[otherCol], a.text].filter(Boolean).join(' ');
    });
    const gaps = gapsOf(p.items, slots);
    gaps.forEach((texts, g) => {
      if (!texts.length) return;
      if (sub[g] === 0) {
        cells[otherCol] = [cells[otherCol], ...texts].filter(Boolean).join(' ');
        issues.push({ col: otherCol, reason: `“${texts.join(' ')}” is where the other lines have nothing` });
        return;
      }
      if (sub[g] >= 2 && texts.length !== sub[g]) issues.push({ reason: 'This line has a different number of columns from the others' });
      texts.forEach((t, i) => {
        const c = gapStart[g] + Math.min(i, sub[g] - 1);
        cells[c] = cells[c] ? `${cells[c]} ${t}` : t;
      });
    });
    return { cells, conf: cells.map((c) => (c && p.conf != null ? p.conf : undefined)), source: p.text, page, issues };
  };

  const mrnAt = [...dom].findIndex((ch) => ch === 'm');
  const pattern = mrnAt >= 0 ? dominantMrnShape(matching.map((p) => place(p, identity, input.page).cells[anchorCol[mrnAt]])) : undefined;
  // A line is a row when its dates, times and numbers come in the list's order, with none left over.
  // "Printed 08:02 11/11/2026" has a time and a date in order too, but it is the page's footer.
  const fit = parsed.map((p, i) => {
    if (!cand[i]) return null;
    const sig = sigOf(p.items);
    if (sig === dom) return identity;
    if (isFurniture(p.text) && !carriesIdentity(p.text, ocr, pattern)) return null;
    const ways = embeddings(sig, dom);
    return ways.length === 1 ? ways[0] : null;
  });
  const rows: ScanRow[] = [];
  const firstRow = fit.findIndex((f) => f);
  const lastRow = fit.length - 1 - [...fit].reverse().findIndex((f) => f);
  let header: string[] | null = null;
  let prevRow: ScanRow | undefined;
  parsed.forEach((p, i) => {
    if (isRuleOnly(p.text)) return;
    const slots = fit[i];
    if (slots) {
      prevRow = place(p, slots, input.page);
      rows.push(prevRow);
      return;
    }
    const cells = p.text.split(/\t+| {2,}|\s[|¦]\s/).map((c) => c.trim()).filter(Boolean);
    if (!hasDigit(p.text) && cells.length >= 2 && looksLikeHeader(cells)) {
      if (!header && i < firstRow && cells.length === width - 1) header = [...cells, 'Other'];
      else if (!(i < firstRow) && !header) notUsed.push(p.text);
      return;
    }
    const inBody = i > firstRow && i < lastRow;
    const identityHere = carriesIdentity(p.text, ocr, pattern);
    const furniture = isFurniture(p.text) && !identityHere && !(inBody && hasClockTime(p.text));
    if (furniture || (!inBody && !identityHere)) {
      notUsed.push(p.text);
      return;
    }
    if (inBody && prevRow && !anchorsIn(p.items)) {
      // A second printed line, but with no positions there is no telling which column it continues.
      prevRow.cells[otherCol] = [prevRow.cells[otherCol], p.text.trim()].filter(Boolean).join(' ');
      prevRow.issues.push({ reason: `The next line on the page, “${p.text.trim()}”, may belong to this row` });
      prevRow.source += ' / ' + p.text.trim();
      return;
    }
    // Looks like part of the list, but its dates and numbers do not come in the order the others have.
    const sig = sigOf(p.items);
    const greedy = embeddings(sig, dom)[0] ?? embeddings([...sig].filter((ch, n, all) => dom.includes(ch) && all.indexOf(ch) === n).join(''), dom)[0] ?? [];
    const row = sig ? place(p, greedy, input.page) : emptyRow(width, p.text, input.page);
    row.issues = [{ reason: cand[i] ? 'This line has more dates or numbers than the others, so the values may be in the wrong columns' : UNREAD }];
    row.unread = true;
    rows.push(row);
    prevRow = undefined;
  });

  // Text where the other lines have none is often a piece broken off a neighbouring value ("H1 00877").
  const laidOut = rows.filter((r) => !r.unread);
  if (laidOut.length >= 3) {
    // Only between the anchors: after the last one, notes on a few lines are ordinary.
    for (let g = 0; g < dom.length; g++) {
      for (let c = gapStart[g]; c < gapStart[g] + sub[g]; c++) {
        const filled = laidOut.filter((r) => r.cells[c]);
        if (filled.length && filled.length < laidOut.length * 0.5) for (const r of filled) r.issues.push({ col: c, reason: `“${r.cells[c]}” is where the other lines have nothing` });
      }
    }
  }
  const kinds: ColKind[] = Array.from({ length: width }, (_, c) => voteKind(rows.filter((r) => !r.unread).map((r) => r.cells[c]), ocr));
  // Drop the left-over column when nothing landed in it.
  if (rows.every((r) => !r.cells[otherCol])) {
    kinds.pop();
    for (const r of rows) {
      r.cells.pop();
      r.conf.pop();
    }
    if (header) (header as string[]).pop();
  }
  return { page: input.page, mode: 'lines', kinds, header, rows, notUsed };
}

/* ───────────────────────── one page, then all pages ───────────────────────── */

/** Two lists printed side by side: the same run of columns twice. Split each line into its two patients. */
function splitSideBySide(t: PageTable): PageTable {
  const k = t.kinds.length;
  const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '');
  for (let p = 3; p <= k / 2; p++) {
    if (2 * p !== k && !(2 * p === k - 1 && t.kinds[k - 1] === 'text')) continue;
    const left = t.kinds.slice(0, p);
    const right = t.kinds.slice(p, 2 * p);
    const anchors = left.filter((x) => x === 'mrn' || x === 'date').length;
    if (!anchors || !left.includes('text')) continue;
    if (!left.every((kd, i) => kd === right[i] || kd === 'empty' || right[i] === 'empty')) continue;
    if (t.header && !t.header.slice(0, p).every((h, i) => norm(h) === norm(t.header![p + i] ?? ''))) continue;
    const half = (r: ScanRow, from: number): ScanRow => ({ ...r, cells: r.cells.slice(from, from + p), conf: r.conf.slice(from, from + p), issues: r.issues.filter((i) => i.col == null) });
    const a = t.rows.map((r) => half(r, 0)).filter((r) => r.cells.some(Boolean));
    const b = t.rows.map((r) => half(r, p)).filter((r) => r.cells.some(Boolean));
    return { ...t, kinds: left, header: t.header ? t.header.slice(0, p) : null, rows: [...a, ...b] };
  }
  const count = (kd: ColKind) => t.kinds.filter((x) => x === kd).length;
  if (count('mrn') >= 2 && count('date') >= 2 && count('time') >= 2) {
    for (const r of t.rows) r.issues.push({ reason: 'There may be two patients on this line: the page seems to hold two lists side by side' });
  }
  return t;
}

function readPage(input: PageInput, reuse?: Grid): { table: PageTable; grid?: Grid } {
  if (input.boxes?.length) {
    const { lines, unit } = buildLines(input);
    const g = readGrid(input, lines, unit, reuse);
    if (g) return { table: splitSideBySide(g.table), grid: g.grid };
    return { table: splitSideBySide(readLines(input, lines.map((l) => ({ text: l.text, conf: l.segs.some((s) => s.conf != null) ? Math.min(...l.segs.map((s) => s.conf ?? 100)) : undefined })))) };
  }
  return { table: splitSideBySide(readLines(input, input.lines ?? [])) };
}

export interface ScanTable {
  kinds: ColKind[];
  header: string[] | null;
  rows: ScanRow[];
  notUsed: string[];
  /** Rows found on each page that was given, for deciding whether a page needs another attempt. */
  rowsPerPage: Map<number, number>;
  usedLineReading: boolean;
}

/** Read every page and put the rows into one table, lining later pages up with the first by what each column holds. */
export function buildScanTable(pages: PageInput[]): ScanTable {
  const tables: PageTable[] = [];
  let grid: Grid | undefined;
  for (const p of pages) {
    const r = readPage(p, p.ocr ? undefined : grid);
    if (r.grid && !p.ocr) grid = r.grid;
    tables.push(r.table);
  }
  const rowsPerPage = new Map(tables.map((t) => [t.page, t.rows.filter((r) => !r.unread).length]));
  const withRows = tables.filter((t) => t.rows.length);
  const notUsed = tables.flatMap((t) => t.notUsed);
  if (!withRows.length) return { kinds: [], header: null, rows: [], notUsed, rowsPerPage, usedLineReading: false };
  const master = [...withRows].sort((a, b) => b.rows.length - a.rows.length)[0];
  const k = master.kinds.length;
  const rows: ScanRow[] = [];
  for (const t of tables) {
    if (!t.rows.length) continue;
    const same = t === master || (t.kinds.length === k && t.kinds.every((kd, i) => kd === master.kinds[i] || kd === 'empty' || master.kinds[i] === 'empty' || (kd === 'text' && master.kinds[i] === 'text')));
    if (same) {
      rows.push(...t.rows);
      continue;
    }
    // Laid out differently: match columns by what they hold, in order, and say so on every row.
    const taken = new Set<number>();
    const to = t.kinds.map((kd) => {
      const i = master.kinds.findIndex((m, mi) => m === kd && !taken.has(mi));
      if (i >= 0) taken.add(i);
      return i;
    });
    for (const r of t.rows) {
      const cells = Array.from({ length: k }, () => '');
      const conf: (number | undefined)[] = Array.from({ length: k }, () => undefined);
      const lost: string[] = [];
      r.cells.forEach((c, i) => {
        if (to[i] >= 0) {
          cells[to[i]] = c;
          conf[to[i]] = r.conf[i];
        } else if (c) lost.push(c);
      });
      rows.push({
        ...r,
        cells,
        conf,
        issues: [{ reason: `Page ${t.page} is laid out differently from the rest${lost.length ? `; “${lost.join(' ')}” had no column to go in` : ''}` }],
      });
    }
  }
  return { kinds: master.kinds, header: master.header, rows, notUsed, rowsPerPage, usedLineReading: tables.some((t) => t.mode === 'lines' && t.rows.length > 0) };
}
