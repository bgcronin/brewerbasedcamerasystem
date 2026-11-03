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
    this.busy = false;
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
      if (this.camera) {
        this.setLiveViewNow(false);
        this.api.EdsCloseSession(this.camera);
        this.api.EdsRelease(this.camera);
      }
    } catch {
      /* shutting down anyway */
    }
    this.camera = null;
    for (const h of this.handlers) koffi.unregister(h);
    this.handlers = [];
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
      this.handleError(e, 'connect');
    } finally {
      api.EdsRelease(list);
    }
  }

  configure() {
    const { api, types } = this;
    const onObject = koffi.register((event, ref) => {
      if (event === ObjectEvent.DirItemRequestTransfer && ref) this.transferQueue.push(ref);
      else if (ref) this.api.EdsRelease(ref);
      return Err.OK;
    }, koffi.pointer(types.ObjectHandler));
    const onProperty = koffi.register((event, propId) => {
      if (event === PropertyEvent.PropertyChanged || event === PropertyEvent.PropertyDescChanged) {
        if (Object.values(EXPOSURE_PROPS).includes(propId) || propId === PropID.AEMode || propId === PropID.AEModeSelect || propId === PropID.BatteryLevel) {
          this.propsDirty = true;
        }
      }
      return Err.OK;
    }, koffi.pointer(types.PropertyHandler));
    const onState = koffi.register((event) => {
      if (event === StateEvent.Shutdown) setImmediate(() => this.disconnect('The camera was switched off or unplugged.'));
      if (event === StateEvent.WillSoonShutDown && this.camera) this.api.EdsSendCommand(this.camera, CameraCommand.ExtendShutDownTimer, 0);
      if (event === StateEvent.CaptureError) setImmediate(() => this.failPending('The camera could not take the picture.'));
      return Err.OK;
    }, koffi.pointer(types.StateHandler));
    this.handlers.push(onObject, onProperty, onState);
    check(api.EdsSetObjectEventHandler(this.camera, ObjectEvent.All, onObject, null), 'EdsSetObjectEventHandler');
    check(api.EdsSetPropertyEventHandler(this.camera, PropertyEvent.All, onProperty, null), 'EdsSetPropertyEventHandler');
    check(api.EdsSetCameraStateEventHandler(this.camera, StateEvent.All, onState, null), 'EdsSetCameraStateEventHandler');
    this.setSaveTo(this.saveTo);
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

  disconnect(message) {
    if (!this.camera) return;
    try {
      this.api.EdsCloseSession(this.camera);
      this.api.EdsRelease(this.camera);
    } catch {
      /* already gone */
    }
    this.camera = null;
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
    this.busy = true;
    try {
      await this.retryBusy(() => this.writeUInt32(id, code), `set ${key}`);
    } finally {
      this.busy = false;
    }
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
    const pending = { requestId, exposure: this.exposureSnapshot(), at: Date.now() };
    this.pendingCaptures.push(pending);
    pending.timer = setTimeout(() => {
      const i = this.pendingCaptures.indexOf(pending);
      if (i >= 0) {
        this.pendingCaptures.splice(i, 1);
        this.emit('capture-failed', { requestId, message: 'No photo arrived from the camera. If it is set to RAW only, switch image quality to JPEG.' });
      }
    }, 20_000);
    try {
      await this.fireShutter();
    } catch (e) {
      clearTimeout(pending.timer);
      this.pendingCaptures.splice(this.pendingCaptures.indexOf(pending), 1);
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
    this.busy = true;
    try {
      const press = api.EdsSendCommand(this.camera, CameraCommand.PressShutterButton, ShutterButton.Completely_NonAF) >>> 0;
      if (press === Err.OK) {
        await this.retryBusy(() => api.EdsSendCommand(this.camera, CameraCommand.PressShutterButton, ShutterButton.Off), 'release shutter');
        return;
      }
      if (BUSY.has(press)) {
        await this.retryBusy(() => api.EdsSendCommand(this.camera, CameraCommand.PressShutterButton, ShutterButton.Completely_NonAF), 'shutter');
        await this.retryBusy(() => api.EdsSendCommand(this.camera, CameraCommand.PressShutterButton, ShutterButton.Off), 'release shutter');
        return;
      }
      // Older bodies: the classic one-shot command.
      await this.retryBusy(() => api.EdsSendCommand(this.camera, CameraCommand.TakePicture, 0), 'take picture');
    } finally {
      this.busy = false;
    }
  }

  failPending(message) {
    for (const p of this.pendingCaptures.splice(0)) {
      clearTimeout(p.timer);
      this.emit('capture-failed', { requestId: p.requestId, message: message ?? 'Capture cancelled.' });
    }
  }

  async processTransfers() {
    this.busy = true;
    try {
      while (this.transferQueue.length) {
        const ref = this.transferQueue.shift();
        try {
          this.downloadItem(ref);
        } catch (e) {
          this.handleError(e, 'download');
          this.emit('capture-failed', { requestId: this.pendingCaptures[0]?.requestId, message: `The photo could not be downloaded: ${e.message}` });
        } finally {
          this.api.EdsRelease(ref);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  downloadItem(ref) {
    const { api } = this;
    const info = {};
    check(api.EdsGetDirectoryItemInfo(ref, info), 'EdsGetDirectoryItemInfo');
    const name = info.szFileName || `IMG_${Date.now()}.JPG`;
    const size = Number(info.size);
    if (RAW.test(name)) {
      // RAW stays on the memory card; Lumen stores the JPEG from RAW+JPEG.
      api.EdsDownloadCancel(ref);
      if (this.saveTo === 'host') this.emit('notice', { message: 'RAW files can’t be shown in a browser. Set image quality to JPEG or RAW+JPEG.' });
      return;
    }
    const streamOut = [null];
    check(api.EdsCreateMemoryStream(size, streamOut), 'EdsCreateMemoryStream');
    const stream = streamOut[0];
    try {
      check(api.EdsDownload(ref, size, stream), 'EdsDownload');
      check(api.EdsDownloadComplete(ref), 'EdsDownloadComplete');
      const data = this.readStream(stream);
      if (!data) throw new Error('empty file');
      const pending = this.pendingCaptures.shift();
      if (pending) clearTimeout(pending.timer);
      this.emit('photo', {
        requestId: pending?.requestId,
        name,
        data,
        takenAt: pending?.at ?? Date.now(),
        exposure: pending?.exposure ?? this.exposureSnapshot(),
      });
    } finally {
      api.EdsRelease(stream);
    }
  }

  reconnect() {
    this.disconnect('Reconnecting…');
    this.tryConnect();
  }
}
