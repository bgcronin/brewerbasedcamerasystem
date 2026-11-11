/**
 * Drawing marks on photographs. Marks are stored as vectors beside the photo
 * (the photo itself is never changed) and drawn the same way in three places:
 * the viewer (SVG), the archive's "_annotated" copy and downloads (canvas).
 */
import type { Annotation } from './types';

export const ANNOTATION_COLORS = [
  { value: '#FFD60A', label: 'Yellow' },
  { value: '#34D3FF', label: 'Cyan' },
  { value: '#FF4F9A', label: 'Pink' },
  { value: '#FFFFFF', label: 'White' },
] as const;

export type AnnotationTool = 'ellipse' | 'arrow' | 'pen' | 'text' | 'erase';

/** Line weight, arrowhead and text size all scale with the photo, like ink on a print. */
export function metrics(width: number, height: number) {
  const base = Math.max(width, height);
  const stroke = base / 360;
  return { stroke, halo: stroke * 2.1, head: stroke * 5.5, font: base / 34 };
}

export function arrowHead(x1: number, y1: number, x2: number, y2: number, size: number): [number, number][] {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const spread = 0.42;
  return [
    [x2, y2],
    [x2 - size * Math.cos(angle - spread), y2 - size * Math.sin(angle - spread)],
    [x2 - size * Math.cos(angle + spread), y2 - size * Math.sin(angle + spread)],
  ];
}

/** Drop points that are too close together to matter, to keep freehand strokes small. */
export function simplify(points: number[], minDist = 0.003): number[] {
  if (points.length <= 4) return points;
  const out = [points[0], points[1]];
  for (let i = 2; i < points.length - 2; i += 2) {
    const dx = points[i] - out[out.length - 2];
    const dy = points[i + 1] - out[out.length - 1];
    if (dx * dx + dy * dy >= minDist * minDist) out.push(points[i], points[i + 1]);
  }
  out.push(points[points.length - 2], points[points.length - 1]);
  return out;
}

/** True when a mark is too small to have been meant (a stray click). */
export function isTrivial(a: Annotation): boolean {
  switch (a.kind) {
    case 'ellipse':
      return a.rx < 0.006 && a.ry < 0.006;
    case 'arrow':
      return Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 0.012;
    case 'pen':
      return a.points.length < 6;
    case 'text':
      return !a.text.trim();
  }
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Paint marks onto a canvas that already holds the photo at width × height. */
export function drawAnnotations(ctx: Ctx, annotations: Annotation[], width: number, height: number): void {
  const m = metrics(width, height);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const X = (v: number) => v * width;
  const Y = (v: number) => v * height;

  // Each mark is drawn twice: a dark halo first, so it reads on any background.
  for (const pass of ['halo', 'ink'] as const) {
    for (const a of annotations) {
      const color = pass === 'halo' ? 'rgba(0, 0, 0, 0.55)' : a.color;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = pass === 'halo' ? m.halo : m.stroke;
      switch (a.kind) {
        case 'ellipse':
          ctx.beginPath();
          ctx.ellipse(X(a.cx), Y(a.cy), Math.max(1, X(a.rx)), Math.max(1, Y(a.ry)), 0, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 'arrow': {
          const [x1, y1, x2, y2] = [X(a.x1), Y(a.y1), X(a.x2), Y(a.y2)];
          const head = arrowHead(x1, y1, x2, y2, m.head);
          // Stop the shaft at the base of the head so the tip stays sharp.
          const bx = (head[1][0] + head[2][0]) / 2;
          const by = (head[1][1] + head[2][1]) / 2;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(bx, by);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(head[0][0], head[0][1]);
          ctx.lineTo(head[1][0], head[1][1]);
          ctx.lineTo(head[2][0], head[2][1]);
          ctx.closePath();
          if (pass === 'halo') ctx.stroke();
          ctx.fill();
          break;
        }
        case 'pen':
          ctx.beginPath();
          for (let i = 0; i < a.points.length; i += 2) {
            if (i === 0) ctx.moveTo(X(a.points[i]), Y(a.points[i + 1]));
            else ctx.lineTo(X(a.points[i]), Y(a.points[i + 1]));
          }
          ctx.stroke();
          break;
        case 'text':
          ctx.font = `600 ${m.font}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
          ctx.textBaseline = 'middle';
          if (pass === 'halo') {
            ctx.lineWidth = m.font / 5;
            ctx.strokeText(a.text, X(a.x), Y(a.y));
          } else {
            ctx.fillText(a.text, X(a.x), Y(a.y));
          }
          break;
      }
    }
  }
  ctx.restore();
}

/** A copy of the photo with its marks burned in, for the archive, downloads and export. */
export async function renderAnnotated(photo: Blob, annotations: Annotation[], mime: string, quality = 0.92): Promise<Blob> {
  const bitmap = await createImageBitmap(photo);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    ctx.drawImage(bitmap, 0, 0);
    drawAnnotations(ctx, annotations, bitmap.width, bitmap.height);
    const type = /^image\/(webp|jpeg|png)$/.test(mime) ? mime : 'image/jpeg';
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not render the annotated copy'))), type, type === 'image/png' ? undefined : quality),
    );
  } finally {
    bitmap.close();
  }
}

/** "H100234_20261103_143205_OD.webp" → "H100234_20261103_143205_OD_annotated.webp" */
export function annotatedName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? `${fileName}_annotated` : `${fileName.slice(0, dot)}_annotated${fileName.slice(dot)}`;
}
