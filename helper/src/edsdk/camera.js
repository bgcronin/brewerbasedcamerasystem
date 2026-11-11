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
  STATE_EVENT_NAMES,
  StateEvent,
  errorMessage,
} from './constants.js';
import { check, loadEdsdk, makeRunLoopPump } from './binding.js';
import { codeFor, labelFor, optionsFor, writableInMode } from './values.js';

const EXPOSURE_PROPS = { iso: PropID.ISOSpeed, tv: PropID.Tv, av: PropID.Av, wb: PropID.WhiteBalance };
const BUSY = new Set([Err.DEVICE_BUSY, Err.PTP_DEVICE_BUSY, Err.OBJECT_NOTREADY]);
const GONE = new Set([Err.COMM_DISCONNECTED, Err.DEVICE_NOT_FOUND, Err.DEVICE_INVALID, Err.SESSION_NOT_OPEN]);
// The camera's way of saying it cannot keep a copy on the memory card as well.
const CANNOT_SAVE_BOTH = new Set([
  Err.NOT_SUPPORTED,
  Err.INVALID_PARAMETER,
  Err.PROPERTIES_UNAVAILABLE,
  Err.DEVICEPROP_NOT_SUPPORTED,
  Err.INVALID_DEVICEPROP_VALUE,
  Err.DEVICE_NO_DISK,
]);
const RAW = /\.(cr2|cr3|crw)$/i;
const JPEG = /\.jpe?g$/i;
const CAPTURE_TIMEOUT_MS = 20_000;
// A photo belongs to a Lumen capture if it arrives this soon after the shutter fired.
const MATCH_WINDOW_MS = 8000;
// Later than that (a self-timer, a long exposure) it still does, for this long, but only while it is the
// first thing the camera has produced since: once a photo from the camera's own button has come in
// between, the order can no longer be trusted. This matches how long Lumen keeps a failed capture's labels.
const LATE_MATCH_MS = 90_000;
// The two files of a RAW+JPEG shot arrive close together; after this long a RAW on its own means RAW only.
const JPEG_AFTER_RAW_MS = 3000;
// A new JPEG on the memory card that the camera has not offered to the computer by now is fetched from the card.
const CARD_ONLY_WAIT_MS = 2500;
// How long file and shot names are remembered, so nothing is delivered twice.
const NAME_MEMORY_MS = 60_000;
// A camera that is connected and working sends events; none at all this long after connecting is worth shouting about.
const NO_EVENTS_AFTER_MS = 5000;
const OFF_RETRIES = 6;
const OFF_RETRY_MS = 500;
const LIVE_VIEW_RETRIES = 12;
const LIVE_VIEW_RETRY_MS = 300;
const MAX_SAVE_TO_REPAIRS = 3;
const RAW_ONLY_MESSAGE = 'The camera is set to RAW only, and RAW files can’t be shown in a browser. Set image quality to JPEG or RAW+JPEG.';
const NO_EVENT_PUMP_MESSAGE =
  'This copy of Canon’s SDK cannot pass camera events to Camera Link on Windows (EDSDK.dll has no EdsGetEvent), so photos would never arrive. Put Canon’s EDSDK 3.x or 13.x in helper/sdk and start Camera Link again.';
const SAVE_TO_LABEL = { [SaveTo.Camera]: 'memory card only', [SaveTo.Host]: 'computer only', [SaveTo.Both]: 'memory card + computer' };
const WATCHED_PROPS = {
  [PropID.SaveTo]: 'where photos are saved',
  [PropID.AvailableShots]: 'shots available',
  [PropID.Evf_OutputDevice]: 'live view output',
};
// Sent every time the keep-alive is: say it once, then stay quiet.
const QUIET_STATE_EVENTS = new Set([0x304]);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => `0x${(n >>> 0).toString(16)}`;
/** A short blocking wait, used only for the brief "camera is busy" retries while connecting. */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class EdsdkBackend extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.sdk     result of locateSdk()
   * @param {'both'|'host'} [opts.saveTo]  'both' keeps a copy on the memory card as a backup
   * @param {(msg: string) => void} [opts.log]
   * @param {boolean} [opts.requireEventPump]  refuse to run without EdsGetEvent (the default on Windows)
   * @param {number} [opts.captureTimeoutMs]   how long a shot from Lumen may take before it is reported as failed
   * @param {number} [opts.matchWindowMs]      how soon after the shutter a photo is taken to be that shot's
   */
  constructor({
    sdk,
    saveTo = 'both',
    log = () => {},
    requireEventPump = process.platform === 'win32',
    captureTimeoutMs = CAPTURE_TIMEOUT_MS,
    matchWindowMs = MATCH_WINDOW_MS,
  }) {
    super();
    this.sdk = sdk;
    this.saveTo = saveTo;
    this.log = log;
    this.requireEventPump = requireEventPump;
    this.captureTimeoutMs = captureTimeoutMs;
    this.matchWindowMs = matchWindowMs;
    this.camera = null;
    this.state = { state: 'starting' };
    this.unavailable = null;
    this.props = {};
    this.descCodes = {};
    this.liveView = false;
    this.pendingCaptures = [];
    // Shots from Lumen that were reported as failed for want of a photo, in case it still turns up.
    this.expiredCaptures = [];
    this.lastOwnButtonAt = 0;
    // Files the camera announced, waiting for the pump: { event, ref }.
    this.itemQueue = [];
    // New JPEGs on the memory card that may still be offered to the computer: name → { ref, name, size, at }.
    this.cardItems = new Map();
    // File names already handled: name → { at, fromCard }.
    this.files = new Map();
    // One entry per shot (IMG_0001 for IMG_0001.CR2 + IMG_0001.JPG): base → { pending, at, jpegDone, rawTimer, announced }.
    this.shots = new Map();
    this.lastTransferAt = 0;
    this.propsDirty = false;
    this.timers = [];
    this.handlers = [];
    this.busyDepth = 0;
    this.counters = { object: 0, property: 0, state: 0 };
    this.notes = [];
    this.changedProps = new Set();
    this.lastSeen = {};
    this.limited = new Map();
    this.noEventsTimer = null;
    this.offRetries = 0;
    this.offRetryAt = 0;
    this.liveViewRetries = 0;
    this.liveViewRetryAt = 0;
    this.deadReads = 0;
    this.lastReadError = Err.OK;
    this.saveToRepairs = 0;
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
    return {
      backend: 'edsdk',
      sdkVersion: this.sdk.version,
      sdkGeneration: this.sdk.generation,
      sdkPath: this.sdk.libPath,
      saveTo: this.saveTo,
      events: { ...this.counters },
    };
  }

  /** Never throws: a problem with the SDK becomes a state Lumen can show. */
  start() {
    try {
      this.startSdk();
    } catch (e) {
      this.fail('unavailable', e?.message ?? String(e));
    }
  }

  startSdk() {
    const { api, types } = loadEdsdk(this.sdk);
    this.api = api;
    this.types = types;
    check(api.EdsInitializeSDK(), 'EdsInitializeSDK');
    for (const w of this.sdk.warnings ?? []) this.log(`warning: ${w}`);
    if (!api.EdsGetEvent) {
      if (this.requireEventPump) {
        this.fail('error', NO_EVENT_PUMP_MESSAGE);
        return;
      }
      this.log('warning: this Canon SDK has no EdsGetEvent; camera events can only arrive through the system’s own event loop');
    }
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

  /** The SDK cannot be used at all: say why, and stop trying. */
  fail(state, message) {
    this.log(message);
    this.unavailable = message;
    this.stopTimers();
    this.setState({ state, message });
  }

  stopTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  stop() {
    this.stopTimers();
    try {
      // A photo the camera has already announced is fetched before the session closes, not abandoned.
      if (this.camera && this.itemQueue.length) void this.processItems();
      if (this.camera) this.setLiveViewNow(false);
    } catch {
      /* shutting down anyway */
    }
    this.releaseCamera();
    this.failPending('Lumen Camera Link was stopped.');
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

  /** Log a line, but not the same kind of line again and again. */
  logLimited(key, message, everyMs = 2000) {
    const now = Date.now();
    const last = this.limited.get(key);
    if (last && now - last.at < everyMs) {
      last.skipped++;
      return;
    }
    this.log(last?.skipped ? `${message} (${last.skipped} more like it not shown)` : message);
    this.limited.set(key, { at: now, skipped: 0 });
  }

  /* ───────── connection ───────── */

  tryConnect() {
    const { api } = this;
    if (!api || this.unavailable) return;
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
        this.logLimited('open-session', `could not open the camera: ${e.message}`, 60_000);
        this.setState({ state: 'error', message: e.message, model: info.szDeviceDescription });
        return;
      }
      this.camera = cam;
      this.counters = { object: 0, property: 0, state: 0 };
      this.saveToRepairs = 0;
      this.deadReads = 0;
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
        this.afterConnect();
        this.refreshProps(true);
        if (this.liveView) this.setLiveViewNow(true);
      } catch (e) {
        // Never keep a half-configured camera; the 2 s timer retries from scratch.
        this.releaseCamera();
        this.logLimited('connect', `connect: ${e?.message ?? e}`, 30_000);
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
    // The handlers only take notes: the pump does the work, and all logging, outside the camera's callback.
    try {
      const onObject = register((event, ref) => {
        this.counters.object++;
        if (ref && (event === ObjectEvent.DirItemRequestTransfer || event === ObjectEvent.DirItemCreated)) {
          this.itemQueue.push({ event, ref });
        } else {
          this.note(`object ${hex(event)}`);
          if (ref) this.api.EdsRelease(ref);
        }
        return Err.OK;
      }, types.ObjectHandler);
      const onProperty = register((event, propId) => {
        this.counters.property++;
        if (event === PropertyEvent.PropertyChanged || event === PropertyEvent.PropertyDescChanged) {
          if (Object.values(EXPOSURE_PROPS).includes(propId) || propId === PropID.AEMode || propId === PropID.AEModeSelect || propId === PropID.BatteryLevel) {
            this.propsDirty = true;
          }
          if (event === PropertyEvent.PropertyChanged && WATCHED_PROPS[propId]) this.changedProps.add(propId);
        }
        return Err.OK;
      }, types.PropertyHandler);
      const onState = register((event, data) => {
        this.counters.state++;
        const name = STATE_EVENT_NAMES[event];
        this.note(`state ${hex(event)}${name ? ` (${name})` : ''}${data ? `, data ${hex(data)}` : ''}`, `state ${hex(event)}`, QUIET_STATE_EVENTS.has(event));
        if (event === StateEvent.Shutdown) setImmediate(() => this.disconnect('The camera was switched off or unplugged.'));
        if (event === StateEvent.WillSoonShutDown && this.camera) this.api.EdsSendCommand(this.camera, CameraCommand.ExtendShutDownTimer, 0);
        if (event === StateEvent.CaptureError) {
          const why = data ? errorMessage(data >>> 0) : '';
          setImmediate(() => this.failPending(why && !why.startsWith('Canon SDK error') ? why : 'The camera could not take the picture.'));
        }
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

  /** Housekeeping once a camera is connected. Nothing here may fail the connection. */
  afterConnect() {
    const { api } = this;
    // A shutter press left "held" by an earlier run would stop the camera's own button working.
    const off = api.EdsSendCommand(this.camera, CameraCommand.PressShutterButton, ShutterButton.Off) >>> 0;
    if (BUSY.has(off)) {
      this.offRetries = OFF_RETRIES;
      this.offRetryAt = Date.now() + OFF_RETRY_MS;
    } else if (off !== Err.OK && off !== Err.NOT_SUPPORTED && off !== Err.INVALID_PARAMETER) {
      this.log(`note: the camera did not accept “shutter button released” on connecting (${hex(off)})`);
    }
    // Keeps the camera awake, and gives it something to answer with an event.
    api.EdsSendCommand(this.camera, CameraCommand.ExtendShutDownTimer, 0);

    const saveTo = this.readUInt32(PropID.SaveTo);
    const shots = this.readUInt32(PropID.AvailableShots);
    this.lastSeen = { [PropID.SaveTo]: saveTo, [PropID.AvailableShots]: shots, [PropID.Evf_OutputDevice]: this.readUInt32(PropID.Evf_OutputDevice) };
    const wanted = this.saveTo === 'host' ? SaveTo.Host : SaveTo.Both;
    this.log(
      `photos are saved to: ${SAVE_TO_LABEL[wanted]} (camera reports ${saveTo == null ? 'nothing' : `${saveTo}, ${SAVE_TO_LABEL[saveTo] ?? 'unknown'}`}); ` +
        `shots available: ${shots ?? 'unknown'}; camera events through: ${api.EdsGetEvent ? 'EdsGetEvent' : 'the system event loop'}`,
    );
    // What the camera reports this soon after being set may still be its old value; a change is logged when it comes.
    clearTimeout(this.noEventsTimer);
    this.noEventsTimer = setTimeout(() => this.checkAfterSettling(), NO_EVENTS_AFTER_MS);
  }

  /** A few seconds after connecting: two things that would explain "the camera's button does nothing". Log only. */
  checkAfterSettling() {
    this.noEventsTimer = null;
    if (!this.camera) return;
    if (this.saveTo === 'both' && this.readUInt32(PropID.AvailableShots) === 0) {
      this.log('warning: the camera reports no shots available. With a full, missing or write-protected memory card its own shutter button may not fire: put in a card with space, or start Camera Link with --save-to host.');
    }
    const { object, property, state } = this.counters;
    if (object + property + state > 0) return;
    this.log('!!! WARNING: THE CAMERA HAS SENT NO EVENTS since it connected. !!!');
    this.log('!!! If photos do not appear in Lumen, this is why: Canon’s SDK is not passing camera events on to Camera Link.');
    this.log('!!! Quit EOS Utility, unplug the camera and plug it in again, then restart Camera Link.');
  }

  /**
   * Retry a camera call that answers "busy", pausing briefly between tries.
   * Blocks, so it is only for the short sequence right after connecting.
   */
  retrySync(fn, tries = 10, waitMs = 120) {
    let err = fn() >>> 0;
    for (let i = 0; i < tries && BUSY.has(err); i++) {
      sleepSync(waitMs);
      err = fn() >>> 0;
    }
    return err;
  }

  /** Photos come to the computer; 'both' also keeps them on the card as a backup. */
  setSaveTo(mode) {
    const wanted = mode === 'host' ? SaveTo.Host : SaveTo.Both;
    let err = this.retrySync(() => this.writeUInt32(PropID.SaveTo, wanted));
    // Only a clear "can't do that" from the camera gives up the card copy; anything else (busy, unplugged) is an error to retry.
    if (wanted === SaveTo.Both && CANNOT_SAVE_BOTH.has(err)) {
      this.log(`the camera would not save to the memory card and the computer (${new EdsError(err).message}); saving to the computer only, with no copy on the card`);
      err = this.retrySync(() => this.writeUInt32(PropID.SaveTo, SaveTo.Host));
      mode = 'host';
    }
    check(err, 'set SaveTo');
    this.saveTo = mode === 'host' ? 'host' : 'both';
    // Tell the camera the computer has plenty of room.
    check(this.retrySync(() => this.api.EdsSetCapacity(this.camera, { numberOfFreeClusters: 0x7fffffff, bytesPerSector: 0x1000, reset: 1 })), 'EdsSetCapacity');
  }

  /** The camera says it saves somewhere else than asked: put it back, a few times at most. */
  checkSaveTo(value) {
    const wanted = this.saveTo === 'host' ? SaveTo.Host : SaveTo.Both;
    if (value === wanted || !this.camera) return;
    if (this.saveToRepairs >= MAX_SAVE_TO_REPAIRS) return;
    this.saveToRepairs++;
    this.log(`warning: the camera is saving to “${SAVE_TO_LABEL[value] ?? value}” instead of “${SAVE_TO_LABEL[wanted]}”; setting it again`);
    try {
      this.setSaveTo(this.saveTo);
    } catch (e) {
      this.log(`could not set where photos are saved: ${e?.message ?? e}`);
    }
  }

  /** Close the session, drop the camera ref and free the event handlers registered for it. */
  releaseCamera() {
    const cam = this.camera;
    this.camera = null;
    clearTimeout(this.noEventsTimer);
    this.noEventsTimer = null;
    this.offRetries = 0;
    this.liveViewRetries = 0;
    this.clearShots();
    this.expiredCaptures = [];
    // Files that were announced but not yet fetched belong to the session that is ending.
    const stale = [...this.itemQueue.splice(0), ...this.cardItems.values()];
    this.cardItems.clear();
    this.files.clear();
    for (const { ref } of stale) {
      try {
        this.api?.EdsRelease(ref);
      } catch {
        /* already gone */
      }
    }
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
    if (this.lostIfGone(e)) return;
    this.log(`${where}: ${e?.message ?? e}`);
  }

  /** A "camera is gone" answer from any call: drop the session so the 2 s timer opens a fresh one. */
  lostIfGone(e) {
    const code = e?.code;
    if (code == null || !GONE.has(code)) return false;
    this.disconnect('The camera was disconnected.');
    return true;
  }

  /* ───────── event pump ───────── */

  pump() {
    this.api.EdsGetEvent?.();
    this.pumpRunLoop();
    this.flushNotes();
    if (this.itemQueue.length && !this.busy) void this.processItems();
    if (!this.camera || this.busy) return;
    if (this.cardItems.size) this.checkCardItems();
    if (this.offRetries > 0) this.retryShutterOff();
    if (this.liveViewRetries > 0 && Date.now() >= this.liveViewRetryAt) {
      this.liveViewRetries--;
      if (this.liveView) this.setLiveViewNow(true, true);
    }
    if (this.changedProps.size) this.reportChangedProps();
    if (this.propsDirty) {
      this.propsDirty = false;
      this.refreshProps(true);
    }
  }

  /** Remember an event to log. Events of one kind (`key`) are logged at most every 2 s; `once` for those that repeat all day. */
  note(text, key = text, once = false) {
    if (this.notes.length < 200) this.notes.push({ text, key, once });
  }

  flushNotes() {
    if (!this.notes.length) return;
    for (const { text, key, once } of this.notes.splice(0)) this.logLimited(`event ${key}`, `camera event: ${text}`, once ? Infinity : 2000);
  }

  reportChangedProps() {
    const ids = [...this.changedProps];
    this.changedProps.clear();
    for (const id of ids) {
      const value = this.readUInt32(id);
      if (value == null || this.lastSeen[id] === value) continue;
      this.lastSeen[id] = value;
      this.log(`camera: ${WATCHED_PROPS[id]} is now ${id === PropID.SaveTo ? `${value} (${SAVE_TO_LABEL[value] ?? 'unknown'})` : value}`);
      if (id === PropID.SaveTo) this.checkSaveTo(value);
    }
  }

  /* ───────── properties ───────── */

  readUInt32(id) {
    const buf = Buffer.alloc(4);
    const err = this.api.EdsGetPropertyData(this.camera, id, 0, 4, buf) >>> 0;
    this.lastReadError = err;
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
    // Count the answers: a camera that only ever says "gone" has lost its session.
    let answered = 0;
    let gone = 0;
    const read = (id) => {
      const value = this.readUInt32(id);
      if (value != null) answered++;
      else if (GONE.has(this.lastReadError)) gone++;
      return value;
    };
    const modeCode = read(PropID.AEModeSelect) ?? read(PropID.AEMode);
    const mode = labelFor('mode', modeCode) ?? 'Unknown';
    const canWrite = writableInMode(mode);
    const next = { mode: { value: mode } };
    for (const [key, id] of Object.entries(EXPOSURE_PROPS)) {
      if (withDescs || !this.descCodes[key]) this.descCodes[key] = this.readDesc(id);
      const code = read(id);
      const options = optionsFor(key, this.descCodes[key]);
      next[key] = {
        value: labelFor(key, code),
        options,
        writable: canWrite[key] && (options.length > 0 || key === 'wb'),
      };
    }
    const battery = read(PropID.BatteryLevel);
    next.battery = { value: battery == null ? null : battery === 0xffffffff ? 'AC' : battery };
    next.shots = { value: read(PropID.AvailableShots) };
    const lens = this.readString(PropID.LensName);
    if (lens) next.lens = { value: lens };

    if (!answered && gone) {
      if (++this.deadReads >= 2) {
        this.log('the camera has stopped answering; reconnecting');
        this.disconnect('The camera was disconnected.');
        return;
      }
    } else {
      this.deadReads = 0;
    }

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
    if (!this.camera) throw new Error(this.unavailable ?? 'The camera is not connected.');
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
    try {
      await this.withBusy(() => this.retryBusy(() => this.writeUInt32(id, code), `set ${key}`));
    } catch (e) {
      this.lostIfGone(e);
      throw e;
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

  setLiveViewNow(on, retrying = false) {
    if (!retrying) this.liveViewRetries = 0;
    if (on) {
      // Canon's sample enables live view mode first; bodies without the property don't need it.
      const err = this.writeUInt32(PropID.Evf_Mode, 1);
      if (err !== Err.OK && err !== Err.NOT_SUPPORTED && err !== Err.DEVICEPROP_NOT_SUPPORTED && !BUSY.has(err)) {
        this.logLimited('evf-mode', `live view mode: ${new EdsError(err).message}`, 30_000);
      }
    }
    const current = this.readUInt32(PropID.Evf_OutputDevice) ?? 0;
    const next = on ? current | EvfOutputDevice.PC : current & ~EvfOutputDevice.PC;
    if (next !== current) {
      const err = this.writeUInt32(PropID.Evf_OutputDevice, next);
      if (err !== Err.OK) {
        // Just after connecting or taking a photo the camera is often busy for a moment: try again from the pump.
        if (on && BUSY.has(err)) {
          if (!retrying) this.liveViewRetries = LIVE_VIEW_RETRIES;
          if (this.liveViewRetries > 0) {
            this.liveViewRetryAt = Date.now() + LIVE_VIEW_RETRY_MS;
            return;
          }
        }
        const msg =
          err === Err.DEVICE_BUSY || err === Err.NOT_SUPPORTED
            ? 'Live view could not start. On the 60D, enable it in the camera menu: Live View shoot → Enable.'
            : new EdsError(err, 'live view').message;
        this.emit('liveview', { on: false, error: msg });
        return;
      }
    }
    this.liveViewRetries = 0;
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
          // This runs twenty times a second: say what is wrong once in a while, not every time.
          if (!this.lostIfGone(e)) this.logLimited('evf', `live view: ${e?.message ?? e}`, 10_000);
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
    if (!this.camera) throw new Error(this.unavailable ?? 'The camera is not connected.');
    const pending = { requestId, exposure: this.exposureSnapshot(), at: Date.now(), firedAt: null, shot: null };
    this.pendingCaptures.push(pending);
    pending.timer = setTimeout(() => {
      if (this.dropPending(pending)) {
        // The camera took the press, so a photo may yet come: keep the request's name for it.
        if (pending.firedAt != null && !pending.shot && !pending.passedOver) this.expiredCaptures.push(pending);
        this.emit('capture-failed', { requestId, message: 'No photo arrived from the camera. If it is set to RAW only, switch image quality to JPEG.' });
      }
    }, this.captureTimeoutMs);
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
      this.lostIfGone(e);
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
            this.offRetries = 0;
          } catch (e) {
            this.log(`warning: ${e.message}`);
            // While the camera thinks the button is held, its own shutter button does nothing: keep trying.
            if (!GONE.has(e?.code)) {
              this.offRetries = OFF_RETRIES;
              this.offRetryAt = Date.now() + OFF_RETRY_MS;
            }
          }
        }
      }
    });
  }

  /** From the pump: one more try at telling the camera the shutter button is no longer pressed. */
  retryShutterOff() {
    if (Date.now() < this.offRetryAt) return;
    const err = this.api.EdsSendCommand(this.camera, CameraCommand.PressShutterButton, ShutterButton.Off) >>> 0;
    if (err === Err.OK) {
      this.offRetries = 0;
      this.log('shutter button released');
      return;
    }
    this.offRetries = BUSY.has(err) ? this.offRetries - 1 : 0;
    this.offRetryAt = Date.now() + OFF_RETRY_MS;
    if (!this.offRetries) {
      this.log(`warning: the camera would not release the shutter button (${new EdsError(err).message}). If its own button stops working, switch the camera off and on.`);
    }
  }

  /** Remove a pending capture and its timer; false if it was already gone. */
  dropPending(pending) {
    clearTimeout(pending.timer);
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

  clearShots() {
    for (const shot of this.shots.values()) clearTimeout(shot.rawTimer);
    this.shots.clear();
  }

  /**
   * The shot a file belongs to. The RAW and the JPEG of one shot share a name (IMG_0001.CR2, IMG_0001.JPG),
   * so they find the same entry whichever comes first. A new shot belongs to the oldest Lumen capture fired
   * within the match window that has no shot yet, or failing that to a late one (see captureFor);
   * any other shot was taken with the camera's own button, and Lumen is told at once that it is coming.
   */
  shotFor(name) {
    const base = name.replace(/\.[^.]*$/, '').toUpperCase();
    const now = Date.now();
    for (const [key, old] of this.shots) {
      if (now - old.at > NAME_MEMORY_MS && !old.rawTimer) this.shots.delete(key);
    }
    let shot = this.shots.get(base);
    if (!shot) {
      const pending = this.captureFor(name, now);
      shot = { base, pending, at: now, jpegDone: false, rawTimer: null, announced: false };
      if (pending) pending.shot = shot;
      this.shots.set(base, shot);
    }
    if (!shot.pending && !shot.announced) {
      // So Lumen can note which patient and eye are selected now, not when the download has finished.
      // (For a RAW+JPEG pair this is whichever file comes first; Lumen goes by the shared name.)
      shot.announced = true;
      this.emit('incoming', { name });
    }
    return shot;
  }

  /** The capture from Lumen that a newly seen shot belongs to, or null for the camera's own button. */
  captureFor(name, now) {
    const fired = (p) => !p.shot && !p.passedOver && p.firedAt != null;
    let match = this.pendingCaptures.find((p) => fired(p) && now - p.firedAt <= this.matchWindowMs) ?? null;
    if (!match) {
      // A late photo: the oldest capture still without one, provided nothing from the camera's own button came since.
      this.expiredCaptures = this.expiredCaptures.filter((p) => now - p.firedAt <= LATE_MATCH_MS);
      match =
        [...this.expiredCaptures, ...this.pendingCaptures]
          .filter((p) => fired(p) && p.firedAt > this.lastOwnButtonAt && now - p.firedAt <= LATE_MATCH_MS)
          .sort((a, b) => a.firedAt - b.firedAt)[0] ?? null;
      if (match) this.log(`${name} arrived ${Math.round((now - match.firedAt) / 1000)} s after Lumen’s shutter; filing it as that shot`);
    }
    if (!match) {
      this.lastOwnButtonAt = now;
      return null;
    }
    // Photos come in the order they were taken: any earlier capture still waiting produced nothing.
    this.expiredCaptures = this.expiredCaptures.filter((p) => p !== match && p.firedAt > match.firedAt);
    for (const p of this.pendingCaptures) if (p !== match && p.firedAt != null && p.firedAt < match.firedAt) p.passedOver = true;
    return match;
  }

  /** A RAW arrived and no JPEG followed: the camera is set to RAW only. */
  rawOnly(shot) {
    shot.rawTimer = null;
    if (shot.jpegDone) return;
    if (shot.pending) {
      if (this.dropPending(shot.pending)) this.emit('capture-failed', { requestId: shot.pending.requestId, message: RAW_ONLY_MESSAGE });
      return;
    }
    this.emit('notice', { code: 'raw-only', message: 'RAW files can’t be shown in a browser. Set image quality to JPEG or RAW+JPEG.' });
  }

  /** Work through the files the camera announced. */
  processItems() {
    return this.withBusy(() => {
      while (this.itemQueue.length) {
        const { event, ref } = this.itemQueue.shift();
        let kept = false;
        try {
          const info = {};
          check(this.api.EdsGetDirectoryItemInfo(ref, info), 'EdsGetDirectoryItemInfo');
          const item = { ref, name: info.szFileName || `IMG_${Date.now()}.JPG`, size: Number(info.size), isFolder: !!info.isFolder };
          if (event === ObjectEvent.DirItemCreated) kept = this.onCardItem(item);
          else this.onTransferRequest(item);
        } catch (e) {
          this.handleError(e, 'download');
        } finally {
          if (!kept) this.api.EdsRelease(ref);
        }
      }
    });
  }

  forgetOldFiles() {
    const now = Date.now();
    for (const [key, f] of this.files) if (now - f.at > NAME_MEMORY_MS) this.files.delete(key);
  }

  /**
   * A new file on the memory card (0x204). Normally the camera also offers it to the computer (0x208) and
   * this copy is left alone. It is kept for a moment in case that offer never comes. True if the ref was kept.
   */
  onCardItem(item) {
    this.log(`camera event: object 0x204 (new on the memory card) ${item.name}`);
    if (item.isFolder || !JPEG.test(item.name)) return false;
    const key = item.name.toUpperCase();
    this.forgetOldFiles();
    if (this.files.has(key)) return false; // its transfer request came first
    this.shotFor(item.name); // first sight of this shot: decide now whose it is
    const earlier = this.cardItems.get(key);
    if (earlier) this.api.EdsRelease(earlier.ref);
    this.cardItems.set(key, { ...item, at: Date.now() });
    return true;
  }

  /** The camera offers a file to the computer (0x208): take it, or tell the camera we don't want it. */
  onTransferRequest(item) {
    this.log(`camera event: object 0x208 (offered to the computer) ${item.name}`);
    const key = item.name.toUpperCase();
    this.lastTransferAt = Date.now();
    const onCard = this.cardItems.get(key);
    if (onCard) {
      this.api.EdsRelease(onCard.ref);
      this.cardItems.delete(key);
    }
    this.forgetOldFiles();
    if (this.files.get(key)?.fromCard) {
      // Already fetched from the card when this offer was late: never deliver a photo twice.
      this.api.EdsDownloadCancel(item.ref);
      this.log(`${item.name} was already fetched from the memory card; its late offer is declined`);
      return;
    }
    this.files.set(key, { at: Date.now(), fromCard: false });
    this.receive(item, false);
  }

  /** JPEGs that appeared on the card and were never offered to the computer are fetched from the card. */
  checkCardItems() {
    const now = Date.now();
    for (const [key, item] of this.cardItems) {
      if (now - item.at < CARD_ONLY_WAIT_MS) continue;
      this.cardItems.delete(key);
      // Any offer around the same time means the camera is sending photos to the computer and this is the card's copy of one.
      if (this.lastTransferAt >= item.at - CARD_ONLY_WAIT_MS) {
        this.api.EdsRelease(item.ref);
        continue;
      }
      void this.withBusy(() => this.fetchFromCard(key, item));
    }
  }

  fetchFromCard(key, item) {
    try {
      this.logLimited('card-only', `warning: the camera saved ${item.name} to its memory card without offering it to the computer; fetching it from the card`, 60_000);
      this.files.set(key, { at: Date.now(), fromCard: true });
      this.receive(item, true);
      const saveTo = this.readUInt32(PropID.SaveTo);
      if (saveTo != null) this.checkSaveTo(saveTo);
    } catch (e) {
      this.handleError(e, 'fetch from the memory card');
    } finally {
      try {
        this.api.EdsRelease(item.ref);
      } catch {
        /* the session ended meanwhile */
      }
    }
  }

  download(item) {
    const { api } = this;
    const streamOut = [null];
    check(api.EdsCreateMemoryStream(item.size, streamOut), 'EdsCreateMemoryStream');
    const stream = streamOut[0];
    try {
      check(api.EdsDownload(item.ref, item.size, stream), 'EdsDownload');
      check(api.EdsDownloadComplete(item.ref), 'EdsDownloadComplete');
      const data = this.readStream(stream);
      if (!data) throw new Error('empty file');
      return data;
    } finally {
      api.EdsRelease(stream);
    }
  }

  /** Fetch one file and pass it on. */
  receive(item, fromCard) {
    const { api } = this;
    const shot = this.shotFor(item.name);
    const pending = shot.pending;
    if (RAW.test(item.name)) {
      this.receiveRaw(item, shot);
      return;
    }
    clearTimeout(shot.rawTimer);
    shot.rawTimer = null;
    shot.jpegDone = true;
    let data;
    try {
      data = this.download(item);
    } catch (e) {
      api.EdsDownloadCancel(item.ref);
      if (pending && this.dropPending(pending)) {
        this.emit('capture-failed', { requestId: pending.requestId, message: `The photo could not be downloaded: ${e.message}` });
      }
      throw e;
    }
    if (pending) this.dropPending(pending);
    // (Nothing printed here can hold the photo back: Camera Link prints its lines a moment later, see main.js.)
    this.log(
      `photo ${item.name} (${Math.round(data.length / 1024)} KB) ${pending ? 'for Lumen’s shutter' : 'from the camera’s own shutter button'}${fromCard ? ', fetched from the memory card' : ''}`,
    );
    this.emit('photo', {
      requestId: pending?.requestId,
      name: item.name,
      data,
      takenAt: pending?.at ?? Date.now(),
      exposure: pending?.exposure ?? this.exposureSnapshot(),
    });
  }

  /** RAW files can't be shown in a browser; Lumen stores the JPEG of a RAW+JPEG shot. */
  receiveRaw(item, shot) {
    const { api } = this;
    if (this.saveTo === 'host' && this.listenerCount('raw') > 0) {
      // Nothing is written to the memory card, so this is the only copy: keep it on the computer.
      try {
        this.emit('raw', { name: item.name, data: this.download(item), takenAt: Date.now() });
      } catch (e) {
        api.EdsDownloadCancel(item.ref);
        this.log(`could not keep ${item.name}: ${e?.message ?? e}`);
      }
    } else {
      // The RAW stays on the memory card.
      api.EdsDownloadCancel(item.ref);
    }
    if (!shot.jpegDone && !shot.rawTimer) shot.rawTimer = setTimeout(() => this.rawOnly(shot), JPEG_AFTER_RAW_MS);
  }

  reconnect() {
    if (this.unavailable) {
      this.setState(this.state);
      return;
    }
    this.disconnect('Reconnecting…');
    this.tryConnect();
  }
}
