#!/usr/bin/env bash
# Regenerate Cap'n sample golden frames with system `capnp` CLI (1.4.0).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$ROOT/packages/runtime/test/golden"
mkdir -p "$FIX"

capnp encode "$ROOT/schema/addressbook.capnp" AddressBook \
  >"$FIX/addressbook.bin" <<'MSG'
( people = [
  ( id = 123,
    name = "Alice",
    email = "alice@example.com",
    phones = [
      (number = "555-1212", type = mobile)
    ],
    employment = (school = "MIT")
  ),
  ( id = 456,
    name = "Bob",
    email = "bob@example.com",
    phones = [
      (number = "555-4567", type = home),
      (number = "555-7654", type = work)
    ],
    employment = (unemployed = void)
  )
] )
MSG

capnp convert binary:packed <"$FIX/addressbook.bin" >"$FIX/addressbook.packed.bin"
capnp convert binary:canonical <"$FIX/addressbook.bin" >"$FIX/addressbook.canonical.bin"

if [[ -f "$ROOT/schema/calculator.capnp" ]]; then
  capnp encode "$ROOT/schema/calculator.capnp" EvaluateRequest \
    >"$FIX/calculator_add_2_3.bin" <<'MSG'
( expression = (
    call = (
      op = add,
      params = [
        (literal = 2.0),
        (literal = 3.0)
      ]
    )
  )
)
MSG
fi

echo "wrote fixtures under $FIX"
ls -la "$FIX"
