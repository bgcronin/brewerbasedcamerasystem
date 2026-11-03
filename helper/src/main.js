#!/usr/bin/env node
// Lumen Camera Link — connects a Canon EOS to Lumen through Canon's EDSDK.
//
//   node src/main.js              use the camera (needs Canon's SDK in helper/sdk)
//   node src/main.js --simulate   a pretend EOS 60D, for trying Lumen without the camera
//
// Options: --port 47800  --open  --no-serve  --save-to both|host
//          --sdk <path>  --sdk-generation 3|13  --allow-origin https://lumen.example.org
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createServer } from './server.js';
import { SimulatorBackend } from './simulator.js';
import { DEFAULT_SDK_DIR, locateSdk } from './edsdk/loader.js';

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
    else if (a === '--port') args.port = Number(next());
    else if (a === '--sdk') args.sdk = next();
    else if (a === '--sdk-generation') args.generation = next();
    else if (a === '--save-to') args.saveTo = next();
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

const log = (m) => console.log(`[camera-link] ${m}`);

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
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 8).join('\n').replace(/^\/\/ ?/gm, ''));
    return;
  }
  let backend = await makeBackend(args);
  try {
    backend.start();
  } catch (e) {
    log(e.message);
    backend = new UnavailableBackend(e.message);
  }

  const distDir = path.resolve(HERE, '..', '..', 'dist');
  const port = args.port || 47800;
  let srv;
  try {
    srv = await createServer({
      backend,
      port,
      distDir: !args.noServe && fs.existsSync(distDir) ? distDir : undefined,
      allowOrigins: args.allowOrigins,
      version: VERSION,
      log,
    });
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      log(`Port ${port} is already in use — Lumen Camera Link may already be running.`);
      process.exit(1);
    }
    throw e;
  }

  const url = `http://localhost:${port}/`;
  console.log(`\n  Lumen Camera Link ${VERSION}${args.simulate ? ' (simulated camera)' : ''}`);
  console.log(`  Open Lumen at ${url}\n  Keep this window open while you work. Press Ctrl+C to stop.\n`);
  if (args.open) {
    const cmd = process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
    exec(cmd);
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log('stopping');
    setTimeout(() => process.exit(0), 2000).unref();
    try {
      backend.stop();
    } catch {
      /* ignore */
    }
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
