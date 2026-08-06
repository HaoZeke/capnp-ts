# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 minor releases may include breaking API changes.

## [Unreleased]

### Added

- `capnpc-ts` v1 typed emit: structs (word counts + getters), enums as const
  maps (no TS `enum`), union `which()` + arm tags, List element helpers;
  UInt64/Int64 always via `getU64`/`bigint` (u64probe CI smoke).
- Generated AddressBook decodes runtime golden Alice/Bob; `capnp compile
  -o…/capnpc-ts schema/addressbook.capnp` integration test.
- Scalar get/set schema-default XOR (`wire = logical XOR default`) on
  `Ptr.get*` / `StructBuilder.set*`; float defaults XOR IEEE bit patterns.
- Same-message orphan `disown` / `adopt` (`Orphan` handle) on
  `MessageBuilder` / `StructBuilder`.
- Cross-message deep-copy (`deepCopyPtr`, `deepCopyPtrToSlot`, `structSetP`).
- `@haozeke/capnp` package exports: `types` / `import` / `default` →
  optional `tsup` `dist/`; `bun` condition keeps TypeScript `src/` for Bun.
- Codegen: rich CGR AST walk (nodes, fields, types, enumerants) via
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
  CGR fixture smoke + u64probe codegen.
- Docs: root README with honest family parity table, `SECURITY.md`,
  `CONTRIBUTING.md`, runtime package README, architecture org note.

### Not yet

- Full list-evolution matrix (cross-width refusals beyond the covered subset)
- Codegen non-zero default XOR / full builders (M6)
- Live c-capnproto twin interop (Phase 2; offline sketch only)
- Family parity audit write-up (`capnp-ts-89dv`)
- RPC (`@haozeke/capnp-rpc` Phase 2)
