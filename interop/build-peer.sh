#!/usr/bin/env bash
# Build the capnp-C++ Adder peer the interop client is tested against.
# Needs capnp-rpc and capnpc-c++ on the toolchain; the CI job supplies
# both through pixi.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/build-interop}"
mkdir -p "$OUT"
cd "$OUT"
capnp compile --src-prefix="$ROOT/schema" -oc++:"$OUT" "$ROOT/schema/adder.capnp"
c++ -std=c++17 -o rpc_peer_server \
  "$ROOT/interop/rpc_peer_server.c++" adder.capnp.c++ \
  -I"$OUT" $(pkg-config --cflags --libs capnp-rpc)
echo "built $OUT/rpc_peer_server"
