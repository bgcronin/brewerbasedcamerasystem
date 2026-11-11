/**
 * Is this the same person? Used wherever an import is about to attach a row to
 * a patient already on record, so that a misread hospital number can never
 * rename somebody.
 */

export interface PersonName {
  firstName: string;
  lastName: string;
}

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'professor', 'master', 'sr', 'sir', 'dame', 'rev', 'fr', 'sister']);

/** Lower case, no accents, no punctuation: "O’Súilleabháin" and "O'SUILLEABHAIN" come out the same. */
function tokens(name: PersonName): string[] {
  return `${name.lastName} ${name.firstName}`
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !TITLES.has(t));
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** One spelling slip in a short word, two in a long one. */
const close = (a: string, b: string) => editDistance(a, b) <= (Math.max(a.length, b.length) >= 8 ? 2 : Math.min(a.length, b.length) >= 4 ? 1 : 0);

/** Tom / Thomas, Kate / Katherine: the short form's letters appear, in order, in the long one. */
function shortFor(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 3 || short[0] !== long[0]) return false;
  let i = 0;
  for (const ch of long) if (ch === short[i]) i++;
  return i === short.length;
}

function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  // An initial stands for any name that starts with it.
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  return close(a, b) || shortFor(a, b);
}

/**
 * True only when two names cannot reasonably be the same person: not for
 * capitals, accents, punctuation, the order of the parts, a title, a missing
 * middle name, an initial in place of a name, or a spelling slip.
 */
export function namesClearlyDiffer(a: PersonName, b: PersonName): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  // "Mc Carthy" / "McCarthy", "De La Cruz" / "Delacruz": compare with the spaces taken out as well.
  const ja = [...ta].sort().join('');
  const jb = [...tb].sort().join('');
  if (ja === jb || close(ta.join(''), tb.join('')) || close(ja, jb)) return false;
  const [few, many] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const left = [...many];
  for (const t of few) {
    const i = left.findIndex((m) => wordsMatch(t, m));
    if (i < 0) return true;
    left.splice(i, 1);
  }
  // Every part of the shorter name is in the longer one. A lone initial or a single shared word is not enough to go on.
  const solid = few.filter((t) => t.length > 1).length;
  return few.length < 2 && many.length > 1 ? solid === 0 : false;
}
