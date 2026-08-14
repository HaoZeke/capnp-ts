#!/usr/bin/env bash
# Orchestrates the RPC interop test: start the C++ peer, run the
# TypeScript client against it, tear down.
# Usage: run_rpc_interop.sh <server> <client-ts>
set -u
SERVER=$1
CLIENT=$2
PORT=$((RANDOM % 20000 + 30000))

"$SERVER" "$PORT" &
SPID=$!
trap 'kill $SPID 2>/dev/null' EXIT

bun "$CLIENT" "$PORT"
exit $?
