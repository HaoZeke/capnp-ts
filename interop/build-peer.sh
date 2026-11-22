#!/usr/bin/env bash
# Build the capnp-C++ peers the interop tests run against: the Adder
# server and the Echo peer. Needs capnp-rpc and capnpc-c++ on the
# toolchain; the CI job supplies both through pixi.
set -euo pipefail
ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
OUT="${1:-$ROOT/build-interop}"
INC="$(pkg-config --variable=includedir capnp)"
pkg_flags="$(pkg-config --cflags --libs capnp-rpc)"
read -r -a rpc_flags <<<"$pkg_flags"
mkdir -p -- "$OUT"
OUT="$(CDPATH='' cd -- "$OUT" && pwd)"
cd "$OUT"
capnp compile --src-prefix="$ROOT/schema" -oc++:"$OUT" "$ROOT/schema/adder.capnp"
${CXX:-c++} -std=c++17 -o rpc_peer_server \
  "$ROOT/interop/rpc_peer_server.c++" adder.capnp.c++ \
  -I"$OUT" "${rpc_flags[@]}"
echo "built $OUT/rpc_peer_server"
capnp compile -I"$INC" --src-prefix="$ROOT/schema" -oc++:"$OUT" "$ROOT/schema/interop.capnp"
${CXX:-c++} -std=c++17 -o rpc_peer \
  "$ROOT/interop/rpc_peer.c++" interop.capnp.c++ \
  -I"$OUT" "${rpc_flags[@]}"
echo "built $OUT/rpc_peer"
