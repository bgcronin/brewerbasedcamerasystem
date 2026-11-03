/// <reference lib="webworker" />
import { renderAndEncode, type EncodeRequest } from '../lib/encodeCore';

self.onmessage = async (e: MessageEvent<EncodeRequest & { jobId: number }>) => {
  const { jobId, ...req } = e.data;
  try {
    const result = await renderAndEncode(req, (w, h) => new OffscreenCanvas(w, h));
    (self as unknown as Worker).postMessage({ jobId, ok: true, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ jobId, ok: false, error: String((err as Error)?.message ?? err) });
  } finally {
    req.bitmap.close();
  }
};
