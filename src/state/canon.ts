/**
 * Canon EOS "direct" source: talks to Lumen Camera Link (helper/) on this
 * computer, which drives the camera through Canon's EDSDK.
 */
import { create } from 'zustand';
import { playShutter } from '../lib/sound';
import { displayName } from '../lib/names';
import { techniqueLabel, type CameraValues, type Eye, type Patient } from '../lib/types';
import { holdPhoto, ingest, setTechnique, toast, transformFor, updateSettings, useApp } from './store';

export type LinkStatus = 'off' | 'connecting' | 'online' | 'offline';

export interface CanonProp {
  value: string | null;
  options?: string[];
  writable?: boolean;
}

export interface CanonCamera {
  state: 'starting' | 'searching' | 'connected' | 'error' | 'unavailable';
  model?: string;
  serial?: string;
  message?: string;
}

export interface CanonProps {
  mode?: { value: string };
  iso?: CanonProp;
  tv?: CanonProp;
  av?: CanonProp;
  wb?: CanonProp;
  battery?: { value: number | 'AC' | null };
  shots?: { value: number | null };
  lens?: { value: string };
}

interface CanonState {
  link: LinkStatus;
  helper?: { version?: string; backend?: string; sdkVersion?: string; sdkGeneration?: number };
  camera: CanonCamera | null;
  props: CanonProps;
  liveView: boolean;
  liveViewError?: string;
  frameSize: { w: number; h: number } | null;
  pendingSets: number;
}

export const useCanon = create<CanonState>(() => ({
  link: 'off',
  camera: null,
  props: {},
  liveView: false,
  frameSize: null,
  pendingSets: 0,
}));

export const EXPOSURE_KEYS = ['iso', 'tv', 'av', 'wb'] as const;
export type ExposureKey = (typeof EXPOSURE_KEYS)[number];
export const EXPOSURE_LABELS: Record<ExposureKey, string> = { iso: 'ISO', tv: 'Shutter', av: 'Aperture', wb: 'White balance' };

/* ───────── connection ───────── */

let ws: WebSocket | null = null;
let wanted = false;
let wantLiveView = false;
let retry: number | undefined;
let retryDelay = 1000;
let nextId = 1;
const pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: number; sock: WebSocket }>();

/** A socket has closed or been replaced: its unanswered requests fail now, not at their timeout. */
function settleRequests(sock: WebSocket, why: string): void {
  for (const [id, p] of pending) {
    if (p.sock !== sock) continue;
    pending.delete(id);
    window.clearTimeout(p.timer);
    p.reject(new Error(why));
  }
}

/** Let go of the current socket (to stop, or to open a fresh one). */
function dropSocket(why: string): void {
  const old = ws;
  ws = null;
  if (!old) return;
  settleRequests(old, why);
  old.close();
}

export function linkUrl(): string {
  const custom = useApp.getState().settings.cameraLinkUrl.trim();
  if (custom) return custom;
  // When Lumen is served by the helper itself, talk to the same address.
  if (location.port === '47800') return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/camera`;
  return 'ws://127.0.0.1:47800/camera';
}

/**
 * True in a window that is not the working Lumen window (another one holds the lock, or took over).
 * Such a window must stay off the camera: two windows on the link is how photos get misfiled.
 */
function isSecondary(s: unknown = useApp.getState()): boolean {
  return !!(s as { secondary?: boolean }).secondary;
}

export function startLink(): void {
  if (isSecondary()) return;
  wanted = true;
  connect();
}

export function stopLink(): void {
  wanted = false;
  window.clearTimeout(retry);
  dropSocket('The link to Lumen Camera Link was switched off.');
  useCanon.setState({ link: 'off', liveView: false });
}

/** "Try again": ask the helper to re-open the camera if it's reachable, otherwise re-open the link itself. */
export function reconnectLink(): void {
  const c = useCanon.getState();
  if (c.link === 'online' && ws?.readyState === WebSocket.OPEN) {
    void request('reconnect').catch(() => undefined);
    return;
  }
  dropSocket('The link to Lumen Camera Link was restarted.');
  retryDelay = 1000;
  window.clearTimeout(retry);
  connect();
}

function connect() {
  if (ws || !wanted) return;
  useCanon.setState({ link: 'connecting' });
  let sock: WebSocket;
  try {
    sock = new WebSocket(linkUrl());
  } catch {
    scheduleRetry();
    return;
  }
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => {
    retryDelay = 1000;
    useCanon.setState({ link: 'online' });
    reportActive();
    if (wantLiveView) void request('liveview', { on: true }).catch(() => undefined);
  };
  sock.onmessage = (e) => {
    if (typeof e.data === 'string') onText(JSON.parse(e.data));
    else onBinary(e.data as ArrayBuffer);
  };
  sock.onclose = () => {
    settleRequests(sock, 'Lumen Camera Link is not running.');
    if (ws !== sock) return; // an older socket closing late must not disturb the current one
    ws = null;
    useCanon.setState({ link: wanted ? 'offline' : 'off', camera: null, props: {}, liveView: false });
    scheduleRetry();
  };
}

function scheduleRetry() {
  if (!wanted) return;
  window.clearTimeout(retry);
  retry = window.setTimeout(connect, retryDelay);
  retryDelay = Math.min(5000, retryDelay * 1.6);
}

function send(msg: Record<string, unknown>) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function request(type: string, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = ws;
    if (sock?.readyState !== WebSocket.OPEN) {
      reject(new Error('Lumen Camera Link is not running.'));
      return;
    }
    const id = `r${nextId++}`;
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error('The camera did not respond.'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, sock });
    sock.send(JSON.stringify({ type, id, ...payload }));
  });
}

// Photos taken with the camera's own button go to the Lumen window that was looked at last, so each
// window tells the helper whether it is on screen, whether it is in front, and when it last came forward.
// A window restored in the background says so too, and so never takes photos from the one in use.
let lastForwardAt = typeof document !== 'undefined' && document.visibilityState === 'visible' ? Date.now() : 0;

function reportActive(cameForward = false): void {
  if (typeof document === 'undefined') return;
  const visible = document.visibilityState === 'visible';
  if (cameForward && visible) lastForwardAt = Date.now();
  // acks: this build confirms each photo it receives (see onBinary).
  send({ type: 'active', visible, focused: document.hasFocus(), at: lastForwardAt, acks: true });
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => reportActive(true));
  window.addEventListener('blur', () => reportActive());
  document.addEventListener('visibilitychange', () => reportActive(document.visibilityState === 'visible'));
}

/* ───────── incoming ───────── */

function onText(msg: Record<string, unknown>) {
  switch (msg.type) {
    case 'hello':
      useCanon.setState({
        helper: {
          version: msg.version as string,
          backend: msg.backend as string,
          sdkVersion: msg.sdkVersion as string | undefined,
          sdkGeneration: msg.sdkGeneration as number | undefined,
        },
      });
      break;
    case 'camera': {
      const { type: _t, ...camera } = msg;
      void _t;
      const prev = useCanon.getState().camera;
      useCanon.setState({ camera: camera as unknown as CanonCamera, ...(camera.state !== 'connected' ? { props: {}, liveView: false } : {}) });
      // The helper turns live view on for us once the camera appears; only ask again after a reconnect.
      if (camera.state === 'connected' && prev && prev.state !== 'connected' && wantLiveView) void request('liveview', { on: true }).catch(() => undefined);
      break;
    }
    case 'props':
      useCanon.setState({ props: msg.props as CanonProps });
      break;
    case 'liveview':
      useCanon.setState({ liveView: !!msg.on, liveViewError: (msg.error as string) || undefined });
      break;
    case 'result': {
      const p = pending.get(msg.id as string);
      if (!p) return;
      pending.delete(msg.id as string);
      window.clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error((msg.error as string) || 'The camera refused the request.'));
      break;
    }
    case 'capture-failed': {
      const id = msg.requestId as string | undefined;
      if (id && arrived.has(id)) break; // its photo is already filed: nothing failed
      if (id) retireCapture(id);
      toast({ tone: 'error', message: 'Photo not taken', detail: msg.message as string });
      break;
    }
    case 'incoming':
      // The camera's own button was pressed; the photo follows in a moment.
      if (typeof msg.name === 'string') noteBodyShot(msg.name);
      break;
    case 'notice':
      toast({ tone: (msg.tone as 'warning') ?? 'default', message: msg.message as string, detail: msg.detail as string | undefined, duration: 12000 });
      break;
  }
}

type FrameListener = (bmp: ImageBitmap) => void;
const frameListeners = new Set<FrameListener>();
let decoding = false;

/** Live view frames go straight to the canvas, never through React state. */
export function onFrame(fn: FrameListener): () => void {
  frameListeners.add(fn);
  return () => frameListeners.delete(fn);
}

function onBinary(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 1) {
    if (decoding || !frameListeners.size) return; // drop frames rather than fall behind
    decoding = true;
    createImageBitmap(new Blob([bytes.subarray(1)], { type: 'image/jpeg' }))
      .then((bmp) => {
        const size = useCanon.getState().frameSize;
        if (!size || size.w !== bmp.width || size.h !== bmp.height) useCanon.setState({ frameSize: { w: bmp.width, h: bmp.height } });
        for (const fn of frameListeners) fn(bmp);
        bmp.close();
      })
      .catch(() => undefined)
      .finally(() => {
        decoding = false;
      });
    return;
  }
  if (bytes[0] === 2) {
    const view = new DataView(buf);
    const headerLen = view.getUint32(1);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(5, 5 + headerLen))) as PhotoHeader;
    // Tell the helper straight away that the photo is here. Without this it saves its own copy
    // to the Unfiled folder, so that a window which has frozen or closed never costs a photo.
    if (header.photoId) send({ type: 'photo-ack', photoId: header.photoId });
    const data = bytes.subarray(5 + headerLen);
    void onPhoto(header, new Blob([data], { type: 'image/jpeg' }));
  }
}

/* ───────── capture ───────── */

interface Snapshot {
  patient: Patient;
  eye: Eye;
  technique: string | null;
  diagnoses: string[];
}
const captures = new Map<string, Snapshot>();
/** Snapshots of captures that timed out, kept a while in case the photo still turns up. */
const lateCaptures = new Map<string, Snapshot & { failedAt: number }>();
const LATE_GRACE_MS = 90_000;

/** Captures whose photo has arrived, so a late "it failed" for one of them is not shown. */
const arrived = new Set<string>();

function retireCapture(id: string): void {
  const snap = captures.get(id);
  if (!snap) return;
  captures.delete(id);
  lateCaptures.set(id, { ...snap, failedAt: Date.now() });
  for (const [k, v] of lateCaptures) if (Date.now() - v.failedAt > LATE_GRACE_MS) lateCaptures.delete(k);
}

/**
 * Photos taken with the camera's own button (or the slit lamp's release). The helper says one is
 * coming as soon as the camera reports it, about a second before the file itself arrives. What is
 * selected is noted then, so pressing L or moving to the next patient straight after the button
 * doesn't mislabel the photo. `snap` is null when no patient was selected at that moment.
 */
const bodyShots = new Map<string, { snap: Snapshot | null; at: number }>();
const BODY_SHOT_KEEP_MS = 120_000;
/** IMG_0001 for IMG_0001.JPG and IMG_0001.CR2: the two files of one shot share it. */
const shotKey = (name: string) => name.replace(/\.[^.]*$/, '').toUpperCase();

function noteBodyShot(name: string): void {
  const now = Date.now();
  for (const [k, v] of bodyShots) if (now - v.at > BODY_SHOT_KEEP_MS) bodyShots.delete(k);
  const key = shotKey(name);
  if (bodyShots.has(key)) return; // the first word of a shot is the closest to the moment it was taken
  const s = useApp.getState();
  bodyShots.set(key, { snap: s.patient ? { patient: s.patient, eye: s.eye, technique: s.technique, diagnoses: s.diagnoses } : null, at: now });
}

function takeBodyShot(name: string): { snap: Snapshot | null } | undefined {
  const key = shotKey(name);
  const noted = bodyShots.get(key);
  bodyShots.delete(key);
  return noted && Date.now() - noted.at <= BODY_SHOT_KEEP_MS ? noted : undefined;
}

interface PhotoHeader {
  /** Identifies this delivery to the helper, which waits for it to be confirmed. */
  photoId?: string;
  requestId?: string;
  name: string;
  takenAt: number;
  exposure?: CameraValues & { mode?: string };
}

function deviceLabel(): string {
  return useCanon.getState().camera?.model ?? 'Canon EOS';
}

async function onPhoto(h: PhotoHeader, blob: Blob) {
  const file = new File([blob], h.name, { type: 'image/jpeg', lastModified: h.takenAt });
  const label = deviceLabel();
  // If a photo can't be filed (no patient, or storing it failed) it waits in the banner rather than vanish.
  const held = { file, receivedAt: Date.now(), source: 'canon' as const, deviceLabel: label, exposure: h.exposure };
  const snap = h.requestId ? captures.get(h.requestId) : undefined;
  const late = !snap && h.requestId ? lateCaptures.get(h.requestId) : undefined;
  if (h.requestId) {
    captures.delete(h.requestId);
    lateCaptures.delete(h.requestId);
    arrived.add(h.requestId);
    if (arrived.size > 100) arrived.delete(arrived.values().next().value as string);
  }
  // Taken with the camera's own shutter button or remote: what was selected when the camera reported it.
  const noted = h.requestId ? undefined : takeBodyShot(h.name);
  const filed = snap ?? late ?? noted?.snap ?? undefined;
  const fromButton = !snap && !late;
  if (fromButton && noted && !filed) {
    // Nobody was selected when it was taken: it waits for a patient, even if one has been chosen since.
    holdPhoto(held);
    return;
  }
  if (fromButton && !filed && !useApp.getState().patient) {
    holdPhoto(held);
    return;
  }
  if (fromButton) {
    // Lumen's own shutter has already flashed and clicked; this is the first sign of a photo from the camera.
    if (useApp.getState().settings.shutterSound) playShutter();
    useApp.setState((st) => ({ flashTick: st.flashTick + 1 }));
  }
  // With labels noted at the press (from Lumen or the camera), file it exactly as it was labelled then;
  // an older helper sends no notice for the camera's button, and the photo takes the current selection.
  const saved = await ingest(
    {
      original: file,
      source: 'canon',
      deviceLabel: label,
      transform: transformFor(label),
      takenAt: h.takenAt,
      ...(filed
        ? {
            eye: filed.eye,
            technique: filed.technique,
            // If the patient is still on screen, use their labels as they are now; otherwise as they were at the press.
            diagnoses: useApp.getState().activePatientId === filed.patient.id ? undefined : filed.diagnoses,
          }
        : {}),
      exposure: h.exposure,
    },
    filed?.patient,
  );
  if (!saved) {
    holdPhoto(held);
    return;
  }
  if (late) toast({ tone: 'success', message: 'The photo arrived after all', detail: `Filed to ${displayName(late.patient)}, ${late.eye}.`, duration: 7000 });
}

export function canonReady(): boolean {
  const c = useCanon.getState();
  return c.link === 'online' && c.camera?.state === 'connected';
}

export async function canonShutter(): Promise<void> {
  const s = useApp.getState();
  if (!s.patient) {
    toast({ tone: 'warning', message: 'Choose a patient first', detail: 'Pick someone from the list on the left.' });
    return;
  }
  if (!canonReady()) {
    const c = useCanon.getState();
    toast({
      tone: 'warning',
      message: c.link !== 'online' ? 'Lumen Camera Link isn’t running' : 'The Canon isn’t connected',
      detail: c.link !== 'online' ? 'Start it on this computer, then try again.' : c.camera?.message,
    });
    return;
  }
  const id = `cap-${Date.now().toString(36)}-${nextId}`;
  captures.set(id, { patient: s.patient, eye: s.eye, technique: s.technique, diagnoses: s.diagnoses });
  useApp.setState((st) => ({ flashTick: st.flashTick + 1 }));
  if (s.settings.shutterSound) playShutter();
  try {
    await request('capture', { captureId: id }, 15_000);
  } catch (e) {
    // The reply can be lost (the link restarted, the helper was slow) although the photo was taken and filed.
    if (arrived.has(id)) return;
    retireCapture(id);
    toast({ tone: 'error', message: 'Photo not taken', detail: (e as Error).message });
  }
}

/* ───────── settings & presets ───────── */

export function setCanonLiveView(on: boolean): void {
  wantLiveView = on;
  if (useCanon.getState().link === 'online') void request('liveview', { on }).catch(() => undefined);
}

export async function setCanonProp(key: ExposureKey, value: string): Promise<void> {
  useCanon.setState((s) => ({ pendingSets: s.pendingSets + 1 }));
  try {
    await request('set', { prop: key, value });
  } catch (e) {
    toast({ tone: 'warning', message: `${EXPOSURE_LABELS[key]} not changed`, detail: (e as Error).message });
  } finally {
    useCanon.setState((s) => ({ pendingSets: s.pendingSets - 1 }));
  }
}

export function currentValues(): CameraValues {
  const p = useCanon.getState().props;
  const v: CameraValues = {};
  for (const k of EXPOSURE_KEYS) if (p[k]?.value) v[k] = p[k]!.value!;
  return v;
}

export function sameValues(a: CameraValues | undefined, b: CameraValues): boolean {
  if (!a) return false;
  return EXPOSURE_KEYS.every((k) => (a[k] ?? '') === (b[k] ?? ''));
}

export function describeValues(v: CameraValues): string {
  return [v.iso && `ISO ${v.iso}`, v.tv, v.av, v.wb].filter(Boolean).join(', ');
}

export async function savePreset(techniqueId: string): Promise<void> {
  const values = currentValues();
  const presets = { ...useApp.getState().settings.cameraPresets, [techniqueId]: values };
  await updateSettings({ cameraPresets: presets });
  toast({ tone: 'success', message: `${techniqueLabel(techniqueId)} preset saved`, detail: describeValues(values) });
}

export async function removePreset(techniqueId: string): Promise<void> {
  const presets = { ...useApp.getState().settings.cameraPresets };
  delete presets[techniqueId];
  await updateSettings({ cameraPresets: presets });
}

export async function applyPreset(techniqueId: string): Promise<void> {
  const preset = useApp.getState().settings.cameraPresets[techniqueId];
  if (!preset || !canonReady()) return;
  if (sameValues(preset, currentValues())) return;
  useCanon.setState((s) => ({ pendingSets: s.pendingSets + 1 }));
  try {
    const res = (await request('apply', { values: preset }, 15_000)) as { applied?: string[]; skipped?: { prop: string; reason: string }[] };
    const skipped = res.skipped ?? [];
    toast({
      tone: skipped.length ? 'warning' : 'default',
      duration: skipped.length ? 6000 : 2200,
      message: `${techniqueLabel(techniqueId)} preset`,
      detail: skipped.length ? skipped.map((s) => s.reason).filter((r, i, a) => a.indexOf(r) === i).join(' ') : describeValues(preset),
    });
  } catch (e) {
    toast({ tone: 'warning', message: 'Preset not applied', detail: (e as Error).message });
  } finally {
    useCanon.setState((s) => ({ pendingSets: s.pendingSets - 1 }));
  }
}

/** Choosing an illumination technique also dials in its camera preset, if one is saved. */
export function chooseTechnique(id: string | null): void {
  setTechnique(id);
  if (id && useApp.getState().settings.source === 'canon') void applyPreset(id);
}

/* ───────── keep the link in step with the chosen source ───────── */

let lastWanted: boolean | undefined;
useApp.subscribe((s) => {
  if (!s.ready) return;
  // Only the working window talks to the camera; one that becomes secondary lets go of the link.
  const want = s.settings.source === 'canon' && !isSecondary(s);
  if (want === lastWanted) return;
  lastWanted = want;
  if (want) startLink();
  else stopLink();
});
