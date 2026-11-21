#!/usr/bin/env bash
# Runs every raw_server.ts scenario against the capnp-C++ client and the
# TypeScript client, prints what each client saw and sent, and fails on
# any scenario where they differ.
#
#   run_raw_server.sh <rpc_peer> [scenario...]
set -u
PEER=$1
shift
HERE="$(cd "$(dirname "$0")" && pwd)"

port() { echo $((RANDOM % 20000 + 30000)); }

# One client run: the client's outcome lines, then the frames it sent.
side() {
  local P SERVER OUT ERR
  P=$(port)
  OUT=$(mktemp)
  ERR=$(mktemp)
  bun "$HERE/raw_server.ts" "$P" "$1" >"$OUT" 2>"$ERR" &
  SERVER=$!
  for _ in $(seq 100); do
    grep -q listening "$ERR" && break
    sleep 0.05
  done
  shift
  "$@" "$P" returncaps 2>&1 | grep -E '^(read|after|early): '
  wait "$SERVER"
  sed 's/^/sent /' "$OUT"
  rm -f "$OUT" "$ERR"
}

LIST=("$@")
[ ${#LIST[@]} -gt 0 ] || LIST=(return-none return-out-of-range return-non-cap)
FAIL=0
for s in "${LIST[@]}"; do
  C=$(side "$s" "$PEER" client)
  T=$(side "$s" bun "$HERE/rpc_scenarios.ts")
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
