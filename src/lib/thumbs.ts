import { useEffect, useState } from 'react';
import { getImage } from './db';

/** Object-URL cache for thumbnails so lists scroll smoothly and never re-read IndexedDB. */
const urls = new Map<string, string>();
const loading = new Map<string, Promise<string | null>>();

export function primeThumb(id: string, blob: Blob): string {
  const existing = urls.get(id);
  if (existing) return existing;
  const url = URL.createObjectURL(blob);
  urls.set(id, url);
  return url;
}

export function forgetThumb(id: string): void {
  const url = urls.get(id);
  if (url) URL.revokeObjectURL(url);
  urls.delete(id);
}

export function loadThumb(id: string): Promise<string | null> {
  const cached = urls.get(id);
  if (cached) return Promise.resolve(cached);
  let p = loading.get(id);
  if (!p) {
    p = getImage(id)
      .then((img) => (img ? primeThumb(id, img.thumb) : null))
      .finally(() => loading.delete(id));
    loading.set(id, p);
  }
  return p;
}

export function useThumb(id: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() => (id ? urls.get(id) ?? null : null));
  useEffect(() => {
    if (!id) {
      setUrl(null);
      return;
    }
    let alive = true;
    const cached = urls.get(id);
    if (cached) setUrl(cached);
    else void loadThumb(id).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [id]);
  return url;
}

/** Full-resolution image for viewing; the URL is released when the viewer moves on. */
export function useFullImage(id: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) {
      setUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
      return;
    }
    let alive = true;
    void getImage(id).then((img) => {
      if (!alive || !img) return;
      const made = URL.createObjectURL(img.full);
      // Swap only once the new image exists, so stepping between photos never shows a blank.
      setUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return made;
      });
    });
    return () => {
      alive = false;
    };
  }, [id]);
  useEffect(() => () => setUrl((old) => (old && URL.revokeObjectURL(old), null)), []);
  return url;
}
