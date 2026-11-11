#!/bin/sh
# Build the rosezm Liquid Glass N-API addon for Electron on macOS.
# Needs Node headers (node-gyp or https://nodejs.org/download/release headers)
# in $NODE_HEADERS/include/node. Produced addon is copied by `rosezm export electron`.
set -eu
: "${NODE_HEADERS:?set NODE_HEADERS to a directory containing include/node/node_api.h}"
clang++ -std=c++17 -fobjc-arc -dynamiclib -undefined dynamic_lookup \
  -I"$NODE_HEADERS/include/node" \
  -framework AppKit -framework Foundation \
  "$(dirname "$0")/rosezm-glass.mm" -o "$(dirname "$0")/rosezm-glass.node"
echo "built $(dirname "$0")/rosezm-glass.node"
