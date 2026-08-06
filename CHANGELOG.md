# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 minor releases may include breaking API changes.

## [Unreleased]

### Added

- Scalar get/set schema-default XOR (`wire = logical XOR default`) on
  `Ptr.get*` / `StructBuilder.set*`; float defaults XOR IEEE bit patterns.
- Same-message orphan `disown` / `adopt` (`Orphan` handle) on
  `MessageBuilder` / `StructBuilder`.
- Cross-message deep-copy (`deepCopyPtr`, `deepCopyPtrToSlot`, `structSetP`).
- `@haozeke/capnp` package exports: `types` / `import` / `default` →
  optional `tsup` `dist/`; `bun` condition keeps TypeScript `src/` for Bun.
- Codegen: rich CGR AST walk (nodes, fields, types, enumerants) via
  `Message.fromFlat`; stub emit path unchanged.
- Pi admit harness uses `@haozeke/capnp` Message reader + optional builder.
- Offline c-capnproto twin emitter sketch under `interop/`.
- Monorepo scaffold: `@haozeke/capnp` (runtime) and `@haozeke/capnpc-ts`
  (codegen plugin stub), MIT license, Bun/pixi workspace.
- Runtime layers: `kinds`, `endian`, `pointer`, `message`, `builder`,
  `copy`, `serialize`, `packed`, `canonical` (public re-exports from
  `@haozeke/capnp`).
- Packed codec with Cap'n C++ 1.4.0 post-`0xff` fewer-than-two-zeros
  verbatim-run heuristic.
- AddressBook sample schema (`@0x9eb32e19f86ee174`) and CLI golden fixtures
  (`encode` / `binary:packed` / `binary:canonical`); fixture regen script.
- Docs: root README with honest family parity table, `SECURITY.md`,
  `CONTRIBUTING.md`, runtime package README, architecture org note.

### Not yet

- Full list-evolution matrix
- `capnpc-ts` typed emit (v1 structs/enums/getters)
- Live c-capnproto twin interop
- RPC (`@haozeke/capnp-rpc` Phase 2)
