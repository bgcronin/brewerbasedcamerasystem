/**
 * The one-page summary for a letter or the notes: who, when, and the
 * photographs with their eye, illumination and any note. It is drawn on a
 * canvas, so every name prints correctly whatever its alphabet, and then
 * wrapped as a PDF (see pdf.ts).
 */
import { ageFromDOB, formatClock, formatLongDate, formatShortDate } from './dates';
import { addDiagnosis } from './diagnoses';
import { displayName } from './names';
import { techniqueLabel, type Capture, type Patient } from './types';

/** Pixels per point: the page is drawn at 200 dots per inch, sharp in print without being a large file. */
export const SUMMARY_SCALE = 200 / 72;
/** Rows of photographs per page (two to a row). A visit with more runs on to further pages. */
export const SUMMARY_ROWS_PER_PAGE = 3;

const FONT = "'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const INK = '#0e1726';
const SLATE = '#515d75';
const LINE = '#d5dbe4';

export interface SummaryPhoto {
  capture: Pick<Capture, 'eye' | 'technique' | 'takenAt' | 'note' | 'diagnoses'>;
  /** The photograph, with any marks already drawn in. */
  image: CanvasImageSource;
  width: number;
  height: number;
}

export interface SummaryPageInput {
  clinicName: string;
  patient: Pick<Patient, 'firstName' | 'lastName' | 'mrn' | 'dob'>;
  /** ISO date of the visit. */
  visitDate: string;
  /** The places on the page, row by row, two to a row; null leaves a place empty. A single cell fills the width. */
  cells: (SummaryPhoto | null)[];
  /** Page size in points. */
  pageWidth: number;
  pageHeight: number;
  printedAt: Date;
  /** "2 of 3" when the visit runs over several pages. */
  pageLabel?: string;
}

const EYE_NAME = { OD: 'Right eye (OD)', OS: 'Left eye (OS)', OU: 'Both eyes (OU)' } as const;
const EYE_ORDER = { OD: 0, OS: 1, OU: 2 } as const;

/**
 * Lay the photographs out in rows of two. When the visit has both eyes the page reads like a
 * chart: right eye down the left column, left eye down the right, each in the order taken, with
 * a gap where one eye has fewer photographs. Otherwise they simply run in order.
 */
export function summaryRows<T extends { capture: Pick<Capture, 'eye' | 'takenAt'> }>(photos: T[]): (T | null)[][] {
  const ordered = [...photos].sort((a, b) => EYE_ORDER[a.capture.eye] - EYE_ORDER[b.capture.eye] || a.capture.takenAt - b.capture.takenAt);
  const od = ordered.filter((p) => p.capture.eye === 'OD');
  const os = ordered.filter((p) => p.capture.eye === 'OS');
  const rows: (T | null)[][] = [];
  let rest = ordered;
  if (od.length && os.length) {
    for (let r = 0; r < Math.max(od.length, os.length); r++) rows.push([od[r] ?? null, os[r] ?? null]);
    rest = ordered.filter((p) => p.capture.eye === 'OU');
  }
  for (let i = 0; i < rest.length; i += 2) rows.push([rest[i], rest[i + 1] ?? null]);
  return rows;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Cut text to a width, ending with an ellipsis if it had to be shortened. */
function fit(ctx: Ctx, s: string, max: number): string {
  if (ctx.measureText(s).width <= max) return s;
  let cut = s;
  while (cut.length > 1 && ctx.measureText(cut + '…').width > max) cut = cut.slice(0, -1);
  return cut.trimEnd() + '…';
}

/** Break text into lines of at most `max` pixels; anything beyond `lines` is cut with an ellipsis. */
function wrap(ctx: Ctx, s: string, max: number, lines: number): string[] {
  const out: string[] = [];
  let line = '';
  const words = s.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(next).width <= max || !line) {
      line = next;
      continue;
    }
    if (out.length === lines - 1) {
      out.push(fit(ctx, `${line} ${words.slice(i).join(' ')}`, max));
      return out;
    }
    out.push(line);
    line = words[i];
  }
  if (line) out.push(fit(ctx, line, max));
  return out;
}

/** Draw one page. The canvas is sized here. */
export function drawSummaryPage(canvas: HTMLCanvasElement | OffscreenCanvas, input: SummaryPageInput): void {
  const W = Math.round(input.pageWidth * SUMMARY_SCALE);
  const H = Math.round(input.pageHeight * SUMMARY_SCALE);
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false }) as Ctx;
  const M = 110; // margin, about 14 mm
  const right = W - M;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';

  // Heading: the clinic on the left, what this is on the right.
  let y = M + 26;
  ctx.fillStyle = INK;
  ctx.font = `600 30px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(fit(ctx, input.clinicName || 'Slit lamp imaging', W - 2 * M - 420), M, y);
  ctx.fillStyle = SLATE;
  ctx.font = `400 26px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText('Slit lamp photographs', right, y);
  y += 28;
  ctx.fillStyle = LINE;
  ctx.fillRect(M, y, W - 2 * M, 2);

  // Who and when.
  y += 84;
  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = `700 52px ${FONT}`;
  ctx.fillText(fit(ctx, displayName(input.patient), W - 2 * M), M, y);
  y += 54;
  ctx.font = `400 28px ${FONT}`;
  const age = ageFromDOB(input.patient.dob, new Date(`${input.visitDate}T12:00:00`));
  const facts: [string, string][] = [];
  if (input.patient.mrn) facts.push(['Hospital number', input.patient.mrn]);
  if (input.patient.dob) facts.push(['Born', `${formatShortDate(input.patient.dob)}${age != null ? ` (${age})` : ''}`]);
  facts.push(['Visit', formatLongDate(input.visitDate)]);
  let x = M;
  for (const [label, value] of facts) {
    ctx.fillStyle = SLATE;
    ctx.font = `400 28px ${FONT}`;
    ctx.fillText(label, x, y);
    x += ctx.measureText(label).width + 12;
    ctx.fillStyle = INK;
    ctx.font = `600 28px ${FONT}`;
    ctx.fillText(value, x, y);
    x += ctx.measureText(value).width + 44;
  }

  // Diagnoses on any of the photographs, each once.
  let labels: string[] = [];
  const photos = input.cells.filter((p): p is SummaryPhoto => !!p);
  for (const p of photos) for (const d of p.capture.diagnoses ?? []) labels = addDiagnosis(labels, d);
  if (labels.length) {
    y += 46;
    ctx.fillStyle = SLATE;
    ctx.font = `400 28px ${FONT}`;
    ctx.fillText('Diagnosis', M, y);
    const lx = M + ctx.measureText('Diagnosis').width + 12;
    ctx.fillStyle = INK;
    ctx.font = `600 28px ${FONT}`;
    ctx.fillText(fit(ctx, labels.join(', '), right - lx), lx, y);
  }

  // The photographs: one fills the width, two sit side by side (right eye on the left), more make a grid.
  const footerTop = H - M - 10;
  const top = y + 54;
  const n = input.cells.length;
  const cols = n <= 1 ? 1 : 2;
  const rows = Math.max(1, Math.ceil(n / cols));
  const gap = 40;
  const cellW = (W - 2 * M - gap * (cols - 1)) / cols;
  const cellH = (footerTop - 30 - top - gap * (rows - 1)) / rows;
  const noteLines = cols === 1 ? 3 : 2;
  const captionH = 48 + noteLines * 34;
  input.cells.forEach((p, i) => {
    if (!p) return;
    const cx = M + (i % cols) * (cellW + gap);
    const cy = top + Math.floor(i / cols) * (cellH + gap);
    const scale = Math.min(cellW / p.width, (cellH - captionH) / p.height);
    const w = p.width * scale;
    const h = p.height * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(p.image, cx, cy, w, h);

    let ty = cy + h + 40;
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    ctx.font = `700 28px ${FONT}`;
    const eye = EYE_NAME[p.capture.eye];
    ctx.fillText(eye, cx, ty);
    const after = cx + ctx.measureText(eye).width + 20;
    ctx.font = `400 28px ${FONT}`;
    ctx.fillStyle = SLATE;
    const time = formatClock(p.capture.takenAt);
    const timeW = ctx.measureText(time).width;
    ctx.textAlign = 'right';
    ctx.fillText(time, cx + w, ty);
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    const technique = techniqueLabel(p.capture.technique);
    if (technique) ctx.fillText(fit(ctx, technique, cx + w - timeW - 24 - after), after, ty);
    if (p.capture.note) {
      ctx.fillStyle = SLATE;
      ctx.font = `400 26px ${FONT}`;
      for (const line of wrap(ctx, p.capture.note, w, noteLines)) {
        ty += 34;
        ctx.fillText(line, cx, ty);
      }
    }
  });

  // Foot of the page.
  ctx.fillStyle = LINE;
  ctx.fillRect(M, footerTop - 14, W - 2 * M, 2);
  ctx.fillStyle = SLATE;
  ctx.font = `400 22px ${FONT}`;
  ctx.textAlign = 'left';
  const printed = input.printedAt;
  const stamp = `${formatShortDate(`${printed.getFullYear()}-${String(printed.getMonth() + 1).padStart(2, '0')}-${String(printed.getDate()).padStart(2, '0')}`)}, ${formatClock(printed.getTime())}`;
  ctx.fillText(`Produced with Lumen on ${stamp}`, M, footerTop + 22);
  if (input.pageLabel) {
    ctx.textAlign = 'right';
    ctx.fillText(`Page ${input.pageLabel}`, right, footerTop + 22);
  }
}
