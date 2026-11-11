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

/** A photo takes well under a second to encode; a worker silent for this long has hung. */
const JOB_TIMEOUT_MS = 30_000;

/**
 * @param original  the source file, when there is one. With it, the bitmap is handed over to the worker
 *                  (no copy) and the main thread can redo the job from the file if the worker dies.
 *                  Without it (a live frame, which exists nowhere else) the worker is given a copy and
 *                  this thread keeps the bitmap, so a failed or hung worker never costs the photo.
 */
export async function encodeBitmap(req: EncodeRequest, original?: Blob): Promise<EncodeResult> {
  const w = getWorker();
  if (!w) return encodeOnMainThread(req);
  let jobId = 0;
  let timer = 0;
  try {
    const result = await new Promise<EncodeResult>((resolve, reject) => {
      jobId = nextJob++;
      jobs.set(jobId, { resolve, reject });
      timer = window.setTimeout(() => {
        // Start afresh next time: a hung worker would hold up every photo after this one.
        workerBroken = false;
        worker?.terminate();
        worker = null;
        for (const j of jobs.values()) j.reject(new Error('The image encoder stopped responding'));
        jobs.clear();
      }, JOB_TIMEOUT_MS);
      if (original) w.postMessage({ ...req, jobId }, [req.bitmap]);
      else w.postMessage({ ...req, jobId });
    });
    if (!original) req.bitmap.close();
    return result;
  } catch (e) {
    jobs.delete(jobId);
    if (original) return encodeOnMainThread({ ...req, bitmap: await createImageBitmap(original) });
    return encodeOnMainThread(req);
  } finally {
    window.clearTimeout(timer);
  }
}
