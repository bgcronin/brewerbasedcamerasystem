// A pretend Canon EOS 60D, so Lumen's camera features can be tried and tested without hardware.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writableInMode } from './edsdk/values.js';

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');

const ISO = ['Auto', '100', '125', '160', '200', '250', '320', '400', '500', '640', '800', '1000', '1250', '1600', '2000', '2500', '3200', '4000', '5000', '6400'];
const TV = ['30″', '15″', '8″', '4″', '2″', '1″', '0.5″', '1/4', '1/8', '1/15', '1/30', '1/40', '1/50', '1/60', '1/80', '1/100', '1/125', '1/160', '1/200', '1/250', '1/320', '1/400', '1/500', '1/640', '1/800', '1/1000', '1/2000', '1/4000', '1/8000'];
const AV = ['f/2.8', 'f/3.2', 'f/3.5', 'f/4', 'f/4.5', 'f/5', 'f/5.6', 'f/6.3', 'f/7.1', 'f/8', 'f/9', 'f/10', 'f/11', 'f/13', 'f/14', 'f/16', 'f/18', 'f/20', 'f/22'];
const WB = ['Auto', 'Daylight', 'Shade', 'Cloudy', 'Tungsten', 'Fluorescent', 'Flash', 'Custom'];

export class SimulatorBackend extends EventEmitter {
  constructor({ log = () => {}, mode = 'M' } = {}) {
    super();
    this.log = log;
    this.values = { iso: '400', tv: '1/125', av: 'f/8', wb: 'Flash', mode };
    this.liveView = false;
    this.frame = fs.readFileSync(path.join(ASSETS, 'sim-liveview.jpg'));
    this.photo = fs.readFileSync(path.join(ASSETS, 'sim-photo.jpg'));
    this.counter = 1;
    this.state = { state: 'starting' };
  }

  get name() {
    return 'simulator';
  }

  info() {
    return { backend: 'simulator' };
  }

  start() {
    this.state = { state: 'searching', message: 'Looking for the camera…' };
    this.emit('camera', this.state);
    setTimeout(() => {
      this.state = { state: 'connected', model: 'Canon EOS 60D (simulated)', serial: 'SIM0001', firmware: '1.1.1' };
      this.emit('camera', this.state);
      this.emitProps();
    }, 600);
  }

  stop() {
    clearInterval(this.evfTimer);
  }

  get props() {
    const w = writableInMode(this.values.mode);
    return {
      mode: { value: this.values.mode },
      iso: { value: this.values.iso, options: ISO, writable: w.iso },
      tv: { value: this.values.tv, options: TV, writable: w.tv },
      av: { value: this.values.av, options: AV, writable: w.av },
      wb: { value: this.values.wb, options: WB, writable: w.wb },
      battery: { value: 80 },
      shots: { value: 512 },
      lens: { value: 'Slit lamp adapter' },
    };
  }

  emitProps() {
    this.emit('props', this.props);
  }

  /** For testing: pretend the mode dial was turned. */
  setMode(mode) {
    this.values.mode = mode;
    this.emitProps();
  }

  setLiveView(on) {
    this.liveView = !!on;
    clearInterval(this.evfTimer);
    if (this.liveView) this.evfTimer = setInterval(() => this.emit('frame', this.frame), 66);
    this.emit('liveview', { on: this.liveView });
  }

  async setProp(key, label) {
    const p = this.props[key];
    if (!p) throw new Error(`Unknown setting “${key}”`);
    if (!p.writable) throw new Error(`Turn the mode dial to M to set ${key === 'tv' ? 'shutter speed' : key === 'av' ? 'aperture' : key} from Lumen (it is on ${this.values.mode}).`);
    if (!p.options.includes(label)) throw new Error(`${label} is not available on this camera right now.`);
    await new Promise((r) => setTimeout(r, 40));
    this.values[key] = label;
    this.emitProps();
  }

  async applyValues(values) {
    const applied = [];
    const skipped = [];
    for (const key of ['iso', 'wb', 'av', 'tv']) {
      if (values?.[key] == null) continue;
      try {
        await this.setProp(key, values[key]);
        applied.push(key);
      } catch (e) {
        skipped.push({ prop: key, reason: e.message });
      }
    }
    return { applied, skipped };
  }

  async capture(requestId) {
    if (this.state.state !== 'connected') throw new Error('The camera is not connected.');
    const exposure = { iso: this.values.iso, tv: this.values.tv, av: this.values.av, wb: this.values.wb, mode: this.values.mode };
    const at = Date.now();
    setTimeout(() => {
      const name = `IMG_${String(this.counter++).padStart(4, '0')}.JPG`;
      this.emit('photo', { requestId, name, data: this.photo, takenAt: at, exposure });
    }, 350);
  }

  reconnect() {
    this.start();
  }
}
