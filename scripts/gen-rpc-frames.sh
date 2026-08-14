#!/usr/bin/env bash
# Regenerate the level 3 wire goldens with the reference `capnp` CLI.
# Run with --check to assert the checked-in files still match the schema.
#
# The frames are what a conforming vat sends for the handoff in
# schema/rpc-threeparty.capnp: Alice tells Bob to hold export 0 for
# whoever presents the nonce, and Carol presents it. The question ids are
# 42 and 43 so that nothing in the golden coincides with the union tags
# (provide is 10, accept is 11).
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
schema=$here/schema/rpc-threeparty-frames.capnp
fix=$here/packages/rpc/test/golden

command -v capnp >/dev/null || {
  echo "gen-rpc-frames: no capnp CLI on PATH" >&2
  exit 1
}

check=0
[[ "${1:-}" == "--check" ]] && check=1

out=$fix
if [[ $check -eq 1 ]]; then
  out=$(mktemp -d)
  trap 'rm -rf "$out"' EXIT
else
  mkdir -p "$out"
fi

# `capnp encode` reads the text value on stdin.
printf '%s' '(provide = (questionId = 42, target = (importedCap = 0),
              recipient = (vat = (host = "127.0.0.1", port = 4000),
                           nonce = 0xfeedface)))' |
  capnp encode "$schema" Message >"$out/rpc-provide.bin"

printf '%s' '(accept = (questionId = 43, provision = (nonce = 0xfeedface)))' |
  capnp encode "$schema" Message >"$out/rpc-accept.bin"

if [[ $check -eq 1 ]]; then
  rc=0
  for f in rpc-provide.bin rpc-accept.bin; do
    if cmp -s "$out/$f" "$fix/$f"; then
      echo "ok   $f matches $(capnp --version)"
    else
      echo "FAIL $f differs from $(capnp --version)" >&2
      rc=1
    fi
  done
  exit $rc
fi

echo "wrote $fix/rpc-provide.bin $fix/rpc-accept.bin with $(capnp --version)"
