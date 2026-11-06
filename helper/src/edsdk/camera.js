// Canon EOS control through EDSDK: connection, settings, live view, capture.
import { EventEmitter } from 'node:events';
import koffi from 'koffi';
import {
  CameraCommand,
  EdsError,
  Err,
  EvfOutputDevice,
  ObjectEvent,
  PropertyEvent,
  PropID,
  SaveTo,
  ShutterButton,
  StateEvent,
} from './constants.js';
import { check, loadEdsdk, makeRunLoopPump } from './binding.js';
import { codeFor, labelFor, optionsFor, writableInMode } from './values.js';

const EXPOSURE_PROPS = { iso: PropID.ISOSpeed, tv: PropID.Tv, av: PropID.Av, wb: PropID.WhiteBalance };
const BUSY = new Set([Err.DEVICE_BUSY, Err.PTP_DEVICE_BUSY, Err.OBJECT_NOTREADY]);
const GONE = new Set([Err.COMM_DISCONNECTED, Err.DEVICE_NOT_FOUND, Err.DEVICE_INVALID, Err.SESSION_NOT_OPEN]);
const RAW = /\.(cr2|cr3|crw)$/i;
const CAPTURE_TIMEOUT_MS = 20_000;
// A photo belongs to a Lumen capture only if it arrives this soon after the shutter fired.
const MATCH_WINDOW_MS = 8000;
// In RAW+JPEG the JPEG follows the RAW in the same burst; after this long we assume RAW only.
const JPEG_AFTER_RAW_MS = 3000;
const RAW_ONLY_MESSAGE = 'The camera is set to RAW only, and RAW files can’t be shown in a browser. Set image quality to JPEG or RAW+JPEG.';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export class EdsdkBackend extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.sdk     result of locateSdk()
   * @param {'both'|'host'} [opts.saveTo]  'both' keeps a copy on the memory card as a backup
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ sdk, saveTo = 'both', log = () => {} }) {
    super();
    this.sdk = sdk;
    this.saveTo = saveTo;
    this.log = log;
    this.camera = null;
    this.state = { state: 'starting' };
    this.props = {};
    this.descCodes = {};
    this.liveView = false;
    this.pendingCaptures = [];
    this.transferQueue = [];
    this.propsDirty = false;
    this.timers = [];
    this.handlers = [];
    this.busyDepth = 0;
    this.rawTimer = null;
  }

  /** True while a settings write, shutter press or download is in progress. */
  get busy() {
    return this.busyDepth > 0;
  }

  async withBusy(fn) {
    this.busyDepth++;
    try {
      return await fn();
    } finally {
      this.busyDepth--;
    }
  }

  get name() {
    return 'edsdk';
  }

  info() {
    return { backend: 'edsdk', sdkVersion: this.sdk.version, sdkGeneration: this.sdk.generation, sdkPath: this.sdk.libPath };
  }

  start() {
    const { api, types } = loadEdsdk(this.sdk);
    this.api = api;
    this.types = types;
    check(api.EdsInitializeSDK(), 'EdsInitializeSDK');
    for (const w of this.sdk.warnings ?? []) this.log(`warning: ${w}`);
    this.pumpRunLoop = makeRunLoopPump();

    this.every(40, () => this.pump());
    this.every(2000, () => {
      if (!this.camera) this.tryConnect();
    });
    this.every(45_000, () => {
      if (this.camera) this.api.EdsSendCommand(this.camera, CameraCommand.ExtendShutDownTimer, 0);
    });
    this.every(1500, () => {
      if (this.camera && !this.busy) this.refreshProps();
    });
    this.setState({ state: 'searching', message: 'Connect the Canon by USB and switch it on.' });
    this.tryConnect();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    try {
      if (this.camera) this.setLiveViewNow(false);
    } catch {
      /* shutting down anyway */
    }
    this.releaseCamera();
    this.failPending('Lumen Camera Link was stopped.');
    clearTimeout(this.rawTimer);
    this.rawTimer = null;
    try {
      this.api?.EdsTerminateSDK();
    } catch {
      /* ignore */
    }
  }

  every(ms, fn) {
    this.timers.push(
      setInterval(() => {
        try {
          fn();
        } catch (e) {
          this.handleError(e, 'background');
        }
      }, ms),
    );
  }

  setState(s) {
    this.state = s;
    this.emit('camera', s);
  }

  /* ───────── connection ───────── */

  tryConnect() {
    const { api } = this;
    const listOut = [null];
    if ((api.EdsGetCameraList(listOut) >>> 0) !== Err.OK) return;
    const list = listOut[0];
    try {
      const count = [0];
      check(api.EdsGetChildCount(list, count), 'EdsGetChildCount');
      if (!count[0]) {
        if (this.state.state !== 'searching') this.setState({ state: 'searching', message: 'Connect the Canon by USB and switch it on.' });
        return;
      }
      const camOut = [null];
      check(api.EdsGetChildAtIndex(list, 0, camOut), 'EdsGetChildAtIndex');
      const cam = camOut[0];
      const info = {};
      api.EdsGetDeviceInfo(cam, info);
      const err = api.EdsOpenSession(cam) >>> 0;
      if (err !== Err.OK && err !== Err.SESSION_ALREADY_OPEN) {
        api.EdsRelease(cam);
        const e = new EdsError(err, 'EdsOpenSession');
        this.setState({ state: 'error', message: e.message, model: info.szDeviceDescription });
        return;
      }
      this.camera = cam;
      try {
        this.configure();
        const model = this.readString(PropID.ProductName) || info.szDeviceDescription || 'Canon EOS';
        this.setState({
          state: 'connected',
          model,
          serial: this.readString(PropID.BodyIDEx) || undefined,
          firmware: this.readString(PropID.FirmwareVersion) || undefined,
        });
        this.log(`connected to ${model}`);
        this.refreshProps(true);
        if (this.liveView) this.setLiveViewNow(true);
      } catch (e) {
        // Never keep a half-configured camera; the 2 s timer retries from scratch.
        this.releaseCamera();
        this.log(`connect: ${e?.message ?? e}`);
        if (GONE.has(e?.code)) this.setState({ state: 'searching', message: 'The camera was disconnected.' });
        else this.setState({ state: 'error', message: e?.message ?? String(e), model: info.szDeviceDescription });
      }
    } catch (e) {
      this.handleError(e, 'connect');
    } finally {
      api.EdsRelease(list);
    }
  }

  configure() {
    const { api, types } = this;
    // Handlers are kept locally until everything succeeds, so a failed attempt leaks nothing.
    const handlers = [];
    const register = (fn, proto) => {
      const h = koffi.register(fn, koffi.pointer(proto));
      handlers.push(h);
      return h;
    };
    try {
      const onObject = register((event, ref) => {
        if (event === ObjectEvent.DirItemRequestTransfer && ref) this.transferQueue.push(ref);
        else if (ref) this.api.EdsRelease(ref);
        return Err.OK;
      }, types.ObjectHandler);
      const onProperty = register((event, propId) => {
        if (event === PropertyEvent.PropertyChanged || event === PropertyEvent.PropertyDescChanged) {
          if (Object.values(EXPOSURE_PROPS).includes(propId) || propId === PropID.AEMode || propId === PropID.AEModeSelect || propId === PropID.BatteryLevel) {
            this.propsDirty = true;
          }
        }
        return Err.OK;
      }, types.PropertyHandler);
      const onState = register((event) => {
        if (event === StateEvent.Shutdown) setImmediate(() => this.disconnect('The camera was switched off or unplugged.'));
        if (event === StateEvent.WillSoonShutDown && this.camera) this.api.EdsSendCommand(this.camera, CameraCommand.ExtendShutDownTimer, 0);
        if (event === StateEvent.CaptureError) setImmediate(() => this.failPending('The camera could not take the picture.'));
        return Err.OK;
      }, types.StateHandler);
      check(api.EdsSetObjectEventHandler(this.camera, ObjectEvent.All, onObject, null), 'EdsSetObjectEventHandler');
      check(api.EdsSetPropertyEventHandler(this.camera, PropertyEvent.All, onProperty, null), 'EdsSetPropertyEventHandler');
      check(api.EdsSetCameraStateEventHandler(this.camera, StateEvent.All, onState, null), 'EdsSetCameraStateEventHandler');
      this.setSaveTo(this.saveTo);
    } catch (e) {
      for (const h of handlers) koffi.unregister(h);
      throw e;
    }
    this.handlers.push(...handlers);
  }

  /** Photos come to the computer; 'both' also keeps them on the card as a backup. */
  setSaveTo(mode) {
    const value = mode === 'host' ? SaveTo.Host : SaveTo.Both;
    let err = this.writeUInt32(PropID.SaveTo, value);
    if (err !== Err.OK && value === SaveTo.Both) {
      err = this.writeUInt32(PropID.SaveTo, SaveTo.Host);
      mode = 'host';
    }
    check(err, 'set SaveTo');
    this.saveTo = mode;
    // Tell the camera the computer has plenty of room.
    check(this.api.EdsSetCapacity(this.camera, { numberOfFreeClusters: 0x7fffffff, bytesPerSector: 0x1000, reset: 1 }), 'EdsSetCapacity');
  }

  /** Close the session, drop the camera ref and free the event handlers registered for it. */
  releaseCamera() {
    const cam = this.camera;
    this.camera = null;
    if (cam) {
      try {
        this.api.EdsCloseSession(cam);
        this.api.EdsRelease(cam);
      } catch {
        /* already gone */
      }
    }
    for (const h of this.handlers) koffi.unregister(h);
    this.handlers = [];
  }

  disconnect(message) {
    if (!this.camera) return;
    this.releaseCamera();
    this.props = {};
    this.failPending(message);
    this.emit('liveview', { on: false });
    this.setState({ state: 'searching', message: message ?? 'Connect the Canon by USB and switch it on.' });
  }

  handleError(e, where) {
    const code = e?.code;
    if (code != null && GONE.has(code)) {
      this.disconnect('The camera was disconnected.');
      return;
    }
    this.log(`${where}: ${e?.message ?? e}`);
  }

  /* ───────── event pump ───────── */

  pump() {
    this.api.EdsGetEvent?.();
    this.pumpRunLoop();
    if (this.transferQueue.length && !this.busy) void this.processTransfers();
    if (this.propsDirty && this.camera && !this.busy) {
      this.propsDirty = false;
      this.refreshProps(true);
    }
  }

  /* ───────── properties ───────── */

  readUInt32(id) {
    const buf = Buffer.alloc(4);
    const err = this.api.EdsGetPropertyData(this.camera, id, 0, 4, buf) >>> 0;
    return err === Err.OK ? buf.readUInt32LE(0) : null;
  }

  writeUInt32(id, value) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value >>> 0, 0);
    return this.api.EdsSetPropertyData(this.camera, id, 0, 4, buf) >>> 0;
  }

  readString(id) {
    const type = [0];
    const size = [0];
    if ((this.api.EdsGetPropertySize(this.camera, id, 0, type, size) >>> 0) !== Err.OK || !size[0]) return '';
    const buf = Buffer.alloc(size[0]);
    if ((this.api.EdsGetPropertyData(this.camera, id, 0, size[0], buf) >>> 0) !== Err.OK) return '';
    const end = buf.indexOf(0);
    return buf.subarray(0, end < 0 ? buf.length : end).toString('utf8').trim();
  }

  readDesc(id) {
    const desc = {};
    if ((this.api.EdsGetPropertyDesc(this.camera, id, desc) >>> 0) !== Err.OK) return [];
    return (desc.propDesc ?? []).slice(0, Math.max(0, desc.numElements ?? 0)).map((c) => c >>> 0);
  }

  refreshProps(withDescs = false) {
    if (!this.camera) return;
    const modeCode = this.readUInt32(PropID.AEModeSelect) ?? this.readUInt32(PropID.AEMode);
    const mode = labelFor('mode', modeCode) ?? 'Unknown';
    const canWrite = writableInMode(mode);
    const next = { mode: { value: mode } };
    for (const [key, id] of Object.entries(EXPOSURE_PROPS)) {
      if (withDescs || !this.descCodes[key]) this.descCodes[key] = this.readDesc(id);
      const code = this.readUInt32(id);
      const options = optionsFor(key, this.descCodes[key]);
      next[key] = {
        value: labelFor(key, code),
        options,
        writable: canWrite[key] && (options.length > 0 || key === 'wb'),
      };
    }
    const battery = this.readUInt32(PropID.BatteryLevel);
    next.battery = { value: battery == null ? null : battery === 0xffffffff ? 'AC' : battery };
    next.shots = { value: this.readUInt32(PropID.AvailableShots) };
    const lens = this.readString(PropID.LensName);
    if (lens) next.lens = { value: lens };

    const changed = JSON.stringify(next) !== JSON.stringify(this.props);
    this.props = next;
    if (changed) this.emit('props', next);
  }

  async retryBusy(fn, where, tries = 12) {
    for (let i = 0; ; i++) {
      const err = fn() >>> 0;
      if (err === Err.OK) return;
      if (!BUSY.has(err) || i >= tries) throw new EdsError(err, where);
      await delay(60 + i * 20);
    }
  }

  async setProp(key, label) {
    const id = EXPOSURE_PROPS[key];
    if (!id) throw new Error(`Unknown setting “${key}”`);
    if (!this.camera) throw new Error('The camera is not connected.');
    const p = this.props[key];
    if (p && !p.writable) {
      const mode = this.props.mode?.value;
      throw new Error(
        key === 'tv' || key === 'av'
          ? `Turn the mode dial to M to set ${key === 'tv' ? 'shutter speed' : 'aperture'} from Lumen (it is on ${mode}).`
          : `The camera does not allow changing this in ${mode} mode.`,
      );
    }
    const code = codeFor(key, label, this.descCodes[key]);
    if (code == null) throw new Error(`${label} is not available on this camera right now.`);
    await this.withBusy(() => this.retryBusy(() => this.writeUInt32(id, code), `set ${key}`));
    this.refreshProps();
  }

  /** Apply a preset; settings the current mode doesn't allow are skipped, not fatal. */
  async applyValues(values) {
    const applied = [];
    const skipped = [];
    for (const key of ['iso', 'wb', 'av', 'tv']) {
      const v = values?.[key];
      if (v == null || v === '') continue;
      if (this.props[key]?.value === v) {
        applied.push(key);
        continue;
      }
      try {
        await this.setProp(key, v);
        applied.push(key);
      } catch (e) {
        skipped.push({ prop: key, reason: e.message });
      }
    }
    return { applied, skipped };
  }

  exposureSnapshot() {
    const p = this.props;
    return { iso: p.iso?.value ?? undefined, tv: p.tv?.value ?? undefined, av: p.av?.value ?? undefined, wb: p.wb?.value ?? undefined, mode: p.mode?.value };
  }

  /* ───────── live view ───────── */

  setLiveView(on) {
    this.liveView = !!on;
    if (this.camera) this.setLiveViewNow(this.liveView);
  }

  setLiveViewNow(on) {
    if (on) {
      // Canon's sample enables live view mode first; bodies without the property don't need it.
      const err = this.writeUInt32(PropID.Evf_Mode, 1);
      if (err !== Err.OK && err !== Err.NOT_SUPPORTED && err !== Err.DEVICEPROP_NOT_SUPPORTED) this.log(`live view mode: ${new EdsError(err).message}`);
    }
    const current = this.readUInt32(PropID.Evf_OutputDevice) ?? 0;
    const next = on ? current | EvfOutputDevice.PC : current & ~EvfOutputDevice.PC;
    if (next !== current) {
      const err = this.writeUInt32(PropID.Evf_OutputDevice, next);
      if (err !== Err.OK) {
        const msg =
          err === Err.DEVICE_BUSY || err === Err.NOT_SUPPORTED
            ? 'Live view could not start. On the 60D, enable it in the camera menu: Live View shoot → Enable.'
            : new EdsError(err, 'live view').message;
        this.emit('liveview', { on: false, error: msg });
        return;
      }
    }
    this.emit('liveview', { on });
    if (on && !this.evfLoop) this.runEvfLoop();
  }

  runEvfLoop() {
    this.evfLoop = true;
    const tick = () => {
      if (!this.liveView || !this.camera) {
        this.evfLoop = false;
        return;
      }
      if (!this.busy) {
        try {
          const frame = this.grabEvf();
          if (frame) this.emit('frame', frame);
        } catch (e) {
          this.handleError(e, 'live view');
        }
      }
      setTimeout(tick, 45);
    };
    setTimeout(tick, 120);
  }

  grabEvf() {
    const { api } = this;
    const streamOut = [null];
    check(api.EdsCreateMemoryStream(0, streamOut), 'EdsCreateMemoryStream');
    const stream = streamOut[0];
    const evfOut = [null];
    try {
      check(api.EdsCreateEvfImageRef(stream, evfOut), 'EdsCreateEvfImageRef');
      const err = api.EdsDownloadEvfImage(this.camera, evfOut[0]) >>> 0;
      if (BUSY.has(err)) return null; // no frame ready yet
      check(err, 'EdsDownloadEvfImage');
      return this.readStream(stream);
    } finally {
      if (evfOut[0]) api.EdsRelease(evfOut[0]);
      api.EdsRelease(stream);
    }
  }

  readStream(stream) {
    const lenOut = [0];
    check(this.api.EdsGetLength(stream, lenOut), 'EdsGetLength');
    const len = Number(lenOut[0]);
    if (!len) return null;
    const ptrOut = [null];
    check(this.api.EdsGetPointer(stream, ptrOut), 'EdsGetPointer');
    return Buffer.from(new Uint8Array(koffi.view(ptrOut[0], len)));
  }

  /* ───────── capture ───────── */

  async capture(requestId) {
    if (!this.camera) throw new Error('The camera is not connected.');
    const pending = { requestId, exposure: this.exposureSnapshot(), at: Date.now(), firedAt: null, rawTimer: null };
    this.pendingCaptures.push(pending);
    pending.timer = setTimeout(() => {
      if (this.dropPending(pending)) {
        this.emit('capture-failed', { requestId, message: 'No photo arrived from the camera. If it is set to RAW only, switch image quality to JPEG.' });
      }
    }, CAPTURE_TIMEOUT_MS);
    try {
      await this.fireShutter();
      pending.firedAt = Date.now();
    } catch (e) {
      this.dropPending(pending);
      if (e?.code === Err.TAKE_PICTURE_NO_CARD_NG && this.saveTo === 'both') {
        this.log('no memory card: saving to the computer only');
        this.setSaveTo('host');
        return this.capture(requestId);
      }
      throw e;
    }
  }

  async fireShutter() {
    const { api } = this;
    const button = (state) => api.EdsSendCommand(this.camera, CameraCommand.PressShutterButton, state) >>> 0;
    await this.withBusy(async () => {
      const press = button(ShutterButton.Completely_NonAF);
      if (press === Err.NOT_SUPPORTED || press === Err.INVALID_PARAMETER) {
        // Older bodies: the classic one-shot command.
        await this.retryBusy(() => api.EdsSendCommand(this.camera, CameraCommand.TakePicture, 0), 'take picture');
        return;
      }
      try {
        if (BUSY.has(press)) await this.retryBusy(() => button(ShutterButton.Completely_NonAF), 'shutter');
        else check(press, 'shutter');
      } finally {
        // Never leave the button logically pressed. A failed release is a warning, not a failed capture.
        if (this.camera) {
          try {
            await this.retryBusy(() => button(ShutterButton.Off), 'release shutter');
          } catch (e) {
            this.log(`warning: ${e.message}`);
          }
        }
      }
    });
  }

  /** Remove a pending capture and its timers; false if it was already gone. */
  dropPending(pending) {
    clearTimeout(pending.timer);
    clearTimeout(pending.rawTimer);
    pending.rawTimer = null;
    const i = this.pendingCaptures.indexOf(pending);
    if (i < 0) return false;
    this.pendingCaptures.splice(i, 1);
    return true;
  }

  failPending(message) {
    for (const p of this.pendingCaptures.slice()) {
      this.dropPending(p);
      this.emit('capture-failed', { requestId: p.requestId, message: message ?? 'Capture cancelled.' });
    }
  }

  /**
   * The capture a new file belongs to: the one whose RAW just arrived (its JPEG follows),
   * else the oldest one fired within the match window. Anything else was taken by hand.
   */
  matchPending(isRaw) {
    const now = Date.now();
    if (!isRaw) {
      const waiting = this.pendingCaptures.find((p) => p.rawTimer);
      if (waiting) return waiting;
    }
    return this.pendingCaptures.find((p) => !p.rawTimer && p.firedAt != null && now - p.firedAt <= MATCH_WINDOW_MS) ?? null;
  }

  /** A RAW arrived; if no JPEG follows soon the camera is set to RAW only. */
  expectJpeg(pending) {
    if (pending) {
      clearTimeout(pending.rawTimer);
      pending.rawTimer = setTimeout(() => {
        if (this.dropPending(pending)) this.emit('capture-failed', { requestId: pending.requestId, message: RAW_ONLY_MESSAGE });
      }, JPEG_AFTER_RAW_MS);
      return;
    }
    clearTimeout(this.rawTimer);
    this.rawTimer = setTimeout(() => {
      this.rawTimer = null;
      this.emit('notice', { message: 'RAW files can’t be shown in a browser. Set image quality to JPEG or RAW+JPEG.' });
    }, JPEG_AFTER_RAW_MS);
  }

  processTransfers() {
    return this.withBusy(() => {
      while (this.transferQueue.length) {
        const ref = this.transferQueue.shift();
        try {
          this.downloadItem(ref);
        } catch (e) {
          this.handleError(e, 'download');
        } finally {
          this.api.EdsRelease(ref);
        }
      }
    });
  }

  downloadItem(ref) {
    const { api } = this;
    let pending = null;
    try {
      const info = {};
      check(api.EdsGetDirectoryItemInfo(ref, info), 'EdsGetDirectoryItemInfo');
      const name = info.szFileName || `IMG_${Date.now()}.JPG`;
      const size = Number(info.size);
      const isRaw = RAW.test(name);
      pending = this.matchPending(isRaw);
      if (isRaw) {
        // RAW stays on the memory card; Lumen stores the JPEG from RAW+JPEG.
        api.EdsDownloadCancel(ref);
        this.expectJpeg(pending);
        return;
      }
      const streamOut = [null];
      check(api.EdsCreateMemoryStream(size, streamOut), 'EdsCreateMemoryStream');
      const stream = streamOut[0];
      let data;
      try {
        check(api.EdsDownload(ref, size, stream), 'EdsDownload');
        check(api.EdsDownloadComplete(ref), 'EdsDownloadComplete');
        data = this.readStream(stream);
      } finally {
        api.EdsRelease(stream);
      }
      if (!data) throw new Error('empty file');
      if (pending) this.dropPending(pending);
      else if (this.rawTimer) {
        clearTimeout(this.rawTimer);
        this.rawTimer = null;
      }
      this.emit('photo', {
        requestId: pending?.requestId,
        name,
        data,
        takenAt: pending?.at ?? Date.now(),
        exposure: pending?.exposure ?? this.exposureSnapshot(),
      });
    } catch (e) {
      api.EdsDownloadCancel(ref);
      if (pending && this.dropPending(pending)) {
        this.emit('capture-failed', { requestId: pending.requestId, message: `The photo could not be downloaded: ${e.message}` });
      }
      throw e;
    }
  }

  reconnect() {
    this.disconnect('Reconnecting…');
    this.tryConnect();
  }
}
