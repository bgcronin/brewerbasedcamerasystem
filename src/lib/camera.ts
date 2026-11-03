/** Live camera access through the browser (UVC / DirectShow / Media Foundation devices). */

export interface VideoDevice {
  deviceId: string;
  label: string;
  kind: CameraKind;
}

export type CameraKind = 'cso' | 'canon' | 'capture' | 'generic';

export function classifyDevice(label: string): CameraKind {
  if (/mizar|\bcso\b|phoenix/i.test(label)) return 'cso';
  if (/\beos\b|canon/i.test(label)) return 'canon';
  if (/cam ?link|capture|hdmi|elgato|magewell|avermedia|usb3?\.?0? video|uvc/i.test(label)) return 'capture';
  return 'generic';
}

export function kindLabel(kind: CameraKind): string {
  return {
    cso: 'Slit lamp camera',
    canon: 'Canon EOS live view',
    capture: 'HDMI capture',
    generic: 'Camera',
  }[kind];
}

export const mediaSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

export async function listVideoDevices(): Promise<VideoDevice[]> {
  if (!mediaSupported) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => {
      const label = d.label || `Camera ${i + 1}`;
      return { deviceId: d.deviceId, label, kind: classifyDevice(label) };
    });
}

/** Device labels are hidden until the user has granted camera access once. */
export async function ensureCameraPermission(): Promise<void> {
  const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  s.getTracks().forEach((t) => t.stop());
}

export async function openCamera(deviceId: string | undefined, resolution: string): Promise<MediaStream> {
  const [w, h] = resolution === 'auto' ? [4096, 3072] : resolution.split('x').map(Number);
  const video: MediaTrackConstraints = {
    width: { ideal: w },
    height: { ideal: h },
    frameRate: { ideal: 30 },
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });

  // Some drivers ignore "ideal"; push the track to its true maximum when asked for auto.
  if (resolution === 'auto') {
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.();
    const s = track.getSettings();
    if (caps?.width?.max && caps?.height?.max && (s.width ?? 0) < caps.width.max) {
      try {
        await track.applyConstraints({ width: { ideal: caps.width.max }, height: { ideal: caps.height.max }, frameRate: { ideal: 30 } });
      } catch {
        /* keep what we have */
      }
    }
  }
  return stream;
}

export interface StreamInfo {
  width: number;
  height: number;
  frameRate?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export function streamInfo(stream: MediaStream): StreamInfo | null {
  const track = stream.getVideoTracks()[0];
  if (!track) return null;
  const s = track.getSettings();
  const c = track.getCapabilities?.();
  return {
    width: s.width ?? 0,
    height: s.height ?? 0,
    frameRate: s.frameRate ? Math.round(s.frameRate) : undefined,
    maxWidth: c?.width?.max,
    maxHeight: c?.height?.max,
  };
}

export function describeCameraError(e: unknown): string {
  const name = (e as DOMException)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow the camera for this site in the browser’s address bar, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'That camera isn’t connected. Check the USB cable, then refresh the camera list.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is busy in another program (e.g. CSO Phoenix or EOS Utility live view). Close it and try again.';
    default:
      return (e as Error)?.message || 'The camera could not be started.';
  }
}
