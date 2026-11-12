/**
 * The smallest useful PDF writer: one or more pages, each a single JPEG that
 * fills the page. The summary sheet is drawn on a canvas (so any name in any
 * script comes out right, with the fonts already on the computer) and wrapped
 * here, with no library and nothing sent anywhere.
 */

export interface PdfPage {
  /** A baseline JPEG, embedded exactly as it is. */
  jpeg: Uint8Array;
  /** Its size in pixels. */
  width: number;
  height: number;
}

export interface PdfOptions {
  /** Page size in points (1/72 inch). */
  pageWidth: number;
  pageHeight: number;
  title?: string;
  created?: Date;
}

export const A4 = { pageWidth: 595.28, pageHeight: 841.89 };
export const LETTER = { pageWidth: 612, pageHeight: 792 };

/** The paper people in this locale print on. */
export function paperFor(locale: string): { pageWidth: number; pageHeight: number } {
  return /-(US|CA|MX|PH|CL|CO)\b/i.test(locale) ? LETTER : A4;
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** A PDF text string that can hold any character: UTF-16 with a byte-order mark, written in hex. */
function textString(s: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `(D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())})`;
}

export function buildPdf(pages: PdfPage[], opts: PdfOptions): Uint8Array {
  if (!pages.length) throw new Error('A PDF needs at least one page');
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (data: string | Uint8Array) => {
    const bytes = typeof data === 'string' ? ascii(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) {
      push('stream\n');
      push(stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  };

  // Objects: 1 catalog, 2 page tree, 3 info, then three per page (page, image, drawing instructions).
  const W = opts.pageWidth.toFixed(2);
  const H = opts.pageHeight.toFixed(2);
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const pageIds = pages.map((_, i) => 4 + i * 3);
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  object(3, `<< /Producer ${textString('Lumen slit lamp imaging')} /Title ${textString(opts.title ?? 'Photographs')} /CreationDate ${pdfDate(opts.created ?? new Date())} >>`);
  pages.forEach((page, i) => {
    const id = pageIds[i];
    const draw = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`);
    object(
      id + 1,
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>`,
      page.jpeg,
    );
    object(id + 2, `<< /Length ${draw.length} >>`, ascii(draw));
  });

  const count = 4 + pages.length * 3;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
