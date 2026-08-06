# capnp-ts review (2026-08-06)

Scope: runtime unit tests (`bun install` + `bun test`), pack/canonical golden
identity, and gaps vs Tier A acceptance (`capnp-ts-iam3`).

## Test result: PASS

```text
bun test  →  28 pass / 0 fail  (7 files, packages/runtime)
```

| Suite | Result | Notes |
|-------|--------|-------|
| `packed.test.ts` | PASS | Spec vector + AddressBook pack/unpack |
| `canonical.test.ts` | PASS | CLI golden + idempotence + empty-struct |
| `addressbook.test.ts` | PASS | fromFlat / viewFlat / serializeToFlat |
| `message.test.ts` | PASS | Alice/Bob + double-far fixture |
| `builder.test.ts` | PASS | Build→serialize→decode; far / double-far |
| `list-evolution.test.ts` | PASS | Upgrade/downgrade matrix (subset) |
| `pointer.test.ts` | PASS | Struct/list/far/cap word codecs |

### Ruthless golden identity (extra to suite)

Against Cap'n CLI goldens under `packages/runtime/test/golden/`:

| Check | Result |
|-------|--------|
| `pack(addressbook.bin) == addressbook.packed.bin` | **byte-identical** (151 bytes) |
| `unpack(addressbook.packed.bin) == addressbook.bin` | **byte-identical** |
| `canonicalizeFlat(addressbook.bin) == addressbook.canonical.bin` | **byte-identical** (272 bytes) |
| Spec pack vector `51 08 03 02 31 19 aa 01` | PASS |

Pack uses the C++ 1.4.0 post-`0xff` heuristic (words with fewer than two zero
bytes stay in the verbatim run). AddressBook covers the `bob@exam` /
`ple.com\0` edge.

## Fixes applied in this review pass

- Stabilized API surface after concurrent module rewrites (kinds/endian/pointer
  vs message/canonical/builder naming drift).
- `serialize.ts`: `frameSegments` + `serializeToFlat` for stream framing.
- Message public surface needed by tests: `segments`, `readWord`, `copyFlat`,
  `fromSegments(Uint8Array | SegmentView)`, `getP`/`getp` aliases.
- Index re-exports layers so `import { ... } from "../src/index.ts"` works for
  all test suites.
- Builder builds AddressBook and multi-seg far/double-far paths green.

## Tier A readiness (`capnp-ts-iam3`)

Tier A = harness-ready: scaffold + honest parity, AddressBook decode/build,
packed + canonical CLI identity, list evolution / deep-copy / orphans,
`capnpc-ts` v1 + u64probe, Pi/OMP example, parity audit.

| Gate | ID | Status | Evidence |
|------|-----|--------|----------|
| M0 scaffold + parity table + fixtures | `capnp-ts-rdeg` | **mostly** | README parity table, `scripts/gen-sample-fixtures.sh`, goldens present; `bun.lock` still untracked until chore commit |
| M1 wire reader + AddressBook decode | `capnp-ts-bhhb` | **yes** | `message.test.ts`, `addressbook.test.ts` |
| M2 builder + framing + multi-seg far | `capnp-ts-x7xr` | **yes** | Builder + far/double-far + orphan adopt/disown tests green |
| M3 packed + canonical CLI identity | `capnp-ts-73gz` / `4w78` | **yes** for AddressBook | Byte-identical pack + canonical goldens; suite + manual cmp |
| M4 list evolution + deep-copy + orphans | `capnp-ts-rqle` | **mostly** | Upgrade/downgrade tests green; orphan disown/adopt + deepCopyPtr land; full matrix still open |
| M5 `capnpc-ts` v1 | `capnp-ts-mga5` | **yes** | Typed emit: structs/enums/unions; AddressBook Alice/Bob decode |
| u64probe smoke | `capnp-ts-44ob` | **yes** | Generated getU64 for UInt64/Int64; codegen CI test |
| M7 Pi/OMP harness example | `capnp-ts-vjjx` | **yes** (decode/encode dogfood) | `Message.fromFlat` AddressBook; `CAPNP_ADMIT_BUILD` MessageBuilder; OMP ExtensionAPI wrap docs; no wait on full mga5 emit |
| Parity audit note | `capnp-ts-89dv` | **no** | Not written |

**Verdict: not Tier A yet.** Strong on wire read, pack, canonical, orphans,
deep-copy, and the Pi admit dogfood path. Weak on full typed codegen (mga5)
and parity audit.

## Remaining gaps (ordered by Tier A impact)

1. **`capnpc-ts` real emit** — CGR AST walk must drive importable ESM with
   const-map enums, typed getters, unions, List(Text); drift CI vs fixtures.
2. **u64probe** — generated Int64/UInt64 must use full `bigint` paths (not u32).
3. **List-evolution matrix completeness** — suite covers key shapes, not full
   fortran/janet matrix (cross-width demotion refusals, etc.).
4. **Builder byte identity** — not claimed (correct: non-goal without documented
   alloc order); semantic round-trip is the bar and is green for AddressBook.
5. **Pi/OMP admit harness** — live `Message.fromFlat` decode + builder encode path;
   full typed codegen still mga5.
6. **Parity audit note** — family comparison write-up not written.

## Non-goals (correctly out of Tier A)

- RPC (`@haozeke/capnp-rpc`) — Phase 2
- Live twin vs `HaoZeke/c-capnproto` — Phase 2
- Cap'n Web / node-capnp FFI

## Commands

```console
bun install
bun test                 # packages/runtime (workspace script)
bun run fixtures         # regen CLI goldens (needs capnp 1.4 via pixi)
```

## Conclusion

Runtime pack and canonical are **byte-identical** to Cap'n C++ 1.4.0 AddressBook
goldens. Reader + multi-seg builder are green under Bun. **Tier A is blocked on
codegen (M5), u64probe (M4b), orphans/deep-copy (M4), and Pi harness (M7).**
Do not claim full family parity until `capnp-ts-89dv` closes with evidence.
