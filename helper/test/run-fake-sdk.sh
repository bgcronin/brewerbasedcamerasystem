#!/usr/bin/env bash
# Builds the fake EDSDK for both interface generations and runs the backend tests against each.
# Linux or macOS with a C compiler. Usage: bash test/run-fake-sdk.sh
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)"
EXT=so
[ "$(uname)" = "Darwin" ] && EXT=dylib
for GEN in 13 3; do
  mkdir -p "$OUT/v$GEN"
  FLAGS=""
  [ "$GEN" = 3 ] && FLAGS="-DGEN3"
  cc -shared -fPIC $FLAGS -o "$OUT/v$GEN/libEDSDK.$EXT" test/fake-edsdk.c
  echo "── EDSDK interface $GEN"
  EDSDK_TEST_LIB_DIR="$OUT/v$GEN" EDSDK_TEST_GEN=$GEN node --test test/edsdk-fake.test.mjs
  echo "── EDSDK interface $GEN with RAW+JPEG"
  FAKE_RAW_JPEG=1 EDSDK_TEST_LIB_DIR="$OUT/v$GEN" EDSDK_TEST_GEN=$GEN node --test test/edsdk-fake.test.mjs
  echo "── EDSDK interface $GEN: photo taken with the camera button"
  FAKE_BUTTON_SHOT_AFTER_MS=300 EDSDK_TEST_LIB_DIR="$OUT/v$GEN" EDSDK_TEST_GEN=$GEN node --test test/edsdk-fake.test.mjs
  echo "── EDSDK interface $GEN: RAW only"
  FAKE_RAW_ONLY=1 EDSDK_TEST_LIB_DIR="$OUT/v$GEN" EDSDK_TEST_GEN=$GEN node --test test/edsdk-fake.test.mjs
  echo "── EDSDK interface $GEN: EdsSetCapacity fails"
  FAKE_FAIL_SETCAPACITY=1 EDSDK_TEST_LIB_DIR="$OUT/v$GEN" EDSDK_TEST_GEN=$GEN node --test test/edsdk-fake.test.mjs
done
rm -rf "$OUT"
echo "── local server"
node --test test/server.test.mjs
