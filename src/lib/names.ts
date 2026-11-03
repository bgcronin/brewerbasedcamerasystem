import type { Patient } from './types';

const TITLES = /^(mr|mrs|ms|miss|mx|dr|prof|professor|master|sr|sir|dame|rev|fr|sister)\.?\s+/i;

/** "O'BRIEN" → "O'Brien", "mcdonald" → "McDonald", "anne-marie" → "Anne-Marie". */
export function titleCase(raw: string): string {
  const s = raw.trim().replace(/\s+/g, ' ');
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/(^|[\s\-'’])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(/\bMc(\p{L})/gu, (_, ch: string) => 'Mc' + ch.toUpperCase());
}

/** Only re-case names that arrived ALL CAPS or all lower case; respect deliberate casing like "van der Berg". */
export function normaliseNamePart(raw: string): string {
  const s = raw.trim().replace(/\s+/g, ' ');
  if (!s) return '';
  if (s === s.toUpperCase() || s === s.toLowerCase()) return titleCase(s);
  return s;
}

/** Split a single "name" column. Handles "SMITH, John", "Smith John" (surname in caps), "Mr John Smith". */
export function splitFullName(raw: string): { firstName: string; lastName: string } {
  let s = raw.trim().replace(/\s+/g, ' ').replace(TITLES, '');
  s = s.replace(/\s*\((mr|mrs|ms|miss|mx|dr|prof)\.?\)\s*$/i, '');
  if (!s) return { firstName: '', lastName: '' };

  if (s.includes(',')) {
    const [last, ...rest] = s.split(',');
    return { lastName: normaliseNamePart(last), firstName: normaliseNamePart(rest.join(' ').replace(TITLES, '')) };
  }
  const parts = s.split(' ');
  if (parts.length === 1) return { firstName: '', lastName: normaliseNamePart(parts[0]) };

  // NHS-style "SMITH John": a leading ALL-CAPS token followed by mixed case means surname first.
  const isCaps = (p: string) => p.length > 1 && p === p.toUpperCase() && /\p{L}/u.test(p);
  if (isCaps(parts[0]) && !parts.slice(1).every(isCaps)) {
    let i = 0;
    while (i < parts.length - 1 && isCaps(parts[i])) i++;
    return { lastName: normaliseNamePart(parts.slice(0, i).join(' ')), firstName: normaliseNamePart(parts.slice(i).join(' ')) };
  }
  // "John SMITH" or "John Smith": the last token is the surname, keeping particles (van, de, O', etc.).
  let split = parts.length - 1;
  const particles = new Set(['van', 'von', 'de', 'der', 'den', 'del', 'della', 'di', 'da', 'du', 'le', 'la', 'mac', 'ni', 'nic', 'ó', 'o', 'bin', 'al']);
  while (split > 1 && particles.has(parts[split - 1].toLowerCase())) split--;
  return { firstName: normaliseNamePart(parts.slice(0, split).join(' ')), lastName: normaliseNamePart(parts.slice(split).join(' ')) };
}

/** Clinical display convention: family name in capitals, then given name — "SMITH, John". */
export function displayName(p: Pick<Patient, 'firstName' | 'lastName'>): string {
  const last = p.lastName.trim().toUpperCase();
  const first = p.firstName.trim();
  if (last && first) return `${last}, ${first}`;
  return last || first || 'Unnamed patient';
}

export function initials(p: Pick<Patient, 'firstName' | 'lastName'>): string {
  const a = p.firstName.trim()[0] ?? '';
  const b = p.lastName.trim()[0] ?? '';
  return (a + b).toUpperCase() || '·';
}

export function normaliseSex(raw: string | undefined): Patient['sex'] {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return '';
  if (/^(m|male|man|boy)$/.test(s)) return 'M';
  if (/^(f|female|woman|girl|w)$/.test(s)) return 'F';
  if (/^(u|unknown|not known|ns|not specified|-)$/.test(s)) return '';
  return 'O';
}
