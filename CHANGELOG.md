# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 minor releases may include breaking API changes.

## [Unreleased]

## [0.1.0] - 2026-11-22

First release of the pure TypeScript ESM Cap'n Proto family for Node >= 18
and Bun: `@haozeke/capnp`, `@haozeke/capnpc-ts`, and `@haozeke/capnp-rpc`.

### Added

- **Wire runtime (`@haozeke/capnp`)**:
  - Stream-framed message reader (`Message.fromFlat`), zero-copy buffer view
    (`Message.viewFlat`), and stream serializer (`serializeToFlat`,
    `frameSegments`).
  - Multi-segment `MessageBuilder` supporting far and double-far pointers,
    schema-default XOR on scalar getters and setters, same-message orphans
    (`disown` / `adopt`), and cross-message `deepCopyPtr`.
  - Schema-evolution list upgrade and downgrade views, plus Cap'n Proto C++
    default reader limits (8 Mi-word traversal budget and 64-level nesting
    depth).
- **Packing and canonical form**:
  - Packed wire codec (`pack` / `unpack`, with optional `compactFramed`
    multi-segment compaction) matching Cap'n Proto C++ 1.4.0 output
    byte-for-byte.
  - Single-segment preorder canonicalization (`canonicalize` /
    `canonicalizeFlat`) matching `capnp convert binary:canonical`
    byte-for-byte.
- **Dynamic codecs and CLI**:
  - Runtime schema reflection (`SchemaLoader`, `StructSchema`, `EnumSchema`,
    `InterfaceSchema`, `ConstSchema`, `AnnotationSchema`, `ListSchema`, generic
    `Brand` substitution) and dynamic values (`DynamicStruct`, `DynamicList`,
    `DynamicEnum`, `DynamicCapability`, `DynamicOrphan`).
  - Cap'n Proto text codec (`TextCodec`, `encodeText`, `decodeText`,
    `prettyPrint`, `stringify`) matching `capnp encode` and `capnp decode`
    formatting and malformed-input recovery.
  - Cap'n Proto compat JSON codec (`JsonCodec`, `encodeJson`, `decodeJson`,
    `splitJsonMessages`) matching `capnp/compat/json.h` defaults and `$Json`
    annotations (`name`, `flatten`, `discriminator`, `hex`, `base64`).
  - `capnp-ts` CLI (`@haozeke/capnp/cli`) implementing `encode`, `decode`,
    `convert`, and `eval` across `binary`, `packed`, `flat`, `flat-packed`,
    `canonical`, `text`, and `json`.
- **Schema code generator (`@haozeke/capnpc-ts`)**:
  - `capnp compile -o` plugin (`capnpc-ts`, running under Node >= 18 directly,
    or Bun via bun run / bunx) reading framed `CodeGeneratorRequest` streams
    and emitting typed ESM `.ts` modules: struct layout constants,
    default-aware getters and setters, Text/Data defaults, const-map enums,
    union `which()` and setters, `UInt64`/`Int64` as `bigint`, struct, group,
    and `List(Struct)` initializers, generic interfaces, and typed RPC
    interface metadata.
- **RPC vat (`@haozeke/capnp-rpc`)**:
  - Level 1: capability-based `Vat` and `RpcConnection` with explicit reference
    counting, `Client` and `RpcPromise`, promise pipelining, bidirectional
    `Resolve` and `Disembargo`, call cancellation (`Finish`,
    `allowCancellation`, `CallContext.signal`), outgoing and incoming tail
    calls (`CallContext.tailCall`), abort and disconnect handling, streaming
    flow control (fixed 64 KiB or transport send-buffer window, plus opt-in
    `AdaptiveStreamWindow`), and membranes (`membrane`, `reverseMembrane`,
    `MembranePolicy`, `RevocablePolicy`, ported from `capnp/membrane.h`).
  - Level 2: `Persistent` interface (`savePersistent`, `servePersistent`),
    matching Cap'n Proto C++.
  - Level 3: three-party handoff (`Provide`, `Accept` with embargo,
    `thirdPartyHosted` introductions over `schema/rpc-threeparty.capnp`)
    across vats.
  - Level 4: two-party `Join` (`sendJoin` and answer handling).
- **Interop with Cap'n Proto C++ 1.4.0**:
  - Byte-identical AddressBook golden fixtures (framed, packed, canonical) and
    calculator Expression fixtures checked against the `capnp` 1.4.0 CLI.
  - Differential CLI, text, JSON, and list-evolution tests against Cap'n Proto
    1.4.0, plus bidirectional `pycapnp` interop tests.
  - Live bidirectional TCP RPC interop against a Cap'n Proto C++ 1.4.0 peer
    (`interop/rpc_peer.c++`, `interop/run_rpc_interop.sh`) covering lifecycle,
    promises, embargoes, cancellation, streaming, membranes, and persistence.

### Known limits

- Cross-width list demotion edges beyond the covered upgrade/downgrade suite.
- Generated primitive/pointer-list element builders (composite `List(Struct)`
  and group initializers are supported).
- Level 2 covers the `Persistent` interface without a built-in SturdyRef
  registry; levels 3 and 4 are verified between TypeScript vats because
  Cap'n Proto C++ leaves them unimplemented.
- Live `c-capnproto` twin interop (`interop/emit_c_twin.c` is an offline sketch;
  live RPC interop runs against Cap'n Proto C++ 1.4.0).

[Unreleased]: https://github.com/HaoZeke/capnp-ts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/HaoZeke/capnp-ts/releases/tag/v0.1.0
