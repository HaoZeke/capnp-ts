#!/usr/bin/env bash
# Orchestrates the RPC interop tests against a live capnp-C++ peer.
#
#   run_rpc_interop.sh <adder-server> <adder-client.ts> [<rpc_peer> [dir]]
#
# The Adder pair proves the baseline call path. With rpc_peer given, the
# TypeScript vat then runs its scenarios against the C++ Echo server, and
# the C++ peer runs its scenarios against the TypeScript Echo server.
set -u
SERVER=$1
CLIENT=$2
PEER=${3:-}
HERE="$(cd "$(dirname "$0")" && pwd)"

PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null' EXIT

port() { echo $((RANDOM % 20000 + 30000)); }

P=$(port)
"$SERVER" "$P" &
PIDS+=($!)
bun "$CLIENT" "$P" || exit 1

[ -n "$PEER" ] || exit 0

P=$(port)
"$PEER" serve "$P" &
PIDS+=($!)
bun "$HERE/rpc_scenarios.ts" "$P" || exit 1

P=$(port)
bun "$HERE/rpc_server.ts" "$P" &
PIDS+=($!)
for _ in $(seq 100); do
  (exec 3<>"/dev/tcp/127.0.0.1/$P") 2>/dev/null && break
  sleep 0.05
done
"$PEER" client "$P" || exit 1
echo "All rpc interop assertions passed."
