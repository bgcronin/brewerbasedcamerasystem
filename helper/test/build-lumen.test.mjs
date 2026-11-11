// The launchers build Lumen through src/build-lumen.js. Whatever a build does, Lumen must never be left without one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareLumen, sourceStamp } from '../src/build-lumen.js';

/** A pretend Lumen folder, with the build tools "installed" unless asked otherwise. */
function makeRoot({ tools = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-build-'));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('package.json', '{"name":"lumen"}');
  write('index.html', '<!doctype html>');
  write('src/main.tsx', 'export const version = 1;');
  write('public/icon.svg', '<svg/>');
  write('public/ocr/engine.wasm', 'copied in by the build');
  if (tools) for (const name of ['vite', 'typescript']) write(`node_modules/${name}/package.json`, '{}');
  return { root, write, read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'), has: (rel) => fs.existsSync(path.join(root, rel)) };
}

/** Stands in for npm: records what was run, and "builds" by writing what `build` says into the folder asked for. */
function fakeNpm(lumen, { build = () => ({ 'index.html': 'built' }), install = () => true } = {}) {
  const commands = [];
  const run = (command, cwd) => {
    commands.push(command);
    assert.equal(cwd, lumen.root);
    if (command.startsWith('npm install')) {
      const ok = install();
      return { ok, output: ok ? '' : 'npm ERR! network unreachable' };
    }
    const outDir = command.match(/--outDir "([^"]+)"/)[1];
    let files;
    try {
      files = build();
    } catch (e) {
      return { ok: false, output: `some output\n${e.message}` };
    }
    for (const [rel, text] of Object.entries(files)) lumen.write(path.join(outDir, rel), text);
    return { ok: true, output: 'vite v8 building…' };
  };
  return { run, commands };
}

const quiet = () => {};

test('builds once, then only again when the source has changed', () => {
  const lumen = makeRoot();
  try {
    let n = 0;
    const npm = fakeNpm(lumen, { build: () => ({ 'index.html': `build ${++n}`, 'assets/app.js': 'js' }) });
    assert.equal(prepareLumen({ root: lumen.root, run: npm.run, say: quiet }), 'built');
    assert.equal(lumen.read('dist/index.html'), 'build 1');
    assert.equal(lumen.read('dist/.lumen-build'), sourceStamp(lumen.root));
    assert.ok(!lumen.has('node_modules/.lumen-build'), 'the work folder is tidied away');

    assert.equal(prepareLumen({ root: lumen.root, run: npm.run, say: quiet }), 'up-to-date');
    lumen.write('public/ocr/engine.wasm', 'copied in again'); // a product of the build, not a source
    assert.equal(prepareLumen({ root: lumen.root, run: npm.run, say: quiet }), 'up-to-date');
    assert.equal(npm.commands.length, 1, 'nothing was run when nothing had changed');

    lumen.write('src/main.tsx', 'export const version = 2;');
    assert.equal(prepareLumen({ root: lumen.root, run: npm.run, say: quiet }), 'built');
    assert.equal(lumen.read('dist/index.html'), 'build 2');
    assert.equal(lumen.read('dist/assets/app.js'), 'js');
    assert.ok(npm.commands.every((c) => /^npm run build -- --outDir "node_modules\/\.lumen-build\/dist"$/.test(c)), 'built into a spare folder, never straight into dist');
  } finally {
    fs.rmSync(lumen.root, { recursive: true, force: true });
  }
});

test('a build that fails leaves the previous build exactly as it was, and shows why', () => {
  const lumen = makeRoot();
  try {
    assert.equal(prepareLumen({ root: lumen.root, run: fakeNpm(lumen).run, say: quiet }), 'built');
    const before = lumen.read('dist/.lumen-build');
    lumen.write('src/main.tsx', 'export const version = "broken";');

    const said = [];
    const failing = fakeNpm(lumen, {
      build: () => {
        // It got part of the way before stopping.
        lumen.write('node_modules/.lumen-build/dist/assets/half.js', 'partial');
        throw new Error("src/main.tsx(1,1): error TS2322: Type 'string' is not assignable to type 'number'.");
      },
    });
    assert.equal(prepareLumen({ root: lumen.root, run: failing.run, say: (l) => said.push(l) }), 'kept-previous');
    assert.equal(lumen.read('dist/index.html'), 'built');
    assert.equal(lumen.read('dist/.lumen-build'), before, 'still marked as the older source, so the next start tries again');
    assert.ok(!lumen.has('dist/assets/half.js'));
    assert.ok(!lumen.has('node_modules/.lumen-build'));
    assert.ok(said.some((l) => /error TS2322/.test(l)), 'the build’s own error is shown');
    assert.ok(said.some((l) => /previous build is used/.test(l)));

    // "Succeeded" without producing the app counts as a failure too.
    const empty = fakeNpm(lumen, { build: () => ({ 'assets/app.js': 'js' }) });
    assert.equal(prepareLumen({ root: lumen.root, run: empty.run, say: quiet }), 'kept-previous');
    assert.equal(lumen.read('dist/index.html'), 'built');

    // Once it builds again, the new one takes over.
    assert.equal(prepareLumen({ root: lumen.root, run: fakeNpm(lumen, { build: () => ({ 'index.html': 'fixed' }) }).run, say: quiet }), 'built');
    assert.equal(lumen.read('dist/index.html'), 'fixed');
  } finally {
    fs.rmSync(lumen.root, { recursive: true, force: true });
  }
});

test('a first build that fails says that Lumen is not built, and leaves no half-made dist', () => {
  const lumen = makeRoot();
  try {
    const said = [];
    const failing = fakeNpm(lumen, {
      build: () => {
        throw new Error('vite: could not resolve entry');
      },
    });
    assert.equal(prepareLumen({ root: lumen.root, run: failing.run, say: (l) => said.push(l) }), 'no-build');
    assert.ok(!lumen.has('dist'));
    assert.ok(said.some((l) => /could not resolve entry/.test(l)));
    assert.ok(said.some((l) => /has not been built/.test(l)));
  } finally {
    fs.rmSync(lumen.root, { recursive: true, force: true });
  }
});

test('the build tools are installed first when they are missing, and a failed install is said plainly', () => {
  const lumen = makeRoot({ tools: false });
  try {
    const said = [];
    const offline = fakeNpm(lumen, { install: () => false });
    assert.equal(prepareLumen({ root: lumen.root, run: offline.run, say: (l) => said.push(l) }), 'no-build');
    assert.deepEqual(offline.commands, ['npm install --no-audit --no-fund'], 'no build is attempted without the tools');
    assert.ok(said.some((l) => /npm install failed/.test(l)));

    const online = fakeNpm(lumen, {
      install: () => {
        for (const name of ['vite', 'typescript']) lumen.write(`node_modules/${name}/package.json`, '{}');
        return true;
      },
    });
    assert.equal(prepareLumen({ root: lumen.root, run: online.run, say: quiet }), 'built');
    assert.equal(online.commands.length, 2);
    assert.equal(lumen.read('dist/index.html'), 'built');
  } finally {
    fs.rmSync(lumen.root, { recursive: true, force: true });
  }
});

test('Camera Link on its own, without Lumen’s source beside it, is left alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-build-'));
  try {
    const npm = { commands: [] };
    assert.equal(prepareLumen({ root, run: (c) => (npm.commands.push(c), { ok: true, output: '' }), say: quiet }), 'no-source');
    assert.deepEqual(npm.commands, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
