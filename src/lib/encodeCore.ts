import type { ImageFormat, Transform } from './types';

export interface EncodeRequest {
  bitmap: ImageBitmap;
  transform: Transform;
  format: ImageFormat;
  quality: number;
  thumbSize: number;
  /** Skip encoding the full image (used when keeping a camera original). */
  thumbOnly?: boolean;
}

export interface EncodeResult {
  full?: Blob;
  thumb: Blob;
  width: number;
  height: number;
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

async function toBlob(canvas: AnyCanvas, type: string, quality: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) =>
    (canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed'))), type, quality),
  );
}

/** Encode, falling back to JPEG where the browser can't write the chosen format (e.g. WebP on Safari). */
async function encode(canvas: AnyCanvas, format: ImageFormat, quality: number): Promise<Blob> {
  const blob = await toBlob(canvas, format, quality);
  if (blob.type === format) return blob;
  return toBlob(canvas, 'image/jpeg', quality);
}

function draw(ctx: Ctx, bmp: ImageBitmap, t: Transform, w: number, h: number) {
  const swap = t.rotate === 90 || t.rotate === 270;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((t.rotate * Math.PI) / 180);
  ctx.scale(t.flipH ? -1 : 1, t.flipV ? -1 : 1);
  const dw = swap ? h : w;
  const dh = swap ? w : h;
  ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

export async function renderAndEncode(req: EncodeRequest, makeCanvas: (w: number, h: number) => AnyCanvas): Promise<EncodeResult> {
  const { bitmap: bmp, transform: t } = req;
  const swap = t.rotate === 90 || t.rotate === 270;
  const width = swap ? bmp.height : bmp.width;
  const height = swap ? bmp.width : bmp.height;

  let full: Blob | undefined;
  if (!req.thumbOnly) {
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: false }) as Ctx;
    ctx.imageSmoothingQuality = 'high';
    draw(ctx, bmp, t, width, height);
    full = await encode(canvas, req.format, req.format === 'image/png' ? 1 : req.quality);
  }

  const scale = Math.min(1, req.thumbSize / Math.max(width, height));
  const tw = Math.max(1, Math.round(width * scale));
  const th = Math.max(1, Math.round(height * scale));
  const tc = makeCanvas(tw, th);
  const tctx = tc.getContext('2d', { alpha: false }) as Ctx;
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = 'high';
  draw(tctx, bmp, t, tw, th);
  const thumb = await encode(tc, 'image/webp', 0.82);

  return { full, thumb, width, height };
}
