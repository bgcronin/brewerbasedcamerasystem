/** Taking ruling lines out of a picture of a table, and placing PDF text on a rotated page. */
import { describe, expect, it } from 'vitest';
import { removeRules } from '../src/lib/importers/rules';

/** A white page with "letters" (small dark blocks with gaps, like a line of type) in a grid of cells. */
function page(w: number, h: number, opts: { grid?: boolean; skew?: number } = {}) {
  const g = new Uint8ClampedArray(w * h).fill(250);
  const put = (x: number, y: number, v = 20) => {
    if (x >= 0 && y >= 0 && x < w && y < h) g[Math.round(y) * w + Math.round(x)] = v;
  };
  const rows = [80, 140, 200, 260, 320];
  const cols = [40, 200, 420, 620];
  const text: [number, number][] = [];
  for (const y of rows) {
    for (const x of cols) {
      // Eight letters: 14 wide, 22 tall, 5 apart, with a 4-pixel stroke.
      for (let k = 0; k < 8; k++) {
        for (let dy = 0; dy < 22; dy++) for (let dx = 0; dx < 14; dx++) if (dx < 4 || dy < 4) text.push([x + 12 + k * 19 + dx, y + 16 + dy]);
      }
    }
  }
  for (const [x, y] of text) put(x, y + (opts.skew ?? 0) * x);
  const rule: [number, number][] = [];
  if (opts.grid) {
    for (const y of [...rows, 380]) for (let x = 30; x < w - 30; x++) for (let t = 0; t < 3; t++) rule.push([x, y + t]);
    for (const x of [30, ...cols.slice(1).map((c) => c - 6), w - 30]) for (let y = 80; y < 383; y++) for (let t = 0; t < 3; t++) rule.push([x + t, y]);
  }
  for (const [x, y] of rule) put(x - (opts.skew ?? 0) * (y - 80), y + (opts.skew ?? 0) * x);
  const dark = (pts: [number, number][], skewed = false) =>
    pts.filter(([x, y]) => {
      const px = skewed ? Math.round(x - (opts.skew ?? 0) * (y - 80)) : Math.round(x);
      const py = Math.round(y + (opts.skew ?? 0) * x);
      return px >= 0 && py >= 0 && px < w && py < h && g[py * w + px] < 128;
    }).length;
  return { g, text, rule, dark };
}

describe('removing ruling lines', () => {
  it('leaves a page without rules exactly as it was', () => {
    const p = page(820, 460);
    expect(removeRules(p.g, 820, 460)).toBe(0);
    expect(p.dark(p.text)).toBe(p.text.length);
  });

  it('takes a full grid out and keeps the text', () => {
    const p = page(820, 460, { grid: true });
    expect(p.dark(p.rule, true)).toBeGreaterThan(p.rule.length * 0.95);
    expect(removeRules(p.g, 820, 460)).toBeGreaterThan(0);
    expect(p.dark(p.rule, true)).toBeLessThan(p.rule.length * 0.05);
    expect(p.dark(p.text)).toBeGreaterThan(p.text.length * 0.99);
  });

  it('still finds the rules on a photo taken two degrees off straight', () => {
    const p = page(820, 460, { grid: true, skew: 0.035 });
    removeRules(p.g, 820, 460);
    expect(p.dark(p.rule, true)).toBeLessThan(p.rule.length * 0.15);
    expect(p.dark(p.text)).toBeGreaterThan(p.text.length * 0.97);
  });
});

describe('PDF text on a rotated page', () => {
  it('reads across the page as displayed, whichever way the page is stored', async () => {
    (globalThis as { document?: unknown }).document ??= { baseURI: 'http://localhost/' };
    const { itemsToBoxes } = await import('../src/lib/importers/scan');
    const { readScan } = await import('../src/lib/importers/scanParse');
    const rows = [
      ['09:00', 'H100234', 'FITZGERALD, Eleanor', '12/03/1956'],
      ['09:15', 'H100877', "O'SULLIVAN, Cian", '30/07/1988'],
      ['09:30', 'H101532', 'NAKAMURA, Hana', '04/11/1972'],
    ];
    const xs = [40, 95, 180, 350];
    // A landscape list stored as a portrait page (595 × 842) with /Rotate 90: text runs up the stored page.
    const stored = rows.flatMap((r, ri) => r.map((str, ci) => ({ str, width: str.length * 5, height: 10, transform: [0, 10, -10, 0, 595 - (500 - ri * 18), xs[ci]] })));
    const rotate90 = [0, 1, 1, 0, 0, 0]; // pdf.js viewport transform for a page rotated 90 degrees, scale 1
    const upright = readScan([{ page: 1, ocr: false, boxes: itemsToBoxes(stored, rotate90) }]);
    expect(upright.rows.map((r) => r.slice(0, 4))).toEqual(rows);
    // The same content with no /Rotate at all (a scanner's sideways text layer): the page is turned to suit the text.
    const sideways = readScan([{ page: 1, ocr: false, boxes: itemsToBoxes(stored, [1, 0, 0, -1, 0, 842]) }]);
    expect(sideways.rows.map((r) => r.slice(0, 4))).toEqual(rows);
  });
});
