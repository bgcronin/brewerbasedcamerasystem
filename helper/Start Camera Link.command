#!/bin/bash
# Double-click on a Mac to start Lumen with the Canon connected.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org (LTS), then double-click this again."
  read -r -p "Press Return to close." _
  exit 1
fi
[ -d node_modules ] || npm install --omit=dev
# Rebuild Lumen so it always matches the latest code (takes a few seconds).
( cd .. && { [ -d node_modules ] || npm install; } && npm run build --silent >/dev/null ) \
  || echo "Could not rebuild Lumen — using the previous build."
node src/main.js --open "$@"
