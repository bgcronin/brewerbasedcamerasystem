/**
 * Small, dependency-free delimited-text parser (RFC 4180 plus the quirks that
 * real clinic exports have: BOMs, semicolons, tabs from Excel copy/paste,
 * quoted line breaks, ragged rows and trailing blank lines).
 */

// Checked in order; on a tied score the earlier one wins, so an Excel paste like "SMITH, John\t12/03/1956" splits on the tab.
const CANDIDATES = ['\t', ';', '|', ','] as const;

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Count delimiter occurrences per line, ignoring anything inside quotes. */
function countPerLine(sample: string, delim: string): number[] {
  const counts: number[] = [];
  let inQuotes = false;
  let n = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    if (c === '"') {
      if (inQuotes && sample[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && (c === '\n' || c === '\r')) {
      if (c === '\r' && sample[i + 1] === '\n') i++;
      counts.push(n);
      n = 0;
      if (counts.length >= 20) return counts;
    } else if (!inQuotes && c === delim) {
      n++;
    }
  }
  if (n > 0) counts.push(n);
  return counts;
}

export function detectDelimiter(text: string): string {
  const sample = stripBom(text).slice(0, 20000);
  let best: string = ',';
  let bestScore = -1;
  for (const d of CANDIDATES) {
    const counts = countPerLine(sample, d);
    if (!counts.length) continue;
    const nonZero = counts.filter((c) => c > 0);
    if (!nonZero.length) continue;
    // Prefer delimiters that appear a consistent number of times on every line.
    const freq = new Map<number, number>();
    for (const c of nonZero) freq.set(c, (freq.get(c) ?? 0) + 1);
    const [mode, modeCount] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
    const consistency = modeCount / counts.length;
    const score = consistency * 10 + Math.min(mode, 30) / 30;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

export function parseDelimited(input: string, delimiter?: string): string[][] {
  const text = stripBom(input);
  const delim = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (c === delim) {
      endField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else {
      field += c;
      fieldStarted = true;
    }
  }
  if (field !== '' || row.length > 0) endRow();

  // Drop rows that are completely blank (trailing newlines, spacer rows).
  return rows
    .map((r) => r.map((v) => v.trim()))
    .filter((r) => r.some((v) => v !== ''));
}
