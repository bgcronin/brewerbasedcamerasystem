import { create } from 'zustand';
import {
  describeCameraError,
  ensureCameraPermission,
  listVideoDevices,
  mediaSupported,
  openCamera,
  streamInfo,
  type StreamInfo,
  type VideoDevice,
} from '../lib/camera';

type Status = 'idle' | 'starting' | 'live' | 'error' | 'unsupported';

interface CameraState {
  devices: VideoDevice[];
  status: Status;
  error?: string;
  stream: MediaStream | null;
  deviceId?: string;
  deviceLabel?: string;
  info: StreamInfo | null;
  video: HTMLVideoElement | null;
  /** The device we should reconnect to if it's unplugged and comes back. */
  wantedDeviceId?: string;
  setVideo(el: HTMLVideoElement | null): void;
  refreshDevices(): Promise<VideoDevice[]>;
  start(deviceId?: string, resolution?: string): Promise<boolean>;
  stop(): void;
  grab(): Promise<ImageBitmap>;
}

let lastResolution = 'auto';
let startGeneration = 0;

export const useCamera = create<CameraState>((set, get) => ({
  devices: [],
  status: mediaSupported ? 'idle' : 'unsupported',
  stream: null,
  info: null,
  video: null,

  setVideo(el) {
    set({ video: el });
    const { stream } = get();
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream;
      void el.play().catch(() => undefined);
    }
  },

  async refreshDevices() {
    if (!mediaSupported) return [];
    try {
      let devices = await listVideoDevices();
      if (devices.length && devices.every((d) => !d.deviceId || d.label.startsWith('Camera '))) {
        await ensureCameraPermission();
        devices = await listVideoDevices();
      }
      set({ devices });
      return devices;
    } catch (e) {
      set({ error: describeCameraError(e) });
      return [];
    }
  },

  async start(deviceId, resolution = lastResolution) {
    if (!mediaSupported) {
      set({ status: 'unsupported' });
      return false;
    }
    lastResolution = resolution;
    const generation = ++startGeneration;
    get().stop();
    set({ status: 'starting', error: undefined, wantedDeviceId: deviceId });
    try {
      const stream = await openCamera(deviceId, resolution);
      if (generation !== startGeneration) {
        // A newer start() won; release this stream so the device isn't left busy.
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      track.addEventListener('ended', () => {
        if (get().stream !== stream) return;
        set({ status: 'error', error: 'The camera was disconnected. Reconnect the cable — Lumen will pick it up again automatically.', stream: null, info: null });
      });
      const devices = await listVideoDevices();
      const dev = devices.find((d) => d.deviceId === settings.deviceId);
      set({
        stream,
        status: 'live',
        devices,
        deviceId: settings.deviceId ?? deviceId,
        deviceLabel: dev?.label ?? track.label,
        wantedDeviceId: settings.deviceId ?? deviceId,
        info: streamInfo(stream),
      });
      const v = get().video;
      if (v) {
        v.srcObject = stream;
        void v.play().catch(() => undefined);
      }
      return true;
    } catch (e) {
      if (generation === startGeneration) set({ status: 'error', error: describeCameraError(e), stream: null, info: null });
      return false;
    }
  },

  stop() {
    const { stream, video } = get();
    stream?.getTracks().forEach((t) => t.stop());
    if (video) video.srcObject = null;
    set({ stream: null, info: null, status: mediaSupported ? 'idle' : 'unsupported' });
  },

  async grab() {
    const { video, status } = get();
    if (!video || status !== 'live' || !video.videoWidth) throw new Error('The camera isn’t ready yet.');
    return createImageBitmap(video);
  },
}));

// Reconnect automatically when a camera is plugged back in.
if (mediaSupported) {
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    const st = useCamera.getState();
    const devices = await listVideoDevices();
    useCamera.setState({ devices });
    if (st.status === 'error' && st.wantedDeviceId && devices.some((d) => d.deviceId === st.wantedDeviceId)) {
      void st.start(st.wantedDeviceId);
    }
  });
}

/** Read the camera's info again once video metadata arrives (some drivers report late). */
export function refreshStreamInfo(): void {
  const { stream } = useCamera.getState();
  if (stream) useCamera.setState({ info: streamInfo(stream) });
}
