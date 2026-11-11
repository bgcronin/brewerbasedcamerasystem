#!/usr/bin/env node
// Builds Lumen (the web app in the folder above this one) for the Camera Link launchers.
//
//   node src/build-lumen.js
//
// Lumen is rebuilt only when its source has changed since the last build. The new build goes into a
// temporary folder and takes the place of dist/ only once it has succeeded, so a build that fails or
// is interrupted never leaves Lumen without a working copy: the previous one stays where it is.
// Nothing here stops Camera Link from starting; whatever happens, the launcher carries on.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Kept inside dist/: what the source looked like when it was built. */
const STAMP_FILE = '.lumen-build';
/** Everything a build is made from. */
const SOURCES = ['src', 'public', 'scripts', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json'];
/** public/ocr is copied in by the build itself, so it is a product, not a source. */
const NOT_SOURCE = new Set(['node_modules', 'dist', 'ocr']);
/** Inside node_modules so that it is ignored by git and by the build. */
const WORK_DIR = path.join('node_modules', '.lumen-build');
const BUILD_TOOLS = ['vite', 'typescript'];

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function listFiles(target, out = []) {
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    return out;
  }
  if (st.isFile()) out.push(target);
  else if (st.isDirectory()) {
    for (const name of fs.readdirSync(target).sort()) {
      if (!NOT_SOURCE.has(name) && !name.startsWith('.')) listFiles(path.join(target, name), out);
    }
  }
  return out;
}

/** A fingerprint of Lumen's source: it changes whenever any file a build is made from changes. */
export function sourceStamp(root) {
  const hash = crypto.createHash('sha1');
  for (const entry of SOURCES) {
    for (const file of listFiles(path.join(root, entry))) {
      hash.update(path.relative(root, file).split(path.sep).join('/'));
      hash.update('\0');
      hash.update(fs.readFileSync(file));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

function builtStamp(root) {
  try {
    if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) return null;
    return fs.readFileSync(path.join(root, 'dist', STAMP_FILE), 'utf8').trim();
  } catch {
    return null;
  }
}

const hasBuildTools = (root) => BUILD_TOOLS.every((name) => fs.existsSync(path.join(root, 'node_modules', name, 'package.json')));

/** Run a command line in a folder. `show` lets its output through as it happens (for the slow install). */
function runCommand(command, cwd, { show = false } = {}) {
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', stdio: show ? 'inherit' : ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
}

/** Windows can refuse to move a folder for a moment while a virus scanner or a sync program looks at it. */
function renameWithPatience(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e;
      sleep(300);
    }
  }
}

/** Put a finished build in place of dist/. If that cannot be done, the previous dist/ is put back. */
function swapIn(root, fresh) {
  const dist = path.join(root, 'dist');
  const previous = path.join(root, WORK_DIR, 'previous');
  fs.rmSync(previous, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const hadPrevious = fs.existsSync(dist);
  if (hadPrevious) renameWithPatience(dist, previous);
  try {
    renameWithPatience(fresh, dist);
  } catch (e) {
    if (hadPrevious) renameWithPatience(previous, dist);
    throw e;
  }
}

/**
 * Make sure dist/ holds a build of the current source.
 * @returns {'up-to-date'|'built'|'kept-previous'|'no-build'|'no-source'}
 */
export function prepareLumen({ root = ROOT, run = runCommand, say = (line) => console.log(line) } = {}) {
  const work = path.join(root, WORK_DIR);
  const tidy = () => {
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* left for next time */
    }
  };
  const keepPrevious = () => {
    tidy();
    if (fs.existsSync(path.join(root, 'dist', 'index.html'))) {
      say('Lumen could not be rebuilt, so the previous build is used. It still works; it is just not the newest.');
      return 'kept-previous';
    }
    say('Lumen has not been built, so Camera Link starts without it. Fix the problem shown above and start again.');
    return 'no-build';
  };

  if (!fs.existsSync(path.join(root, 'package.json')) || !fs.existsSync(path.join(root, 'index.html'))) {
    say('Lumen’s own files are not in the folder above Camera Link, so there is nothing to build.');
    return 'no-source';
  }
  let stamp;
  try {
    stamp = sourceStamp(root);
    if (builtStamp(root) === stamp) return 'up-to-date';

    if (!hasBuildTools(root)) {
      say('Getting what is needed to build Lumen. This happens once, takes a few minutes and needs the internet…');
      const install = run('npm install --no-audit --no-fund', root, { show: true });
      if (!install.ok || !hasBuildTools(root)) {
        if (install.output) say(install.output.trim());
        say('Could not get what is needed to build Lumen (npm install failed). Check the internet connection and start again.');
        return keepPrevious();
      }
    }

    say('Building Lumen (it has changed since the last start)…');
    tidy();
    const fresh = path.join(work, 'dist');
    const build = run(`npm run build -- --outDir "${WORK_DIR.split(path.sep).join('/')}/dist"`, root);
    if (!build.ok || !fs.existsSync(path.join(fresh, 'index.html'))) {
      // Show why, so it can be fixed or passed on: the last part of the output is where the error is.
      const tail = build.output.trim().split(/\r?\n/).slice(-40).join('\n');
      say('Building Lumen failed:');
      say(tail || '(the build gave no output)');
      return keepPrevious();
    }
    fs.writeFileSync(path.join(fresh, STAMP_FILE), stamp);
    swapIn(root, fresh);
    tidy();
    say('Lumen is built.');
    return 'built';
  } catch (e) {
    say(`Building Lumen stopped: ${e?.message ?? e}`);
    return keepPrevious();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareLumen();
}
