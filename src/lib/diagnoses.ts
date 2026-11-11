/**
 * Diagnosis labels for anterior segment photographs.
 *
 * The list is a starting vocabulary for type-ahead, not a closed set: anything
 * typed by hand is kept and offered again. Aliases cover abbreviations and
 * alternative spellings, so "KC", "edema" and "oedema" all find the right entry.
 */

export interface DiagnosisEntry {
  name: string;
  aliases?: string[];
}

export const DIAGNOSES: DiagnosisEntry[] = [
  // Cornea
  { name: 'Keratoconus', aliases: ['KC', 'KCN'] },
  { name: 'Pellucid marginal degeneration', aliases: ['PMD'] },
  { name: 'Corneal ectasia', aliases: ['post-LASIK ectasia'] },
  { name: 'Microbial keratitis', aliases: ['corneal ulcer', 'bacterial keratitis', 'MK', 'ulcer'] },
  { name: 'Fungal keratitis' },
  { name: 'Acanthamoeba keratitis', aliases: ['AK'] },
  { name: 'Herpes simplex keratitis', aliases: ['HSV', 'HSK', 'dendritic ulcer', 'dendrite', 'disciform'] },
  { name: 'Herpes zoster ophthalmicus', aliases: ['HZO', 'shingles'] },
  { name: 'Marginal keratitis' },
  { name: 'Peripheral ulcerative keratitis', aliases: ['PUK'] },
  { name: 'Contact lens keratitis', aliases: ['CL keratitis', 'CLARE', 'infiltrates'] },
  { name: 'Adenoviral keratoconjunctivitis', aliases: ['EKC', 'subepithelial infiltrates', 'adenovirus'] },
  { name: 'Thygeson keratitis', aliases: ['Thygeson’s', 'TSPK'] },
  { name: 'Neurotrophic keratopathy', aliases: ['neurotrophic keratitis', 'NK'] },
  { name: 'Exposure keratopathy' },
  { name: 'Filamentary keratitis' },
  { name: 'Interstitial keratitis', aliases: ['IK'] },
  { name: 'Punctate epithelial erosions', aliases: ['PEE', 'SPK', 'punctate staining'] },
  { name: 'Dry eye disease', aliases: ['DED', 'keratoconjunctivitis sicca', 'KCS', 'dry eye'] },
  { name: 'Corneal abrasion' },
  { name: 'Recurrent corneal erosion', aliases: ['RCE', 'RCES'] },
  { name: 'Corneal foreign body', aliases: ['FB', 'rust ring'] },
  { name: 'Corneal scar', aliases: ['corneal opacity', 'leucoma', 'leukoma'] },
  { name: 'Corneal oedema', aliases: ['corneal edema'] },
  { name: 'Bullous keratopathy', aliases: ['PBK'] },
  { name: 'Fuchs endothelial dystrophy', aliases: ['FED', 'FECD', 'guttata', 'Fuchs'] },
  { name: 'Epithelial basement membrane dystrophy', aliases: ['EBMD', 'map-dot-fingerprint', 'Cogan'] },
  { name: 'Granular dystrophy' },
  { name: 'Lattice dystrophy' },
  { name: 'Corneal dystrophy' },
  { name: 'Salzmann nodular degeneration', aliases: ['Salzmann'] },
  { name: 'Band keratopathy' },
  { name: 'Terrien marginal degeneration', aliases: ['Terrien'] },
  { name: 'Cornea verticillata', aliases: ['vortex keratopathy', 'amiodarone'] },
  { name: 'Kayser-Fleischer ring', aliases: ['KF ring', 'Wilson'] },
  { name: 'Corneal neovascularisation', aliases: ['corneal neovascularization', 'pannus'] },
  { name: 'Corneal perforation', aliases: ['descemetocele'] },
  { name: 'Limbal stem cell deficiency', aliases: ['LSCD'] },
  { name: 'Chemical injury', aliases: ['alkali burn', 'acid burn'] },
  { name: 'Corneal graft', aliases: ['PK', 'penetrating keratoplasty', 'keratoplasty'] },
  { name: 'DALK', aliases: ['deep anterior lamellar keratoplasty'] },
  { name: 'Endothelial keratoplasty', aliases: ['DMEK', 'DSAEK', 'DSEK'] },
  { name: 'Graft rejection' },
  { name: 'Graft failure' },
  { name: 'Corneal cross-linking', aliases: ['CXL'] },
  { name: 'Refractive surgery', aliases: ['LASIK', 'PRK', 'SMILE', 'flap'] },
  { name: 'Epithelial ingrowth' },

  // Conjunctiva and sclera
  { name: 'Pterygium' },
  { name: 'Pinguecula' },
  { name: 'Conjunctival naevus', aliases: ['conjunctival nevus'] },
  { name: 'Conjunctival melanosis', aliases: ['PAM', 'primary acquired melanosis'] },
  { name: 'Conjunctival melanoma' },
  { name: 'Ocular surface squamous neoplasia', aliases: ['OSSN', 'CIN', 'conjunctival intraepithelial neoplasia'] },
  { name: 'Conjunctival papilloma' },
  { name: 'Conjunctival cyst' },
  { name: 'Conjunctival lymphoma', aliases: ['salmon patch'] },
  { name: 'Conjunctival lesion' },
  { name: 'Conjunctivochalasis' },
  { name: 'Subconjunctival haemorrhage', aliases: ['SCH', 'subconjunctival hemorrhage'] },
  { name: 'Allergic conjunctivitis' },
  { name: 'Vernal keratoconjunctivitis', aliases: ['VKC'] },
  { name: 'Atopic keratoconjunctivitis', aliases: ['AKC'] },
  { name: 'Bacterial conjunctivitis' },
  { name: 'Viral conjunctivitis' },
  { name: 'Giant papillary conjunctivitis', aliases: ['GPC'] },
  { name: 'Superior limbic keratoconjunctivitis', aliases: ['SLK'] },
  { name: 'Mucous membrane pemphigoid', aliases: ['OCP', 'ocular cicatricial pemphigoid', 'MMP', 'symblepharon'] },
  { name: 'Stevens-Johnson syndrome', aliases: ['SJS'] },
  { name: 'Phlyctenule' },
  { name: 'Episcleritis' },
  { name: 'Scleritis' },

  // Lids and adnexa
  { name: 'Blepharitis' },
  { name: 'Meibomian gland dysfunction', aliases: ['MGD'] },
  { name: 'Demodex' },
  { name: 'Chalazion' },
  { name: 'Stye', aliases: ['hordeolum'] },
  { name: 'Trichiasis' },
  { name: 'Entropion' },
  { name: 'Ectropion' },
  { name: 'Ptosis' },
  { name: 'Dermatochalasis' },
  { name: 'Floppy eyelid syndrome', aliases: ['FES'] },
  { name: 'Lagophthalmos' },
  { name: 'Lid lesion', aliases: ['eyelid lesion'] },
  { name: 'Basal cell carcinoma', aliases: ['BCC'] },
  { name: 'Molluscum contagiosum' },
  { name: 'Xanthelasma' },
  { name: 'Thyroid eye disease', aliases: ['TED', 'Graves'] },
  { name: 'Punctal plug', aliases: ['punctal stenosis'] },

  // Anterior chamber, iris, lens, glaucoma
  { name: 'Anterior uveitis', aliases: ['iritis', 'AAU', 'uveitis'] },
  { name: 'Keratic precipitates', aliases: ['KPs'] },
  { name: 'Posterior synechiae' },
  { name: 'Hypopyon' },
  { name: 'Hyphaema', aliases: ['hyphema'] },
  { name: 'Iris naevus', aliases: ['iris nevus'] },
  { name: 'Iris melanoma' },
  { name: 'Iris cyst' },
  { name: 'Iris atrophy' },
  { name: 'Iris neovascularisation', aliases: ['rubeosis', 'NVI', 'iris neovascularization'] },
  { name: 'Iridocorneal endothelial syndrome', aliases: ['ICE'] },
  { name: 'Iris coloboma' },
  { name: 'Aniridia' },
  { name: 'Peripheral iridotomy', aliases: ['PI', 'laser iridotomy'] },
  { name: 'Narrow angle', aliases: ['angle closure', 'PAC', 'PACG'] },
  { name: 'Pigment dispersion syndrome', aliases: ['PDS', 'Krukenberg spindle'] },
  { name: 'Pseudoexfoliation', aliases: ['PXF', 'PEX'] },
  { name: 'Cataract' },
  { name: 'Posterior capsule opacification', aliases: ['PCO'] },
  { name: 'Intraocular lens', aliases: ['IOL', 'pseudophakia'] },
  { name: 'IOL dislocation', aliases: ['subluxed IOL', 'decentred IOL'] },
  { name: 'Lens subluxation', aliases: ['ectopia lentis'] },
  { name: 'Trabeculectomy bleb', aliases: ['bleb', 'trab'] },
  { name: 'Glaucoma drainage device', aliases: ['tube', 'Baerveldt', 'Ahmed'] },
  { name: 'Blebitis' },
  { name: 'Penetrating injury', aliases: ['open globe', 'laceration', 'trauma'] },
  { name: 'Normal', aliases: ['control', 'NAD'] },
];

/**
 * Fold case, accents and the ae/oe digraphs, so British and American spellings
 * (haemorrhage / hemorrhage, oedema / edema, naevus / nevus) compare equal.
 */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/ae|oe/g, 'e')
    .replace(/isation/g, 'ization')
    .trim();
}

const BY_FOLDED = new Map<string, DiagnosisEntry>();
for (const d of DIAGNOSES) {
  BY_FOLDED.set(fold(d.name), d);
  for (const a of d.aliases ?? []) if (!BY_FOLDED.has(fold(a))) BY_FOLDED.set(fold(a), d);
}

/** Everything a diagnosis can be found by: its name plus any abbreviations and other spellings. */
export function diagnosisSearchText(name: string): string {
  const entry = BY_FOLDED.get(fold(name));
  return fold([name, ...(entry?.aliases ?? [])].join(' '));
}

/** Tidy a hand-typed label: collapse spaces, capitalise the first letter, and snap to the known spelling if there is one. */
export function canonicalDiagnosis(raw: string): string {
  const s = raw.trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const known = BY_FOLDED.get(fold(s));
  if (known && fold(known.name) === fold(s)) return known.name;
  return s[0].toUpperCase() + s.slice(1);
}

export function sameDiagnosis(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

export function hasDiagnosis(list: string[] | undefined, name: string): boolean {
  return !!list?.some((d) => sameDiagnosis(d, name));
}

export function addDiagnosis(list: string[] | undefined, name: string): string[] {
  const clean = canonicalDiagnosis(name);
  if (!clean || hasDiagnosis(list, clean)) return list ?? [];
  return [...(list ?? []), clean];
}

export function removeDiagnosis(list: string[] | undefined, name: string): string[] {
  return (list ?? []).filter((d) => !sameDiagnosis(d, name));
}

/**
 * Type-ahead suggestions. `preferred` (this patient's earlier diagnoses, then
 * recently used ones) come first when they match; with nothing typed, only
 * those are offered.
 */
export function suggestDiagnoses(query: string, opts: { exclude?: string[]; preferred?: string[]; limit?: number } = {}): string[] {
  const { exclude = [], preferred = [], limit = 7 } = opts;
  const q = fold(query);
  const taken = new Set(exclude.map(fold));
  const seen = new Set<string>();
  const out: { name: string; score: number }[] = [];
  const consider = (name: string, boost: number) => {
    const key = fold(name);
    if (taken.has(key) || seen.has(key)) return;
    let score = -1;
    if (!q) score = boost > 0 ? boost : -1;
    else {
      const entry = BY_FOLDED.get(key);
      const aliases = (entry?.aliases ?? []).map(fold);
      const words = key.split(' ');
      if (key === q || aliases.includes(q)) score = 100;
      else if (key.startsWith(q)) score = 80;
      else if (words.some((w) => w.startsWith(q))) score = 60;
      else if (aliases.some((a) => a.startsWith(q) || a.split(' ').some((w) => w.startsWith(q)))) score = 50;
      else if (q.length >= 3 && (key.includes(q) || aliases.some((a) => a.includes(q)))) score = 30;
      else if (q.includes(' ') && q.split(' ').every((part) => words.some((w) => w.startsWith(part)))) score = 55;
      if (score >= 0) score += boost;
    }
    if (score >= 0) {
      seen.add(key);
      out.push({ name, score });
    }
  };
  preferred.forEach((p, i) => consider(p, 20 - Math.min(i, 15) * 0.5));
  for (const d of DIAGNOSES) consider(d.name, 0);
  return out
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
    .slice(0, limit)
    .map((x) => x.name);
}
