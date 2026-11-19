#!/usr/bin/env bash
# Build the capnp-C++ peers the interop tests run against: the Adder
# server and the Echo peer. Needs capnp-rpc and capnpc-c++ on the
# toolchain; the CI job supplies both through pixi.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/build-interop}"
INC="$(pkg-config --variable=includedir capnp)"
mkdir -p "$OUT"
cd "$OUT"
capnp compile --src-prefix="$ROOT/schema" -oc++:"$OUT" "$ROOT/schema/adder.capnp"
c++ -std=c++17 -o rpc_peer_server \
  "$ROOT/interop/rpc_peer_server.c++" adder.capnp.c++ \
  -I"$OUT" $(pkg-config --cflags --libs capnp-rpc)
echo "built $OUT/rpc_peer_server"
capnp compile -I"$INC" --src-prefix="$ROOT/schema" -oc++:"$OUT" "$ROOT/schema/interop.capnp"
c++ -std=c++17 -o rpc_peer \
  "$ROOT/interop/rpc_peer.c++" interop.capnp.c++ \
  -I"$OUT" $(pkg-config --cflags --libs capnp-rpc)
echo "built $OUT/rpc_peer"
