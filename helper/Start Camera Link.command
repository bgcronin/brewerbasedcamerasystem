#!/bin/bash
# Double-click on a Mac to start Lumen with the Canon connected.
cd "$(dirname "$0")" || exit 1

stop() {
  echo
  read -r -p "Press Return to close." _
  exit 1
}

# Opened from inside the download without unpacking it? Then the rest is not here.
if [ ! -f src/main.js ]; then
  echo "Lumen Camera Link cannot start from here: the rest of its files are missing."
  echo "Unpack the whole download first, then double-click “Start Camera Link.command” in its helper folder."
  stop
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS version from https://nodejs.org, install it, then double-click this again."
  stop
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "The Node.js on this Mac ($(node --version)) is too old for Lumen Camera Link, which needs version 20 or newer."
  echo "Get the LTS version from https://nodejs.org, install it, then double-click this again."
  stop
fi

# Camera Link's own parts. They are checked by loading them, so an install that
# stopped half way is noticed and done again instead of being skipped for ever.
parts_ready() { node -e 'require("ws"); require("koffi")' >/dev/null 2>&1; }
if ! parts_ready; then
  echo "Setting up Lumen Camera Link. This happens once, takes about a minute and needs the internet…"
  if ! npm install --omit=dev --no-audit --no-fund || ! parts_ready; then
    echo
    echo "Lumen Camera Link could not be set up: installing its parts failed. The reason is in the lines above."
    echo "Check that this Mac is connected to the internet, then double-click this again."
    stop
  fi
fi

# Build Lumen if it has changed since the last start. The build is made in a spare folder and only
# replaces the working one when it succeeded; if it fails, the reason is shown and the previous build is used.
node src/build-lumen.js
node src/main.js --open "$@"
