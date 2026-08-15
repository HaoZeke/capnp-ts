# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 minor releases may include breaking API changes.

## [Unreleased]

### Added

- `@haozeke/capnp-rpc` covers RPC level 3, both halves. `Provide` holds a
  capability under the recipient's nonce and `Accept` claims it; an
  `Accept` with `embargo` waits for `Disembargo` with `context.provide`.
  A `thirdPartyHosted` CapDescriptor records an introduction, handed
  over by `pendingIntroductions` and finished by `introductionDone`,
  which releases the vine. `sendProvide`, `sendAccept` and
  `sendDisembargoProvide` are the introducer's side.
- `schema/rpc-threeparty.capnp`, the network layer that names a third
  vat, shared verbatim with c-capnproto, capnp-fortran and capnp-janet.
  `rpc.capnp` leaves those ids to the network, and `rpc-twoparty.capnp`
  declares them empty because a two-party connection has no third to
  name.
- `Vat`: level 3 arrangements belong to a vat rather than a connection,
  since a handoff is made on one and claimed on another. A connection
  given no `Vat` gets one to itself.
- `answerCapId`, without which a capability returned in an answer could
  not be called.
- Level 3 goldens the reference `capnp` CLI encodes
  (`packages/rpc/test/golden/rpc-{provide,accept,introduce}.bin`),
  regenerated and verified by `scripts/gen-rpc-frames.sh`.
- `capnpc-ts` v1 typed emit: structs (word counts + getters), enums as const
  maps (no TS `enum` / no public `const enum`), union `which()` + arm tags,
  List(Struct) via `listGetP` and List(Text) via `listGetText`;
  UInt64/Int64 always via `getU64`/`bigint` (offline u64probe CGR fixture).
- Generated AddressBook decodes runtime golden Alice/Bob; live
  `capnp compile -o…/capnpc-ts` gated with `test.skipIf` (no soft-skip pass).
- CGR walk of `Field.slot.defaultValue` / `hadExplicitDefault` (bit 128) into
  the AST; `capnpc-ts` emits non-zero scalar defaults into getter `dflt` args.
- `Ptr.getF32` / `StructBuilder.setF32` (IEEE-754 bit XOR, same model as f64).
- Scalar get/set schema-default XOR (`wire = logical XOR default`) on
  `Ptr.get*` / `StructBuilder.set*`; float defaults XOR IEEE bit patterns.
- Same-message orphan `disown` / `adopt` (`Orphan` handle) on
  `MessageBuilder` / `StructBuilder`.
- Cross-message deep-copy (`deepCopyPtr`, `deepCopyPtrToSlot`, `structSetP`).
- `@haozeke/capnp` package exports: `types` / `import` / `default` →
  optional `tsup` `dist/`; `bun` condition keeps TypeScript `src/` for Bun.
- Codegen: rich CGR AST walk (nodes, fields, types, enumerants, defaults) via
  `Message.fromFlat`.
- Pi admit harness (`examples/pi-admit-harness`) uses `@haozeke/capnp`
  `Message.fromFlat` / optional `MessageBuilder` for AddressBook Alice/Bob.
- Offline c-capnproto twin emitter sketch under `interop/`.
- Monorepo scaffold: `@haozeke/capnp` (runtime) and `@haozeke/capnpc-ts`
  (codegen plugin), MIT license, Bun/pixi workspace.
- Runtime layers: `kinds`, `endian`, `pointer`, `message`, `builder`,
  `copy`, `serialize`, `packed`, `canonical` (public re-exports from
  `@haozeke/capnp`).
- Packed codec with Cap'n C++ 1.4.0 post-`0xff` fewer-than-two-zeros
  verbatim-run heuristic; **byte-identical** to CLI golden
  `packages/runtime/test/golden/addressbook.packed.bin` (151 B) via
  `pack(addressbook.bin)` / `unpack` round-trip (`packed.test.ts`).
- Canonical form **byte-identical** to
  `capnp convert binary:canonical` on AddressBook:
  `canonicalizeFlat(addressbook.bin)` equals
  `packages/runtime/test/golden/addressbook.canonical.bin` (272 B;
  `canonical.test.ts`).
- AddressBook sample schema (`@0x9eb32e19f86ee174`) and CLI golden fixtures
  under `packages/runtime/test/golden/`:
  `addressbook.bin` (288 B encode), `addressbook.packed.bin` (151 B),
  `addressbook.canonical.bin` (272 B); calculator Expression goldens
  (`calculator_add_2_3.bin`, `calculator_mul_add.bin`,
  `calculator_value_5.bin`); regen via `scripts/gen-sample-fixtures.sh`.
- Suite coverage beyond goldens: multi-segment far/double-far stress,
  text/data edges, untrusted-buffer fuzz, list upgrade/downgrade subset,
  CGR fixture smoke + u64probe codegen (offline fixtures first).
- Docs: root README with honest family parity table, `SECURITY.md`,
  `CONTRIBUTING.md`, runtime package README, architecture org note.

### Not yet

- Cross-width list demotion matrix beyond the covered upgrade/downgrade suite
- Generated setters / full builder emit / groups as first-class helpers
- Live c-capnproto twin interop (Phase 2; offline sketch only)
- Dynamic by-name reflection
- RPC (`@haozeke/capnp-rpc` Phase 2; not a v1 claim)
