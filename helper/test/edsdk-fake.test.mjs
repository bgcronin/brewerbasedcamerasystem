// Drives the real EDSDK backend against test/fake-edsdk.c (see test/run-fake-sdk.sh).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';

const dir = process.env.EDSDK_TEST_LIB_DIR;
const gen = process.env.EDSDK_TEST_GEN ?? '13';
// Which way the fake camera misbehaves in this run (see fake-edsdk.c).
const scenario = process.env.FAKE_FAIL_SETCAPACITY ? 'fail-capacity' : process.env.FAKE_RAW_ONLY ? 'raw-only' : process.env.FAKE_BUTTON_SHOT_AFTER_MS ? 'button-shot' : 'normal';

const waitFor = (emitter, event, pred = () => true, ms = 4000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    const on = (v) => {
      if (pred(v)) {
        clearTimeout(t);
        emitter.off(event, on);
        resolve(v);
      }
    };
    emitter.on(event, on);
  });

async function makeBackend() {
  const { locateSdk } = await import('../src/edsdk/loader.js');
  const { EdsdkBackend } = await import('../src/edsdk/camera.js');
  const sdk = locateSdk({ sdkPath: dir, generation: gen });
  assert.ok(sdk.ok, 'library found');
  assert.equal(sdk.generation, Number(gen));
  return new EdsdkBackend({ sdk, log: () => {} });
}

const collect = (emitter, event) => {
  const seen = [];
  emitter.on(event, (v) => seen.push(v));
  return seen;
};

test(`EDSDK backend against the fake SDK (interface ${gen})`, { skip: !dir || scenario !== 'normal' }, async () => {
  const backend = await makeBackend();
  const notices = collect(backend, 'notice');
  const failures = collect(backend, 'capture-failed');
  const connected = waitFor(backend, 'camera', (s) => s.state === 'connected');
  backend.start();
  try {
    const cam = await connected;
    assert.equal(cam.model, 'Canon EOS 60D');
    assert.equal(cam.serial, '0123456789');

    const p = backend.props;
    assert.equal(p.mode.value, 'M', 'falls back from AEModeSelect to AEMode');
    assert.equal(p.iso.value, '400');
    assert.equal(p.tv.value, '1/125');
    assert.equal(p.av.value, 'f/8');
    assert.equal(p.wb.value, 'Flash');
    assert.equal(p.battery.value, 75);
    assert.equal(p.iso.options.length, 20);
    assert.ok(p.wb.options.includes('Daylight'), 'white balance falls back to a default list');
    assert.ok(p.tv.writable && p.av.writable);

    // Live view frames
    backend.setLiveView(true);
    const frame = await waitFor(backend, 'frame');
    assert.equal(frame[0], 0xff);
    assert.equal(frame[1], 0xd8);
    assert.match(frame.subarray(4, 13).toString(), /^EVF\d+/);

    // Settings
    await backend.setProp('iso', '1600');
    assert.equal(backend.props.iso.value, '1600');
    await assert.rejects(backend.setProp('iso', '99999'), /not available/);
    const res = await backend.applyValues({ iso: '800', tv: '1/60', av: 'f/11', wb: 'Daylight' });
    assert.deepEqual(res.applied.sort(), ['av', 'iso', 'tv', 'wb']);
    assert.deepEqual(res.skipped, []);
    assert.equal(backend.props.tv.value, '1/60');

    // Capture → download through a memory stream
    const photoP = waitFor(backend, 'photo');
    await backend.capture('req-1');
    const photo = await photoP;
    assert.equal(photo.requestId, 'req-1');
    assert.equal(photo.name, 'IMG_0001.JPG');
    assert.equal(photo.data.length, 200000);
    assert.equal(photo.data[0], 0xff);
    assert.equal(photo.data[photo.data.length - 1], 0xd9);
    assert.deepEqual({ iso: photo.exposure.iso, tv: photo.exposure.tv, av: photo.exposure.av }, { iso: '800', tv: '1/60', av: 'f/11' });
    assert.equal(backend.pendingCaptures.length, 0);

    // RAW + JPEG: the RAW stays on the card, the JPEG comes to Lumen
    if (process.env.FAKE_RAW_JPEG) {
      const second = waitFor(backend, 'photo');
      await backend.capture('req-2');
      const p2 = await second;
      assert.equal(p2.requestId, 'req-2');
      assert.match(p2.name, /\.JPG$/);
      assert.equal(backend.pendingCaptures.length, 0);
    }

    const off = once(backend, 'liveview');
    backend.setLiveView(false);
    const [lv] = await off;
    assert.equal(lv.on, false);
    assert.deepEqual(notices, [], 'no RAW warning when the JPEG arrived');
    assert.deepEqual(failures, []);
  } finally {
    backend.stop();
  }
});

test('a photo taken with the camera button is passed on without a request id', { skip: !dir || scenario !== 'button-shot' }, async () => {
  const backend = await makeBackend();
  const photos = collect(backend, 'photo');
  const connected = waitFor(backend, 'camera', (s) => s.state === 'connected');
  backend.start();
  try {
    await connected;
    const both = waitFor(backend, 'photo', () => photos.length === 2);
    await backend.capture('req-1');
    await both;
    assert.equal(photos[0].requestId, 'req-1');
    assert.equal(photos[0].name, 'IMG_0001.JPG');
    const byHand = photos[1];
    assert.equal(byHand.requestId, undefined);
    assert.equal(byHand.name, 'IMG_0002.JPG');
    assert.ok(Date.now() - byHand.takenAt < 2000, 'takenAt is when it arrived');
    assert.equal(byHand.exposure.iso, '400', 'carries the current camera settings');
    assert.equal(backend.pendingCaptures.length, 0);
  } finally {
    backend.stop();
  }
});

test('RAW only: the capture fails quickly with a clear message', { skip: !dir || scenario !== 'raw-only' }, async () => {
  const backend = await makeBackend();
  const photos = collect(backend, 'photo');
  const notices = collect(backend, 'notice');
  const connected = waitFor(backend, 'camera', (s) => s.state === 'connected');
  backend.start();
  try {
    await connected;
    const failed = waitFor(backend, 'capture-failed', () => true, 5000);
    await backend.capture('req-1');
    const f = await failed;
    assert.equal(f.requestId, 'req-1');
    assert.match(f.message, /RAW only/);
    assert.deepEqual(photos, []);
    assert.deepEqual(notices, [], 'the failure already says it; no extra notice');
    assert.equal(backend.pendingCaptures.length, 0);
  } finally {
    backend.stop();
  }
});

test('a failed configure() leaves no half-connected camera', { skip: !dir || scenario !== 'fail-capacity' }, async () => {
  const backend = await makeBackend();
  const errored = waitFor(backend, 'camera', (s) => s.state === 'error');
  backend.start();
  try {
    const s = await errored;
    assert.match(s.message, /EdsSetCapacity/);
    assert.equal(s.model, 'Canon EOS 60D');
    assert.equal(backend.camera, null);
    assert.equal(backend.handlers.length, 0, 'event handlers from the failed attempt are freed');
    await assert.rejects(backend.capture('req-1'), /not connected/);
  } finally {
    backend.stop();
  }
});

test('detects the SDK generation from EDSDK.h', async () => {
  const { detectGeneration, checkHeader } = await import('../src/edsdk/loader.js');
  assert.equal(detectGeneration('EdsError EDSAPI EdsDownload( EdsDirectoryItemRef inDirItemRef, EdsUInt64 inReadSize, EdsStreamRef outStream );'), 13);
  assert.equal(detectGeneration('EdsError EDSAPI EdsDownload( EdsDirectoryItemRef inDirItemRef, EdsUInt32 inReadSize, EdsStreamRef outStream );'), 3);
  assert.equal(detectGeneration('nothing here'), null);
  const warnings = checkHeader('EdsError EDSAPI EdsOpenSession( EdsCameraRef inCameraRef );\nEdsError EDSAPI EdsSendCommand( EdsCameraRef a, EdsCameraCommand b );');
  assert.ok(warnings.some((w) => w.startsWith('EdsSendCommand takes 2')));
  assert.ok(warnings.some((w) => w.startsWith('EdsDownload is not declared')));
  assert.ok(!warnings.some((w) => w.startsWith('EdsOpenSession')));
});

test('maps Canon codes to labels and back', async () => {
  const { labelFor, optionsFor, codeFor, writableInMode } = await import('../src/edsdk/values.js');
  assert.equal(labelFor('iso', 0x58), '400');
  assert.equal(labelFor('tv', 0x70), '1/125');
  assert.equal(labelFor('av', 0x38), 'f/8');
  assert.equal(labelFor('tv', 0xffffffff), null);
  assert.deepEqual(optionsFor('av', [0x14, 0x15, 0x18]), ['f/1.8', 'f/2']);
  assert.equal(codeFor('av', 'f/1.8', [0x15, 0x18]), 0x15, 'chooses the code the camera currently offers');
  assert.equal(codeFor('iso', 'ISO 400'), 0x58);
  assert.equal(writableInMode('Av').tv, false);
});
