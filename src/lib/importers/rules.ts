/**
 * Takes the ruling lines out of a picture of a table before it is read.
 *
 * OCR reads a table with cell borders as noise: every vertical rule becomes a
 * stray character and the words between them are lost. A rule is long and
 * thin; a letter is neither. So: find long dark runs, keep only those that are
 * thin all the way along (a row of touching letters is not), and paint them
 * out. Runs are followed across a few neighbouring rows so a photo taken at a
 * slight angle still counts.
 *
 * Works on an 8-bit greyscale buffer in place and returns how many pixels were
 * cleared. No DOM, so it is unit tested.
 */

const BAND = 2;

/** Dark where clearly darker than the neighbourhood, so uneven lighting on a photo does not matter. */
function darkMask(gray: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8Array {
  const integral = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  const r = Math.max(12, Math.round(Math.min(w, h) / 50));
  const dark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      const mean = sum / ((y1 - y0) * (x1 - x0));
      if (gray[y * w + x] < mean * 0.78 && gray[y * w + x] < 190) dark[y * w + x] = 1;
    }
  }
  return dark;
}

/**
 * One pass, written for horizontal rules. `at(a, b)` reads the mask with `a`
 * along the rule and `b` across it, so the same code finds vertical rules with
 * the axes swapped.
 */
function sweep(len: number, across: number, at: (a: number, b: number) => number, mark: (a: number, b: number) => void, minRun: number, maxThick: number): void {
  const near = (a: number, b: number): number => {
    // The row within the band that is dark at this position, nearest first.
    for (let d = 0; d <= BAND; d++) {
      if (b - d >= 0 && at(a, b - d)) return b - d;
      if (d && b + d < across && at(a, b + d)) return b + d;
    }
    return -1;
  };
  const thickness = (a: number, b: number): [number, number] => {
    let lo = b;
    let hi = b;
    while (lo > 0 && at(a, lo - 1)) lo--;
    while (hi < across - 1 && at(a, hi + 1)) hi++;
    return [lo, hi];
  };
  for (let b = 0; b < across; b++) {
    let start = -1;
    for (let a = 0; a <= len; a++) {
      const on = a < len && near(a, b) >= 0;
      if (on && start < 0) start = a;
      if (on || start < 0) continue;
      const end = a;
      const run = end - start;
      const from = start;
      start = -1;
      if (run < minRun) continue;
      // Thin almost everywhere along its length? Sample it.
      const step = Math.max(1, Math.floor(run / 40));
      let thin = 0;
      let seen = 0;
      for (let s = from; s < end; s += step) {
        const hit = near(s, b);
        if (hit < 0) continue;
        const [lo, hi] = thickness(s, hit);
        seen++;
        if (hi - lo + 1 <= maxThick) thin++;
      }
      if (!seen || thin / seen < 0.8) continue;
      for (let s = from; s < end; s++) {
        const hit = near(s, b);
        if (hit < 0) continue;
        const [lo, hi] = thickness(s, hit);
        // Where a letter or the crossing rule touches, leave it: only the thin part is the rule.
        if (hi - lo + 1 > maxThick * 1.5) continue;
        for (let t = Math.max(0, lo - 1); t <= Math.min(across - 1, hi + 1); t++) mark(s, t);
      }
    }
  }
}

export function removeRules(gray: Uint8ClampedArray | Uint8Array, w: number, h: number): number {
  if (w < 200 || h < 200) return 0;
  const dark = darkMask(gray, w, h);
  const erase = new Uint8Array(w * h);
  const maxThick = Math.max(6, Math.round(Math.min(w, h) / 220));
  const minH = Math.max(110, Math.round(w / 18));
  const minV = Math.max(110, Math.round(h / 18));
  sweep(w, h, (x, y) => dark[y * w + x], (x, y) => (erase[y * w + x] = 1), minH, maxThick);
  sweep(h, w, (y, x) => dark[y * w + x], (y, x) => (erase[y * w + x] = 1), minV, maxThick);
  let cleared = 0;
  for (let i = 0; i < erase.length; i++) {
    if (!erase[i]) continue;
    gray[i] = 255;
    cleared++;
  }
  return cleared;
}
