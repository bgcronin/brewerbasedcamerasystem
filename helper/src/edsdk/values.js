// Canon property codes ↔ human-readable labels (from the EDSDK API reference).
// Lumen only ever sees the labels, so it stays independent of the SDK.

const ISO = {
  0x00: 'Auto',
  0x28: '6', 0x30: '12', 0x38: '25', 0x40: '50', 0x45: '80',
  0x48: '100', 0x4b: '125', 0x4d: '160', 0x50: '200', 0x53: '250', 0x55: '320',
  0x58: '400', 0x5b: '500', 0x5d: '640', 0x60: '800', 0x63: '1000', 0x65: '1250',
  0x68: '1600', 0x6b: '2000', 0x6d: '2500', 0x70: '3200', 0x73: '4000', 0x75: '5000',
  0x78: '6400', 0x7b: '8000', 0x7d: '10000', 0x80: '12800', 0x83: '16000', 0x85: '20000',
  0x88: '25600', 0x8b: '32000', 0x8d: '40000', 0x90: '51200', 0x93: '64000', 0x95: '80000',
  0x98: '102400', 0xa0: '204800', 0xa8: '409600', 0xb0: '819200',
};

const AV = {
  0x08: 'f/1', 0x0b: 'f/1.1', 0x0c: 'f/1.2', 0x0d: 'f/1.2', 0x10: 'f/1.4', 0x13: 'f/1.6', 0x14: 'f/1.8',
  0x15: 'f/1.8', 0x18: 'f/2', 0x1b: 'f/2.2', 0x1c: 'f/2.5', 0x1d: 'f/2.5', 0x20: 'f/2.8', 0x23: 'f/3.2',
  0x24: 'f/3.5', 0x25: 'f/3.5', 0x28: 'f/4', 0x2b: 'f/4.5', 0x2c: 'f/4.5', 0x2d: 'f/5', 0x30: 'f/5.6',
  0x33: 'f/6.3', 0x34: 'f/6.7', 0x35: 'f/7.1', 0x38: 'f/8', 0x3b: 'f/9', 0x3c: 'f/9.5', 0x3d: 'f/10',
  0x40: 'f/11', 0x43: 'f/13', 0x44: 'f/13', 0x45: 'f/14', 0x48: 'f/16', 0x4b: 'f/18', 0x4c: 'f/19',
  0x4d: 'f/20', 0x50: 'f/22', 0x53: 'f/25', 0x54: 'f/27', 0x55: 'f/29', 0x58: 'f/32', 0x5b: 'f/36',
  0x5c: 'f/38', 0x5d: 'f/40', 0x60: 'f/45', 0x63: 'f/51', 0x64: 'f/54', 0x65: 'f/57', 0x68: 'f/64',
  0x6b: 'f/72', 0x6c: 'f/76', 0x6d: 'f/80', 0x70: 'f/91',
};

const TV = {
  0x0c: 'Bulb', 0x10: '30″', 0x13: '25″', 0x14: '20″', 0x15: '20″', 0x18: '15″', 0x1b: '13″', 0x1c: '10″',
  0x1d: '10″', 0x20: '8″', 0x23: '6″', 0x24: '6″', 0x25: '5″', 0x28: '4″', 0x2b: '3.2″', 0x2c: '3″',
  0x2d: '2.5″', 0x30: '2″', 0x33: '1.6″', 0x34: '1.5″', 0x35: '1.3″', 0x38: '1″', 0x3b: '0.8″', 0x3c: '0.7″',
  0x3d: '0.6″', 0x40: '0.5″', 0x43: '0.4″', 0x44: '0.3″', 0x45: '0.3″', 0x48: '1/4', 0x4b: '1/5', 0x4c: '1/6',
  0x4d: '1/6', 0x50: '1/8', 0x53: '1/10', 0x54: '1/10', 0x55: '1/13', 0x58: '1/15', 0x5b: '1/20', 0x5c: '1/20',
  0x5d: '1/25', 0x60: '1/30', 0x63: '1/40', 0x64: '1/45', 0x65: '1/50', 0x68: '1/60', 0x6b: '1/80', 0x6c: '1/90',
  0x6d: '1/100', 0x70: '1/125', 0x73: '1/160', 0x74: '1/180', 0x75: '1/200', 0x78: '1/250', 0x7b: '1/320',
  0x7c: '1/350', 0x7d: '1/400', 0x80: '1/500', 0x83: '1/640', 0x84: '1/750', 0x85: '1/800', 0x88: '1/1000',
  0x8b: '1/1250', 0x8c: '1/1500', 0x8d: '1/1600', 0x90: '1/2000', 0x93: '1/2500', 0x94: '1/3000', 0x95: '1/3200',
  0x98: '1/4000', 0x9b: '1/5000', 0x9c: '1/6000', 0x9d: '1/6400', 0xa0: '1/8000',
};

const WB = {
  0: 'Auto', 1: 'Daylight', 2: 'Cloudy', 3: 'Tungsten', 4: 'Fluorescent', 5: 'Flash', 6: 'Custom', 8: 'Shade',
  9: 'Colour temp.', 10: 'PC-1', 11: 'PC-2', 12: 'PC-3', 23: 'Auto (white)',
};

const AE_MODE = {
  0: 'P', 1: 'Tv', 2: 'Av', 3: 'M', 4: 'B', 5: 'A-DEP', 6: 'DEP', 7: 'C', 8: 'Lock', 9: 'Auto', 10: 'Night portrait',
  11: 'Sports', 12: 'Portrait', 13: 'Landscape', 14: 'Close-up', 15: 'Flash off', 19: 'Creative auto', 20: 'Movie',
  22: 'Scene intelligent auto',
};

/** Default option lists for cameras that don't report a description for a property. */
const FALLBACK_OPTIONS = {
  wb: [0, 1, 8, 2, 3, 4, 5, 6],
};

export const TABLES = { iso: ISO, av: AV, tv: TV, wb: WB, mode: AE_MODE };

export function labelFor(prop, code) {
  const t = TABLES[prop];
  if (code == null || code === 0xffffffff || code === -1) return null;
  return t?.[code] ?? `0x${(code >>> 0).toString(16)}`;
}

/** Turn the camera's list of allowed codes into unique labels, keeping camera order. */
export function optionsFor(prop, codes) {
  const list = codes?.length ? codes : FALLBACK_OPTIONS[prop] ?? [];
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const l = labelFor(prop, c);
    if (l && !seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  }
  return out;
}

/** Find the code for a label among the codes the camera currently allows. */
export function codeFor(prop, label, allowedCodes) {
  const table = TABLES[prop];
  if (!table) return undefined;
  const norm = (s) => String(s).replace(/^ISO\s*/i, '').replace(/\s+/g, '').toLowerCase();
  const want = norm(label);
  const candidates = allowedCodes?.length ? allowedCodes : Object.keys(table).map(Number);
  return candidates.find((c) => table[c] != null && norm(table[c]) === want);
}

/** Which exposure settings the camera lets software change in each mode. */
export function writableInMode(modeLabel) {
  switch (modeLabel) {
    case 'M':
      return { iso: true, tv: true, av: true, wb: true };
    case 'Av':
      return { iso: true, tv: false, av: true, wb: true };
    case 'Tv':
      return { iso: true, tv: true, av: false, wb: true };
    case 'P':
      return { iso: true, tv: false, av: false, wb: true };
    default:
      return { iso: false, tv: false, av: false, wb: false };
  }
}
