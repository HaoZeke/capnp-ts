# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 minor releases may include breaking API changes.

## [Unreleased]

### Added

- Monorepo scaffold: `@haozeke/capnp` (runtime) and `@haozeke/capnpc-ts`
  (codegen plugin stub), MIT license, Bun/pixi workspace.
- Runtime layers: `kinds`, `endian`, `pointer`, `message`, `builder`,
  `serialize`, `packed`, `canonical` (public re-exports from `@haozeke/capnp`).
- Packed codec with Cap'n C++ 1.4.0 post-`0xff` fewer-than-two-zeros
  verbatim-run heuristic.
- AddressBook sample schema (`@0x9eb32e19f86ee174`) and CLI golden fixtures
  (`encode` / `binary:packed` / `binary:canonical`); fixture regen script.
- Docs: root README with honest family parity table, `SECURITY.md`,
  `CONTRIBUTING.md`, runtime package README, architecture org note.

### Not yet

- Orphans, deep-copy cross-message `setp`, full list-evolution matrix
- `capnpc-ts` schema compiler (v1 structs/enums/getters)
- Live c-capnproto twin interop
- RPC (`@haozeke/capnp-rpc` Phase 2)
