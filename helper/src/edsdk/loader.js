// Finds Canon's EDSDK on disk and works out which generation it is.
//
// Put the SDK you downloaded from Canon in helper/sdk/ (any folder layout is
// fine — Canon's own zip layout works as-is), or point EDSDK_PATH at it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_SDK_DIR = path.join(HELPER_DIR, 'sdk');

function walk(dir, depth, visit) {
  if (depth < 0) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (visit(full, e) === false) continue;
    if (e.isDirectory() && !e.name.endsWith('.framework')) walk(full, depth - 1, visit);
  }
}

function findLibraries(root) {
  const found = [];
  if (fs.existsSync(root) && fs.statSync(root).isFile()) return [root];
  walk(root, 7, (full, e) => {
    if (process.platform === 'win32' && e.isFile() && /^edsdk\.dll$/i.test(e.name)) found.push(full);
    if (process.platform === 'darwin' && e.isDirectory() && /^EDSDK\.framework$/i.test(e.name)) {
      const bin = path.join(full, 'EDSDK');
      if (fs.existsSync(bin)) found.push(bin);
      else {
        const v = path.join(full, 'Versions', 'A', 'EDSDK');
        if (fs.existsSync(v)) found.push(v);
      }
      return false;
    }
    if (process.platform !== 'win32' && e.isFile() && /^libEDSDK\.(so|dylib)$/i.test(e.name)) found.push(full);
    return true;
  });
  return found;
}

/** Prefer the 64-bit build on 64-bit Node (Canon ships EDSDK/Dll for 32-bit and EDSDK_64/Dll for 64-bit). */
function pickLibrary(libs, root) {
  if (!libs.length) return null;
  const is64 = process.arch === 'x64' || process.arch === 'arm64';
  const scored = libs.map((p) => {
    // Only the path inside the SDK folder counts; an ancestor such as "lumen-win64" must not.
    const rel = path.relative(root, p);
    let score = 0;
    if (is64 && rel.split(/[\\/]/).some((seg) => /^EDSDK_64$/i.test(seg))) score += 20;
    if (/_64|x64|amd64|win64/i.test(rel)) score += is64 ? 10 : -10;
    if (/arm64/i.test(rel)) score += process.arch === 'arm64' ? 5 : -5;
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].p;
}

function findHeader(root, libPath) {
  const roots = [path.dirname(libPath), path.resolve(path.dirname(libPath), '..'), path.resolve(path.dirname(libPath), '..', '..'), root];
  for (const r of roots) {
    let hit = null;
    walk(r, 4, (full, e) => {
      if (hit) return false;
      if (e.isFile() && e.name === 'EDSDK.h') hit = full;
      return true;
    });
    if (hit) return hit;
  }
  return null;
}

/**
 * EDSDK 13.x widened stream and download sizes to 64 bits; 3.x uses 32 bits.
 * Reading the header tells us which, so the same helper works with either.
 */
export function detectGeneration(headerText) {
  if (!headerText) return null;
  const m = headerText.match(/EdsDownload\s*\(([^;]*?)\)\s*;/s);
  if (!m) return null;
  return /EdsUInt64/.test(m[1]) ? 13 : 3;
}

function versionFromPath(p) {
  const m = p.match(/v?(\d{1,2})[._](\d{1,2})[._](\d{1,2})(?:[._](\d{1,3}))?/i);
  return m ? m.slice(1).filter(Boolean).join('.') : undefined;
}

/** Function names Lumen relies on, and how many parameters each takes. */
export const EXPECTED_ARITY = {
  EdsGetCameraList: 1,
  EdsGetChildCount: 2,
  EdsGetChildAtIndex: 3,
  EdsGetDeviceInfo: 2,
  EdsOpenSession: 1,
  EdsCloseSession: 1,
  EdsGetPropertySize: 5,
  EdsGetPropertyData: 5,
  EdsSetPropertyData: 5,
  EdsGetPropertyDesc: 3,
  EdsSendCommand: 3,
  EdsSendStatusCommand: 3,
  EdsSetCapacity: 2,
  EdsGetDirectoryItemInfo: 2,
  EdsDownload: 3,
  EdsDownloadCancel: 1,
  EdsDownloadComplete: 1,
  EdsCreateMemoryStream: 2,
  EdsGetPointer: 2,
  EdsGetLength: 2,
  EdsCreateEvfImageRef: 2,
  EdsDownloadEvfImage: 2,
  EdsSetObjectEventHandler: 4,
  EdsSetPropertyEventHandler: 4,
  EdsSetCameraStateEventHandler: 4,
};

/** Compare our expectations with the installed header and report anything surprising. */
export function checkHeader(headerText) {
  const warnings = [];
  for (const [name, arity] of Object.entries(EXPECTED_ARITY)) {
    const m = headerText.match(new RegExp(`\\b${name}\\s*\\(([^;]*?)\\)\\s*;`, 's'));
    if (!m) {
      warnings.push(`${name} is not declared in EDSDK.h`);
      continue;
    }
    const params = m[1].replace(/\/\*.*?\*\//gs, '').replace(/\/\/.*$/gm, '').trim();
    const count = params === '' || params === 'void' ? 0 : params.split(',').length;
    if (count !== arity) warnings.push(`${name} takes ${count} parameters in EDSDK.h (expected ${arity})`);
  }
  return warnings;
}

export function locateSdk({ sdkPath = process.env.EDSDK_PATH, generation = process.env.EDSDK_GENERATION } = {}) {
  const root = sdkPath ? path.resolve(sdkPath) : DEFAULT_SDK_DIR;
  const libPath = pickLibrary(findLibraries(root), root);
  if (!libPath) return { ok: false, root };

  const headerPath = findHeader(root, libPath);
  const headerText = headerPath ? fs.readFileSync(headerPath, 'latin1') : null;
  const detected = detectGeneration(headerText);
  const gen = generation ? Number(generation) : detected ?? 13;
  return {
    ok: true,
    root,
    libPath,
    headerPath,
    generation: gen === 3 ? 3 : 13,
    generationSource: generation ? 'setting' : detected ? 'header' : 'default',
    version: versionFromPath(libPath) ?? (headerPath ? versionFromPath(headerPath) : undefined),
    warnings: headerText ? checkHeader(headerText) : ['EDSDK.h not found next to the library; assuming the 13.x interface'],
  };
}
