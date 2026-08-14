#!/usr/bin/env bash
# Regenerate Cap'n sample golden frames with system `capnp` CLI (1.4.0).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REAL="$ROOT/packages/runtime/test/golden"
FIX="$REAL"

# --check regenerates into a scratch directory and compares, which is what
# proves the suite measures this runtime against upstream rather than
# against its own earlier output.
CHECK=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK=1
  FIX=$(mktemp -d)
  trap 'rm -rf "$FIX"' EXIT
fi
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
  # 2 + 3
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

  capnp encode "$ROOT/schema/calculator.capnp" EvaluateResponse \
    >"$FIX/calculator_value_5.bin" <<'MSG'
( value = 5.0 )
MSG

  # Nested: (2 + 3) * 4
  capnp encode "$ROOT/schema/calculator.capnp" EvaluateRequest \
    >"$FIX/calculator_mul_add.bin" <<'MSG'
( expression = (
    call = (
      op = multiply,
      params = [
        (call = (
          op = add,
          params = [
            (literal = 2.0),
            (literal = 3.0)
          ]
        )),
        (literal = 4.0)
      ]
    )
  )
)
MSG
fi

if [[ $CHECK -eq 1 ]]; then
  rc=0
  for f in addressbook.bin addressbook.packed.bin addressbook.canonical.bin \
           calculator_add_2_3.bin calculator_value_5.bin calculator_mul_add.bin; do
    [[ -e "$FIX/$f" ]] || continue
    if cmp -s "$FIX/$f" "$REAL/$f"; then
      echo "ok   $f matches $(capnp --version)"
    else
      echo "FAIL $f differs from $(capnp --version)" >&2
      rc=1
    fi
  done
  exit $rc
fi

echo "wrote fixtures under $FIX with $(capnp --version)"
ls -la "$FIX"
