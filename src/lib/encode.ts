import { renderAndEncode, type EncodeRequest, type EncodeResult } from './encodeCore';

/**
 * Encodes off the main thread so the live view never stutters, even when a
 * 30-megapixel Canon frame is being converted to WebP.
 */
let worker: Worker | null = null;
let workerBroken = false;
let nextJob = 1;
const jobs = new Map<number, { resolve: (r: EncodeResult) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (workerBroken || typeof OffscreenCanvas === 'undefined') return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('../workers/encoder.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const { jobId, ok, result, error } = e.data;
        const job = jobs.get(jobId);
        if (!job) return;
        jobs.delete(jobId);
        if (ok) job.resolve(result);
        else job.reject(new Error(error));
      };
      worker.onerror = () => {
        workerBroken = true;
        for (const j of jobs.values()) j.reject(new Error('Encoder worker failed'));
        jobs.clear();
        worker = null;
      };
    } catch {
      workerBroken = true;
      return null;
    }
  }
  return worker;
}

/** Load the worker at start-up, so the first capture never waits on it (or finds its script missing after an update). */
export function warmEncoder(): void {
  getWorker();
}

function encodeOnMainThread(req: EncodeRequest): Promise<EncodeResult> {
  return renderAndEncode(req, (width, height) => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }).finally(() => req.bitmap.close());
}

/**
 * @param original  the source file, when there is one: lets the main thread redo the job if the worker dies,
 *                  because the bitmap itself is handed over to the worker and can't be recovered.
 */
export async function encodeBitmap(req: EncodeRequest, original?: Blob): Promise<EncodeResult> {
  const w = getWorker();
  if (!w) return encodeOnMainThread(req);
  try {
    return await new Promise<EncodeResult>((resolve, reject) => {
      const jobId = nextJob++;
      jobs.set(jobId, { resolve, reject });
      w.postMessage({ ...req, jobId }, [req.bitmap]);
    });
  } catch (e) {
    if (!original) throw e;
    return encodeOnMainThread({ ...req, bitmap: await createImageBitmap(original) });
  }
}
