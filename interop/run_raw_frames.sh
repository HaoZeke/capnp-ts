#!/usr/bin/env bash
# Runs every raw_frames.ts scenario against the capnp-C++ Echo peer and
# the TypeScript Echo server, prints both replies, and fails on any
# scenario where they differ.
#
#   run_raw_frames.sh <rpc_peer> [scenario...]
#
# With FLOW_LIMIT set, both servers read calls under that flow limit.
set -u
PEER=$1
shift
HERE="$(cd "$(dirname "$0")" && pwd)"

PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null' EXIT

port() { echo $((RANDOM % 20000 + 30000)); }
wait_port() {
  for _ in $(seq 100); do
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0
    sleep 0.05
  done
  return 1
}

PC=$(port)
if [ -n "${FLOW_LIMIT:-}" ]; then
  "$PEER" serve-flow "$PC" "$FLOW_LIMIT" >/dev/null 2>&1 &
else
  "$PEER" serve "$PC" >/dev/null 2>&1 &
fi
PIDS+=($!)
PT=$(port)
bun "$HERE/rpc_server.ts" "$PT" ${FLOW_LIMIT:+"$FLOW_LIMIT"} >/dev/null 2>&1 &
PIDS+=($!)
wait_port "$PC" && wait_port "$PT" || { echo "servers did not start"; exit 1; }

if [ $# -gt 0 ]; then LIST=("$@"); else mapfile -t LIST < <(bun "$HERE/raw_frames.ts" --list); fi
FAIL=0
for s in "${LIST[@]}"; do
  C=$(bun "$HERE/raw_frames.ts" "$PC" "$s")
  T=$(bun "$HERE/raw_frames.ts" "$PT" "$s")
  if [ "$C" == "$T" ]; then
    echo "== $s: same"
    echo "$C" | sed 's/^/   /'
  else
    FAIL=1
    echo "== $s: DIFFERENT"
    echo "$C" | sed 's/^/   c++ /'
    echo "$T" | sed 's/^/   ts  /'
  fi
done
exit $FAIL
