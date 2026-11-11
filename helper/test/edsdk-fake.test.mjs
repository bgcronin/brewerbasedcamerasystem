// Drives the real EDSDK backend against test/fake-edsdk.c (see test/run-fake-sdk.sh).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';

const dir = process.env.EDSDK_TEST_LIB_DIR;
const gen = process.env.EDSDK_TEST_GEN ?? '13';
// Which way the fake camera behaves in this run (see fake-edsdk.c and run-fake-sdk.sh).
const scenario =
  process.env.EDSDK_TEST_SCENARIO ??
  (process.env.FAKE_FAIL_SETCAPACITY ? 'fail-capacity' : process.env.FAKE_RAW_ONLY ? 'raw-only' : process.env.FAKE_BUTTON_SHOT_AFTER_MS ? 'button-shot' : 'normal');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function makeBackend(opts = {}) {
  const { locateSdk } = await import('../src/edsdk/loader.js');
  const { EdsdkBackend } = await import('../src/edsdk/camera.js');
  const sdk = locateSdk({ sdkPath: dir, generation: gen });
  assert.ok(sdk.ok, 'library found');
  assert.equal(sdk.generation, Number(gen));
  return new EdsdkBackend({ sdk, log: () => {}, ...opts });
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
  const incoming = collect(backend, 'incoming');
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
    assert.deepEqual(incoming, [], 'a shot from Lumen is not announced as one from the camera’s button');
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

test('the camera button with no shot from Lumen first: one photo, once', { skip: !dir || scenario !== 'cold-button' }, async () => {
  const lines = [];
  const backend = await makeBackend({ log: (m) => lines.push(m) });
  const photos = collect(backend, 'photo');
  const order = [];
  backend.on('incoming', (i) => order.push(`incoming ${i.name}`));
  backend.on('photo', (p) => order.push(`photo ${p.name}`));
  const connected = waitFor(backend, 'camera', (s) => s.state === 'connected');
  backend.start();
  try {
    await connected;
    const photo = await waitFor(backend, 'photo');
    assert.equal(photo.requestId, undefined);
    assert.equal(photo.name, 'IMG_0001.JPG');
    assert.equal(photo.data.length, 200000);
    assert.deepEqual(order, ['incoming IMG_0001.JPG', 'photo IMG_0001.JPG'], 'Lumen is told a photo is coming before the file is fetched, once');
    // The memory card's copy of the same file (announced before or after) must not arrive as a second photo.
    await sleep(3200);
    assert.equal(photos.length, 1, 'the card copy is not delivered again');
    assert.equal(backend.cardItems.size, 0);
    assert.ok(lines.some((l) => /0x208 .*IMG_0001\.JPG/.test(l)), 'the transfer request is logged with its file name');
    assert.ok(lines.some((l) => /0x204 .*IMG_0001\.JPG/.test(l)), 'the card event is logged with its file name');
    assert.ok(lines.some((l) => /photos are saved to: memory card \+ computer \(camera reports 3/.test(l) && /shots available: 400/.test(l) && /EdsGetEvent/.test(l)), 'connect diagnostics');
    assert.ok(!lines.some((l) => /NO EVENTS/.test(l)), 'events arrived, so no alarm');
    assert.ok(backend.info().events.object >= 2 && backend.info().events.property >= 1, 'events are counted');
  } finally {
    backend.stop();
  }
});

test('a camera that only saves to its card: photos are fetched from the card', { skip: !dir || scenario !== 'card-only' }, async () => {
  const lines = [];
  const backend = await makeBackend({ log: (m) => lines.push(m) });
  const photos = collect(backend, 'photo');
  const failures = collect(backend, 'capture-failed');
  const connected = waitFor(backend, 'camera', (s) => s.state === 'connected');
  backend.start();
  try {
    await connected;
    const started = Date.now();
    const byHand = await waitFor(backend, 'photo', () => true, 6000);
    assert.ok(Date.now() - started >= 2300, 'waits for a transfer request before using the card');
    assert.equal(byHand.requestId, undefined);
    assert.equal(byHand.name, 'IMG_0001.JPG');
    assert.equal(byHand.data.length, 200000);
    assert.ok(lines.some((l) => /fetching it from the card/.test(l)));
    assert.ok(lines.some((l) => /camera reports 1, memory card only/.test(l)), 'the connect line shows what the camera really does');

    // A shot from Lumen comes the same way and still belongs to its request.
    const second = waitFor(backend, 'photo', (p) => p.name === 'IMG_0002.JPG', 6000);
    await backend.capture('req-1');
    assert.equal((await second).requestId, 'req-1');
    await sleep(500);
    assert.equal(photos.length, 2);
    assert.deepEqual(failures, []);
    assert.equal(backend.pendingCaptures.length, 0);
    assert.ok(lines.filter((l) => /setting it again/.test(l)).length <= 3, 'gives up repairing the setting after a few tries');
  } finally {
    backend.stop();
  }
});

test('a transfer request that comes after the card fetch is declined, not delivered twice', { skip: !dir || scenario !== 'late-request' }, async () => {
  const lines = [];
  const backend = await makeBackend({ log: (m) => lines.push(m) });
  const photos = collect(backend, 'photo');
  const connected = waitFor(backend, 'camera', (s) => s.state === 'connected');
  backend.start();
  try {
    await connected;
    await waitFor(backend, 'photo', () => true, 6000);
    await sleep(2000); // the late request arrives in here
    assert.equal(photos.length, 1);
    assert.ok(lines.some((l) => /late offer is declined/.test(l)));
  } finally {
    backend.stop();
  }
});

test('RAW+JPEG pairs in either order: one photo each, no RAW warning', { skip: !dir || scenario !== 'pairs' }, async () => {
  const backend = await makeBackend();
  const photos = collect(backend, 'photo');
  const notices = collect(backend, 'notice');
  const failures = collect(backend, 'capture-failed');
  const connected = waitFor(backend, 'camera', (s) => s.state === 'connected');
  backend.start();
  try {
    await connected;
    const both = waitFor(backend, 'photo', () => photos.length === 2);
    await backend.capture('req-1');
    await both; // the second is the fake's "camera button" shot
    assert.deepEqual(photos.map((p) => [p.requestId, p.name]), [['req-1', 'IMG_0001.JPG'], [undefined, 'IMG_0002.JPG']]);
    await sleep(3500);
    assert.equal(photos.length, 2);
    assert.deepEqual(notices, [], 'a RAW whose JPEG arrived (before or after it) is not reported');
    assert.deepEqual(failures, []);
    assert.equal(backend.pendingCaptures.length, 0);
  } finally {
    backend.stop();
  }
});

test('a photo that arrives after its shot was given up on still belongs to that shot', { skip: !dir || scenario !== 'late-photo' }, async () => {
  // The fake hands each file over 900 ms late; this backend gives a shot up after 400 ms.
  const backend = await makeBackend({ saveTo: 'host', captureTimeoutMs: 400, matchWindowMs: 150 });
  const photos = collect(backend, 'photo');
  const failures = collect(backend, 'capture-failed');
  const incoming = collect(backend, 'incoming');
  const connected = waitFor(backend, 'camera', (s) => s.state === 'connected');
  backend.start();
  try {
    await connected;
    const first = waitFor(backend, 'photo');
    await backend.capture('req-1');
    const failed = await waitFor(backend, 'capture-failed');
    assert.equal(failed.requestId, 'req-1');
    assert.match(failed.message, /No photo arrived/);
    assert.deepEqual(photos, [], 'given up on before the file came');
    const late = await first;
    assert.equal(late.requestId, 'req-1', 'the late file still carries the request, so Lumen can file it where it was meant');
    assert.equal(late.name, 'IMG_0001.JPG');
    assert.deepEqual(incoming, [], 'and is not announced as a camera-button photo');

    // The camera's own button afterwards is its own photo: the given-up shot was used up by the late file.
    const byHand = await waitFor(backend, 'photo', (p) => p.name === 'IMG_0002.JPG', 5000);
    assert.equal(byHand.requestId, undefined);
    assert.deepEqual(incoming.map((i) => i.name), ['IMG_0002.JPG']);
    assert.equal(failures.length, 1);
    assert.equal(backend.pendingCaptures.length, 0);
    assert.equal(backend.expiredCaptures.length, 0);
  } finally {
    backend.stop();
  }
});

test('a busy camera on connecting keeps the memory card copy', { skip: !dir || scenario !== 'saveto-busy' }, async () => {
  const { PropID } = await import('../src/edsdk/constants.js');
  const backend = await makeBackend();
  const states = collect(backend, 'camera');
  const connected = waitFor(backend, 'camera', (s) => s.state === 'connected');
  backend.start();
  try {
    await connected;
    assert.equal(backend.saveTo, 'both');
    assert.equal(backend.readUInt32(PropID.SaveTo), 3);
    assert.ok(!states.some((s) => s.state === 'error'), 'no error state on the way');
  } finally {
    backend.stop();
  }
});

test('a lost connection found by a shutter press leads to a reconnect', { skip: !dir || scenario !== 'gone' }, async () => {
  const backend = await makeBackend();
  const states = collect(backend, 'camera');
  const connected = waitFor(backend, 'camera', (s) => s.state === 'connected');
  backend.start();
  try {
    await connected;
    const again = waitFor(backend, 'camera', (s) => s.state === 'connected', 5000);
    await assert.rejects(backend.capture('req-1'), /disconnected/);
    assert.equal(backend.camera, null, 'the dead session is dropped at once');
    assert.equal(states.at(-1).state, 'searching');
    await again;
    assert.equal(backend.pendingCaptures.length, 0);
  } finally {
    backend.stop();
  }
});

test('saving to the computer only keeps the RAW file instead of discarding it', { skip: !dir || scenario !== 'host-raw' }, async () => {
  const backend = await makeBackend({ saveTo: 'host' });
  const raws = collect(backend, 'raw');
  const connected = waitFor(backend, 'camera', (s) => s.state === 'connected');
  backend.start();
  try {
    await connected;
    const photoP = waitFor(backend, 'photo');
    await backend.capture('req-1');
    const photo = await photoP;
    assert.equal(photo.requestId, 'req-1');
    assert.equal(photo.name, 'IMG_0001.JPG');
    assert.equal(raws.length, 1);
    assert.equal(raws[0].name, 'IMG_0001.CR2');
    assert.equal(raws[0].data.length, 4096);
  } finally {
    backend.stop();
  }
});

test('an SDK without EdsGetEvent is an error Lumen can show, where events depend on it', { skip: !dir || scenario !== 'no-getevent' }, async () => {
  const strict = await makeBackend({ requireEventPump: true });
  strict.start();
  try {
    assert.equal(strict.state.state, 'error');
    assert.match(strict.state.message, /EdsGetEvent/);
    assert.equal(strict.timers.length, 0, 'does not keep trying');
    await assert.rejects(strict.capture('req-1'), /EdsGetEvent/);
    strict.reconnect();
    assert.equal(strict.state.state, 'error');
  } finally {
    strict.stop();
  }
});

test('a Canon SDK that cannot be loaded is a state, not a crash', async () => {
  const { EdsdkBackend } = await import('../src/edsdk/camera.js');
  const backend = new EdsdkBackend({ sdk: { libPath: '/nowhere/libEDSDK.so', generation: 13, warnings: [] } });
  backend.start();
  assert.equal(backend.state.state, 'unavailable');
  assert.match(backend.state.message, /Could not load the Canon SDK/);
  await assert.rejects(backend.capture('req-1'), /Could not load/);
  await assert.rejects(backend.setProp('iso', '400'), /Could not load/);
  backend.setLiveView(true);
  backend.reconnect();
  backend.stop();
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
