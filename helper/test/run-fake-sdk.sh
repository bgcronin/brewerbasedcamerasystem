#!/usr/bin/env bash
# Builds the fake EDSDK for both interface generations and runs the backend tests against each.
# Linux or macOS with a C compiler. Usage: bash test/run-fake-sdk.sh
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)"
EXT=so
[ "$(uname)" = "Darwin" ] && EXT=dylib

# run "title" [VAR=value ...]: the backend tests once, with the fake camera behaving that way.
run() {
  local title="$1"
  shift
  echo "── EDSDK interface $GEN$title"
  env ${@+"$@"} EDSDK_TEST_LIB_DIR="$LIB" EDSDK_TEST_GEN="$GEN" node --test test/edsdk-fake.test.mjs
}

for GEN in 13 3; do
  mkdir -p "$OUT/v$GEN" "$OUT/v$GEN-noevent"
  FLAGS=""
  [ "$GEN" = 3 ] && FLAGS="-DGEN3"
  cc -shared -fPIC $FLAGS -o "$OUT/v$GEN/libEDSDK.$EXT" test/fake-edsdk.c
  cc -shared -fPIC $FLAGS -DNO_GETEVENT -o "$OUT/v$GEN-noevent/libEDSDK.$EXT" test/fake-edsdk.c
  LIB="$OUT/v$GEN"
  run ""
  run " with RAW+JPEG" FAKE_RAW_JPEG=1
  run ": photo taken with the camera button" FAKE_BUTTON_SHOT_AFTER_MS=300
  run ": RAW only" FAKE_RAW_ONLY=1
  run ": EdsSetCapacity fails" FAKE_FAIL_SETCAPACITY=1
  run ": camera button first, card event before the transfer request" EDSDK_TEST_SCENARIO=cold-button FAKE_COLD_BUTTON_MS=200
  run ": camera button first, card event after the transfer request" EDSDK_TEST_SCENARIO=cold-button FAKE_COLD_BUTTON_MS=200 FAKE_CREATED_LAST=1
  run ": camera saves to its card only" EDSDK_TEST_SCENARIO=card-only FAKE_SAVETO_STUCK=1 FAKE_COLD_BUTTON_MS=200
  run ": transfer request after the card fetch" EDSDK_TEST_SCENARIO=late-request FAKE_LATE_TRANSFER_MS=3500 FAKE_COLD_BUTTON_MS=200
  run ": RAW+JPEG pairs, RAW first" EDSDK_TEST_SCENARIO=pairs FAKE_RAW_JPEG=1 FAKE_BUTTON_SHOT_AFTER_MS=300
  run ": RAW+JPEG pairs, JPEG first" EDSDK_TEST_SCENARIO=pairs FAKE_RAW_JPEG=1 FAKE_JPEG_FIRST=1 FAKE_BUTTON_SHOT_AFTER_MS=300
  run ": photo arrives after its shot timed out" EDSDK_TEST_SCENARIO=late-photo FAKE_LATE_TRANSFER_MS=900 FAKE_BUTTON_SHOT_AFTER_MS=1500
  run ": camera busy when connecting" EDSDK_TEST_SCENARIO=saveto-busy FAKE_SAVETO_BUSY_ONCE=1
  run ": connection lost" EDSDK_TEST_SCENARIO=gone FAKE_GONE=1
  run ": computer only, RAW+JPEG" EDSDK_TEST_SCENARIO=host-raw FAKE_RAW_JPEG=1
  LIB="$OUT/v$GEN-noevent"
  run ": SDK without EdsGetEvent" EDSDK_TEST_SCENARIO=no-getevent
done
rm -rf "$OUT"
echo "── local server"
node --test test/server.test.mjs
echo "── building Lumen for the launchers"
node --test test/build-lumen.test.mjs
