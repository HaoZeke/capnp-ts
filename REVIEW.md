# capnp-ts review (2026-08-06)

Scope: workspace unit tests (`bun install` + `bun test`), pack/canonical
golden identity, codegen emit, and gaps vs Tier A acceptance
(`capnp-ts-iam3`).

## Test result: PASS

```text
bun test packages/runtime packages/codegen
  →  77 pass / 0 fail  (12 files; 56 runtime + 21 codegen)
```

| Suite | Result | Notes |
|-------|--------|-------|
| `packed.test.ts` | PASS | Spec vector + AddressBook pack/unpack |
| `canonical.test.ts` | PASS | CLI golden + idempotence + empty-struct |
| `addressbook.test.ts` | PASS | fromFlat / viewFlat / serializeToFlat |
| `message.test.ts` | PASS | Alice/Bob + double-far fixtures |
| `builder.test.ts` | PASS | Build→serialize→decode; far / double-far; orphans; deep-copy |
| `list-evolution.test.ts` | PASS | Upgrade/downgrade matrix (subset) |
| `pointer.test.ts` | PASS | Struct/list/far/cap word codecs |
| `calculator.test.ts` | PASS | Expression goldens eval + round-trip |
| `text-data.test.ts` | PASS | Text/Data edges, List(Text), nested lists |
| `fuzz-safety.test.ts` | PASS | Untrusted buffers throw only CapnpError |
| `emit-addressbook.test.ts` | PASS | Generated AddressBook Alice/Bob; u64probe |
| `cgr-fixture-smoke.test.ts` | PASS | Large CGR walk + CLI --stdout smoke |

### Ruthless golden identity (suite + sizes)

Checked-in Cap'n CLI goldens under
`packages/runtime/test/golden/` (regen: `scripts/gen-sample-fixtures.sh`,
Cap'n C++ 1.4.0):

| Artifact | Size | Role |
|----------|------|------|
| `addressbook.bin` | **288 B** | `capnp encode` AddressBook (Alice/Bob) |
| `addressbook.packed.bin` | **151 B** | `capnp convert binary:packed` |
| `addressbook.canonical.bin` | **272 B** | `capnp convert binary:canonical` |
| `calculator_add_2_3.bin` | 104 B | Expression call(add, 2, 3) |
| `calculator_mul_add.bin` | 160 B | multiply(add(2,3), 4) |
| `calculator_value_5.bin` | 24 B | EvaluateResponse value 5.0 |

| Check | Result |
|-------|--------|
| `pack(addressbook.bin) == addressbook.packed.bin` | **byte-identical** (151 B) |
| `unpack(addressbook.packed.bin) == addressbook.bin` | **byte-identical** (288 B) |
| `canonicalizeFlat(addressbook.bin) == addressbook.canonical.bin` | **byte-identical** (272 B) |
| Spec pack vector `51 08 03 02 31 19 aa 01` | PASS |

Pack uses the C++ 1.4.0 post-`0xff` heuristic (words with fewer than two zero
bytes stay in the verbatim run). AddressBook covers the `bob@exam` /
`ple.com\0` edge.

## Shipped features (honest snapshot)

- Wire reader: stream frame, zero-copy `viewFlat`, struct/list/far/double-far/cap
- Multi-segment `MessageBuilder` + far/double-far alloc paths
- Orphans (`disown` / `adopt` same-message) and deep-copy (`deepCopyPtr`,
  `structSetP` / `deepCopyPtrToSlot` across messages)
- Schema-default XOR on scalar get/set (codegen default wiring for setters
  still M6)
- List upgrade/downgrade views for supported shapes only
- `capnpc-ts` v1 typed emit: structs, const-map enums, union `which`,
  List helpers, UInt64/Int64 via `getU64`/`bigint` (never `getU32`)
- Pi admit harness dogfoods `Message.fromFlat` AddressBook + optional builder

## Tier A readiness (`capnp-ts-iam3`)

Tier A = harness-ready: scaffold + honest parity, AddressBook decode/build,
packed + canonical CLI identity, list evolution / deep-copy / orphans,
`capnpc-ts` v1 + u64probe, Pi/OMP example, parity audit.

| Gate | ID | Status | Evidence |
|------|-----|--------|----------|
| M0 scaffold + parity table + fixtures | `capnp-ts-rdeg` | **yes** | README parity table, fixtures script, goldens checked in |
| M1 wire reader + AddressBook decode | `capnp-ts-bhhb` | **yes** | `message.test.ts`, `addressbook.test.ts` |
| M2 builder + framing + multi-seg far | `capnp-ts-x7xr` | **yes** | Builder + far/double-far + orphan adopt/disown tests green |
| M3 packed + canonical CLI identity | `capnp-ts-73gz` / `4w78` | **yes** for AddressBook | Byte-identical 151 B packed + 272 B canonical goldens |
| M4 list evolution + deep-copy + orphans | `capnp-ts-rqle` | **mostly** | Upgrade/downgrade subset + orphan + deepCopy green; full matrix open |
| M5 `capnpc-ts` v1 | `capnp-ts-mga5` | **yes** | Typed emit structs/enums/unions; AddressBook Alice/Bob decode |
| u64probe smoke | `capnp-ts-44ob` | **yes** | Generated `getU64` for UInt64/Int64; codegen CI test |
| M7 Pi/OMP harness example | `capnp-ts-vjjx` | **yes** | `examples/pi-admit-harness` Message API dogfood |
| Parity audit note | `capnp-ts-89dv` | **no** | Vault family matrix write-up not present |

**Verdict: not fully Tier A.** Core runtime + pack/canonical + codegen v1 +
Pi harness are green. Remaining Tier A gaps: full list-evolution matrix,
parity audit note (`capnp-ts-89dv`), and codegen M6 (non-zero default XOR /
full builders) if counted under the gate.

## Remaining gaps (ordered by Tier A impact)

1. **Parity audit note** (`capnp-ts-89dv`) — family comparison write-up not
   written under the vault.
2. **List-evolution matrix completeness** — suite covers key shapes, not full
   fortran/janet matrix (cross-width demotion refusals, etc.).
3. **Codegen M6** — non-zero schema-default XOR on setters; fuller builders.
4. **Builder byte identity** — not claimed (correct: non-goal without
   documented alloc order); semantic round-trip is the bar and is green for
   AddressBook.

## Non-goals (correctly out of Tier A)

- RPC (`@haozeke/capnp-rpc`) — Phase 2
- Live twin vs `HaoZeke/c-capnproto` — Phase 2 (offline sketch under `interop/`)
- Cap'n Web / node-capnp FFI

## Commands

```console
bun install
bun test                 # packages/runtime + packages/codegen
bun run fixtures         # regen CLI goldens (needs capnp 1.4 via pixi)
```

## Conclusion

Runtime pack and canonical are **byte-identical** to Cap'n C++ 1.4.0 AddressBook
goldens (`addressbook.packed.bin` 151 B, `addressbook.canonical.bin` 272 B).
Reader, multi-seg builder, orphans, deep-copy, calculator Expression decode,
and `capnpc-ts` v1 emit are green under Bun (77/0). **Do not claim full family
parity until `capnp-ts-89dv` closes with evidence.**
