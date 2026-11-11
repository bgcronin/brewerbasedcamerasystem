import { importerFor } from '../lib/importers';
import { useCamera } from './camera';
import { canonShutter, chooseTechnique } from './canon';
import {
  captureFromLive,
  importFiles,
  openSheet,
  selectAdjacent,
  setEye,
  setView,
  toast,
  updateSettings,
  useApp,
} from './store';
import { TECHNIQUES } from '../lib/types';

/** Shared by the shutter button, the keyboard and foot pedals. */
export function shutter(): void {
  const s = useApp.getState();
  if (s.settings.source === 'canon') {
    void canonShutter();
    return;
  }
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

/** "/" finds a patient on today's list; in the Library it searches every photograph. */
export function focusSearch(): void {
  const id = useApp.getState().view === 'library' ? '#library-search' : '#worklist-search';
  const el = document.querySelector<HTMLInputElement>(id);
  el?.focus();
  el?.select();
}

/** Ctrl+K from anywhere: open the Library with the cursor in its search box. */
export function openLibrarySearch(): void {
  setView('library');
  window.setTimeout(() => {
    const el = document.querySelector<HTMLInputElement>('#library-search');
    el?.focus();
    el?.select();
  }, 0);
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
  // Reading a scan can take a few seconds, so show progress in the sheet rather than a blank wait.
  openSheet({ type: 'import', reading: { name: file.name, label: 'Opening' } });
  try {
    const result = await importer.read(file, (p) => {
      const s = useApp.getState().sheet;
      if (s?.type === 'import' && s.reading) openSheet({ type: 'import', reading: { name: file.name, ...p } });
    });
    if (useApp.getState().sheet?.type !== 'import') return; // closed while reading
    openSheet({ type: 'import', result });
  } catch (e) {
    openSheet({ type: 'import' });
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
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openLibrarySearch();
    return;
  }
  if (isTyping(e.target)) {
    if (e.key === 'Escape') (e.target as HTMLElement).blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const capturing = s.view === 'capture';
  if (s.settings.captureKeys.includes(e.code)) {
    e.preventDefault();
    if (!e.repeat && capturing) shutter();
    return;
  }
  // Holding a key must not toggle things repeatedly (arrow keys may repeat to scroll the list).
  const arrow = e.key === 'ArrowUp' || e.key === 'ArrowDown';
  if (e.repeat && !arrow) return;

  const key = e.key.toLowerCase();
  // The labelling keys only act where their controls are on screen, so nothing changes unseen.
  if (capturing) {
    const digit = e.code.match(/^(?:Digit|Numpad)([1-9])$/);
    const n = digit ? Number(digit[1]) : NaN;
    if (n >= 1 && n <= TECHNIQUES.length) {
      const id = TECHNIQUES[n - 1].id;
      chooseTechnique(s.technique === id ? null : id);
      return;
    }
    if (e.code === 'Digit0' || e.code === 'Numpad0') {
      chooseTechnique(null);
      return;
    }
    switch (key) {
      case 'r':
        setEye('OD');
        return;
      case 'l':
        setEye('OS');
        return;
      case 'b':
        setEye('OU');
        return;
      case 'g':
        void updateSettings({ reticle: !s.settings.reticle });
        return;
      case 'f':
        toggleStageFullscreen();
        return;
      case 'd':
        e.preventDefault();
        document.querySelector<HTMLInputElement>('#dx-input')?.focus();
        return;
    }
  }
  switch (key) {
    case 'arrowdown':
    case 'j':
      if (s.view === 'library') break;
      e.preventDefault();
      selectAdjacent(1);
      break;
    case 'arrowup':
    case 'k':
      if (s.view === 'library') break;
      e.preventDefault();
      selectAdjacent(-1);
      break;
    case 'v':
      setView(s.view === 'capture' ? 'review' : 'capture');
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
  if (document.querySelector('[data-modal]') || s.lightbox || s.compare || isTyping(e.target)) return;
  if (s.settings.captureKeys.includes(e.code)) e.preventDefault();
}
