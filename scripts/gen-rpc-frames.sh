#!/usr/bin/env bash
# Regenerate the level 3 wire goldens with the reference `capnp` CLI.
#
# The frames are what a conforming vat sends for the handoff in
# schema/rpc-threeparty.capnp: Alice tells Bob to hold export 0 for
# whoever presents the nonce, and Carol presents it. The question ids are
# 42 and 43 so that nothing in the golden coincides with the union tags
# (provide is 10, accept is 11).
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
schema=$here/schema/rpc-threeparty-frames.capnp
out=$here/packages/rpc/test/golden

command -v capnp >/dev/null || {
  echo "need the capnp CLI on PATH" >&2
  exit 1
}
mkdir -p "$out"

# `capnp encode` reads the text value on stdin.
printf '%s' '(provide = (questionId = 42, target = (importedCap = 0),
              recipient = (vat = (host = "127.0.0.1", port = 4000),
                           nonce = 0xfeedface)))' |
  capnp encode "$schema" Message >"$out/rpc-provide.bin"

printf '%s' '(accept = (questionId = 43, provision = (nonce = 0xfeedface)))' |
  capnp encode "$schema" Message >"$out/rpc-accept.bin"

echo "wrote $out/rpc-provide.bin $out/rpc-accept.bin"
