#!/usr/bin/env node
// Lumen Camera Link — connects a Canon EOS to Lumen through Canon's EDSDK.
//
//   node src/main.js              use the camera (needs Canon's SDK in helper/sdk)
//   node src/main.js --simulate   a pretend EOS 60D, for trying Lumen without the camera
//
// Options: --port 47800  --open  --no-serve  --save-to both|host  --no-live-view
//          --unfiled-dir <folder>  --sdk <path>  --sdk-generation 3|13
//          --allow-origin https://lumen.example.org
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createServer } from './server.js';
import { SimulatorBackend } from './simulator.js';
import { DEFAULT_SDK_DIR, locateSdk } from './edsdk/loader.js';
import { disableQuickEdit } from './win-console.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;

function parseArgs(argv) {
  const args = { allowOrigins: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--simulate') args.simulate = true;
    else if (a === '--sim-mode') args.simMode = next();
    else if (a === '--open') args.open = true;
    else if (a === '--no-serve') args.noServe = true;
    else if (a === '--no-live-view') args.noLiveView = true;
    else if (a === '--port') args.port = Number(next());
    else if (a === '--sdk') args.sdk = next();
    else if (a === '--sdk-generation') args.generation = next();
    else if (a === '--save-to') args.saveTo = next();
    else if (a === '--unfiled-dir') args.unfiledDir = next();
    else if (a === '--allow-origin') args.allowOrigins.push(next());
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

/** Stands in when the SDK can't be used, so Lumen can explain what's wrong. */
class UnavailableBackend extends EventEmitter {
  constructor(message) {
    super();
    this.state = { state: 'unavailable', message };
    this.props = {};
  }
  get name() {
    return 'unavailable';
  }
  info() {
    return { backend: 'unavailable' };
  }
  start() {}
  stop() {}
  setLiveView() {}
  async capture() {
    throw new Error(this.state.message);
  }
  async setProp() {
    throw new Error(this.state.message);
  }
  async applyValues() {
    throw new Error(this.state.message);
  }
  reconnect() {}
}

// Lines are printed a moment after they are written, in order: at the end of the current piece of work
// rather than in the middle of it. A console that is slow, or held up by a click in its window, then
// never delays a photo that is on its way to Lumen.
const lines = [];
const printLines = () => {
  if (lines.length) console.log(lines.splice(0).join('\n'));
};
const say = (line) => {
  if (!lines.length) setImmediate(printLines);
  lines.push(line);
};
const log = (m) => say(`[camera-link] ${m}`);
process.on('exit', printLines);

async function makeBackend(args) {
  if (args.simulate) return new SimulatorBackend({ log, mode: args.simMode ?? 'M' });
  const sdk = locateSdk({ sdkPath: args.sdk, generation: args.generation });
  if (!sdk.ok) {
    const msg = `Canon SDK not found. Unzip Canon’s EDSDK into ${DEFAULT_SDK_DIR} (see helper/sdk/README.md).`;
    log(msg);
    return new UnavailableBackend(msg);
  }
  log(`Canon SDK: ${sdk.libPath}`);
  log(`interface: EDSDK ${sdk.generation === 3 ? '3.x' : '13.x'} (from ${sdk.generationSource})${sdk.version ? `, version ${sdk.version}` : ''}`);
  try {
    const { EdsdkBackend } = await import('./edsdk/camera.js');
    return new EdsdkBackend({ sdk, saveTo: args.saveTo === 'host' ? 'host' : 'both', log });
  } catch (e) {
    log(e.message);
    return new UnavailableBackend(e.message);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n').replace(/^\/\/ ?/gm, ''));
    return;
  }
  await disableQuickEdit();
  const backend = await makeBackend(args);

  // Take the port before touching the camera. A second copy started by mistake then stops here,
  // and leaves the camera to the one that is already running.
  const distDir = path.resolve(HERE, '..', '..', 'dist');
  const port = args.port || 47800;
  let srv;
  try {
    srv = await createServer({
      backend,
      port,
      distDir: !args.noServe && fs.existsSync(distDir) ? distDir : undefined,
      allowOrigins: args.allowOrigins,
      unfiledDir: args.unfiledDir,
      liveView: !args.noLiveView,
      version: VERSION,
      log,
    });
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      log(`Port ${port} is already in use — Lumen Camera Link is probably running already (look for its window). This second copy will close.`);
    } else if (e.code === 'EACCES') {
      log(`This computer does not let Camera Link use port ${port}. Start it with another one, for example --port 47801, and in Lumen’s Settings set the Camera Link address to ws://127.0.0.1:47801/camera.`);
    } else {
      throw e;
    }
    try {
      backend.stop();
    } catch {
      /* it was never started */
    }
    process.exit(1);
  }

  try {
    backend.start();
  } catch (e) {
    log(e?.message ?? String(e));
  }

  const url = `http://localhost:${port}/`;
  say(`\n  Lumen Camera Link ${VERSION}${args.simulate ? ' (simulated camera)' : ''}`);
  say(`  Open Lumen at ${url}`);
  say(`  Photos that can’t be handed to Lumen are saved in: ${srv.unfiledDir}`);
  if (args.noLiveView) say('  Live view is switched off for this run (--no-live-view).');
  say('  Keep this window open while you work. Press Ctrl+C to stop.\n');
  if (args.open) {
    const cmd = process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
    exec(cmd);
  }

  let stopping = false;
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    log('stopping');
    setTimeout(() => process.exit(code), 2000).unref();
    try {
      // Switches live view off and closes the camera session, so the camera goes back to working on its own.
      backend.stop();
    } catch {
      /* ignore */
    }
    await srv.close();
    process.exit(code);
  };
  // Ctrl+C, a polite stop, and closing the window (SIGHUP; on Windows also Ctrl+Break) all leave the camera tidy.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(0));
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown(0));
  process.on('uncaughtException', (e) => {
    console.error(e);
    void shutdown(1);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
