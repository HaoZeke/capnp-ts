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
# A dial that exits before `read:` is a missed startup, so try a new port.
side() {
  local scenario=$1
  shift
  local attempt P SERVER OUT ERR CLIENT up outcomes sent
  for attempt in 1 2 3 4 5; do
    P=$(port)
    OUT=$(mktemp)
    ERR=$(mktemp)
    CLIENT=$(mktemp)
    bun "$HERE/raw_server.ts" "$P" "$scenario" >"$OUT" 2>"$ERR" &
    SERVER=$!
    up=0
    for _ in $(seq 100); do
      if grep -q listening "$ERR"; then up=1; break; fi
      if ! kill -0 "$SERVER" 2>/dev/null; then break; fi
      sleep 0.05
    done
    if [ "$up" = 1 ]; then
      "$@" "$P" returncaps >"$CLIENT" 2>&1 || true
    fi
    wait "$SERVER" || true
    outcomes=$(grep -E '^(read|after|early): ' "$CLIENT" || true)
    # Question 0's Finish is queued by the C++ client's destructor and
    # sometimes never reaches the socket. Drop that one line on both sides.
    sent=$(grep -v '^finish q=0$' "$OUT" | sed 's/^/sent /' || true)
    rm -f "$OUT" "$ERR" "$CLIENT"
    if printf '%s\n' "$outcomes" | grep -q '^read: '; then
      printf '%s\n%s\n' "$outcomes" "$sent"
      return 0
    fi
  done
  echo "dial failed" >&2
  return 1
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
