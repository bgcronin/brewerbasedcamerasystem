import { importerFor } from '../lib/importers';
import { useCamera } from './camera';
import {
  captureFromLive,
  importFiles,
  openSheet,
  selectAdjacent,
  setEye,
  setTechnique,
  setView,
  toast,
  updateSettings,
  useApp,
} from './store';
import { TECHNIQUES } from '../lib/types';

/** Shared by the shutter button, the keyboard and foot pedals. */
export function shutter(): void {
  const s = useApp.getState();
  if (s.settings.source === 'tether') {
    toast({ message: 'Use the shutter on the Canon', detail: 'In tethered mode each photo arrives automatically from EOS Utility.' });
    return;
  }
  const cam = useCamera.getState();
  if (cam.status !== 'live') {
    toast({ tone: 'warning', message: 'The camera isn’t connected', detail: 'Choose a camera from the bottom-left of the live view.' });
    return;
  }
  void captureFromLive(() => cam.grab(), cam.deviceLabel);
}

export function focusSearch(): void {
  document.querySelector<HTMLInputElement>('#worklist-search')?.focus();
}

export function toggleStageFullscreen(): void {
  const el = document.querySelector<HTMLElement>('.stage');
  if (!el) return;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void el.requestFullscreen?.().catch(() => undefined);
}

export async function openFileForImport(file: File): Promise<void> {
  const importer = importerFor(file);
  if (!importer) {
    toast({ tone: 'warning', message: 'That file type can’t be imported', detail: 'Use a CSV, TSV or JSON list.' });
    return;
  }
  try {
    const result = await importer.read(file);
    openSheet({ type: 'import', result });
  } catch (e) {
    toast({ tone: 'error', message: 'Couldn’t read that file', detail: (e as Error).message });
  }
}

export async function handleDroppedFiles(files: File[]): Promise<void> {
  const list = files.filter((f) => importerFor(f));
  const images = files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f.name) || /^image\//.test(f.type));
  if (list.length) await openFileForImport(list[0]);
  else if (images.length) await importFiles(images);
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el?.closest?.('input, textarea, select, [contenteditable="true"]');
}

export function onGlobalKeyDown(e: KeyboardEvent): void {
  const s = useApp.getState();
  if (document.querySelector('[data-modal]') || s.lightbox || s.compare) return;
  if (isTyping(e.target)) {
    if (e.key === 'Escape') (e.target as HTMLElement).blur();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    focusSearch();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (s.settings.captureKeys.includes(e.code)) {
    e.preventDefault();
    if (!e.repeat && s.view === 'capture') shutter();
    return;
  }

  const key = e.key.toLowerCase();
  const n = Number(e.key);
  if (n >= 1 && n <= TECHNIQUES.length) {
    const id = TECHNIQUES[n - 1].id;
    setTechnique(s.technique === id ? null : id);
    return;
  }
  switch (key) {
    case 'r':
      setEye('OD');
      break;
    case 'l':
      setEye('OS');
      break;
    case 'b':
      setEye('OU');
      break;
    case '0':
      setTechnique(null);
      break;
    case 'arrowdown':
    case 'j':
      e.preventDefault();
      selectAdjacent(1);
      break;
    case 'arrowup':
    case 'k':
      e.preventDefault();
      selectAdjacent(-1);
      break;
    case 'g':
      void updateSettings({ reticle: !s.settings.reticle });
      break;
    case 'v':
      setView(s.view === 'capture' ? 'review' : 'capture');
      break;
    case 'f':
      if (s.view === 'capture') toggleStageFullscreen();
      break;
    case '/':
      e.preventDefault();
      focusSearch();
      break;
    case '?':
      openSheet({ type: 'shortcuts' });
      break;
  }
}

/** Stop Space from also "clicking" whichever button has focus. */
export function onGlobalKeyUp(e: KeyboardEvent): void {
  const s = useApp.getState();
  if (document.querySelector('[data-modal]') || isTyping(e.target)) return;
  if (s.settings.captureKeys.includes(e.code)) e.preventDefault();
}
