# capnp-ts review (2026-08-06)

Scope: workspace unit tests (`bun install` + `bun test`), pack/canonical
golden identity, codegen emit, and honest Tier A gaps.

## Test result: PASS

```text
bun test packages/runtime packages/codegen
  → runtime + codegen suites green (see `bun test` for current counts)
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
| `reader-security.test.ts` | PASS | Depth, list charge, composite tag, bounds |
| `emit-addressbook.test.ts` | PASS | Offline CGR fixtures; u64probe; List(Text) helper |
| `cgr-fixture-smoke.test.ts` | PASS | Large CGR walk + CLI --stdout smoke |

### Golden identity (suite + sizes)

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
- Schema-default XOR on runtime scalar get/set (`dflt`); codegen emits
  `Field.defaultValue` into getter default args (incl. non-zero); `getF32`/`setF32`
- List upgrade/downgrade views: encoding.html Void upgrade + Bool refuse; prim
  / pointer upgrade + composite downgrade (not every demotion edge)
- `capnpc-ts` typed emit: structs, const-map enums (Bun strip-safe), union
  `which`, List(Text) via `listGetText`, UInt64/Int64 via `getU64`/`bigint`
- Public kinds use const objects (`WireKind` / `PtrKind` / `ElemSize`), not
  TypeScript `const enum`
- Pi admit harness dogfoods `Message.fromFlat` AddressBook + optional builder

## Tier A readiness

Tier A = harness-ready: scaffold + honest parity, AddressBook decode/build,
packed + canonical CLI identity, list evolution / deep-copy / orphans,
`capnpc-ts` v1 + u64probe, Pi/OMP example, family parity write-up.

| Gate | Status | Evidence |
|------|--------|----------|
| M0 scaffold + parity table + fixtures | **yes** | README parity table, fixtures script, goldens checked in |
| M1 wire reader + AddressBook decode | **yes** | `message.test.ts`, `addressbook.test.ts` |
| M2 builder + framing + multi-seg far | **yes** | Builder + far/double-far + orphan adopt/disown tests green |
| M3 packed + canonical CLI identity | **yes** for AddressBook | Byte-identical 151 B packed + 272 B canonical goldens |
| M4 list evolution + deep-copy + orphans | **mostly** | Void/Bool per encoding.html + upgrade/downgrade suite; orphans + deepCopy green |
| M5 `capnpc-ts` v1 | **yes** | Typed emit structs/enums/unions + schema defaults; AddressBook Alice/Bob |
| u64probe smoke | **yes** | Offline CGR fixture + generated `getU64`; no soft-skip silent pass |
| M7 Pi/OMP harness example | **yes** | `examples/pi-admit-harness` Message API dogfood |
| Family parity audit note | **yes** (vault) | `Software/capnp-ts/serialization-parity-audit-2026-08-06.org` |

**Verdict: Tier A serialization core green.** Remaining polish: generated
setters, cross-width demotion edges beyond the suite, live c-capnproto twin.
**RPC is not claimed** (Phase 2 only).

## Remaining gaps (ordered by impact)

1. **Generated setters / full builders** — getters emit defaults; setters not
   generated yet.
2. **List-evolution demotion matrix** — suite covers key shapes; not every
   cross-width refusal C++ accepts.
3. **Builder byte identity** — not claimed (correct: non-goal without
   documented alloc order); semantic round-trip is the bar and is green for
   AddressBook.

## Non-goals (correctly out of Tier A)

- RPC (`@haozeke/capnp-rpc`) — Phase 2; do not claim
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
and `capnpc-ts` v1 emit are green under Bun. **Do not claim full family
parity until an in-repo parity audit closes with evidence.**
