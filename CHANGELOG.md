# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 minor releases may include breaking API changes.

<!-- towncrier release notes start -->

## [Unreleased]

### Changed

- `@haozeke/capnp-rpc` is rebuilt on a capability layer. `RpcConnection`
  exports and imports `ClientHook`s with explicit reference counts,
  answers calls through them, and sends `Release` when the last import
  reference goes. `RpcServer.dispatch` takes a fifth `CallContext`
  argument and may return a promise.
- `RpcStream` now wraps `Client.callStreaming` and `Client.flush`, its
  methods return promises, and `StreamError` is gone: a failed stream
  call rejects with the call's own error.
- A `senderLoopback` `Disembargo` aimed at an object that does not point
  back at the sender, an unknown `receiverLoopback` embargo id, and
  over-releasing an export now abort the connection, as capnp-C++ does.

### Added

- RPC: `Client`, `RpcPromise`, local, queued and broken capabilities,
  promise pipelining on local and remote calls, `Resolve` and `Disembargo`
  in both directions, call cancellation (`Finish`, `allowCancellation`,
  `CallContext.signal`, `Return.canceled`), `Abort` and disconnect handling,
  outgoing and incoming tail calls (`CallContext.tailCall`,
  `sendResultsTo.yourself`, `takeFromOtherQuestion`), `Unimplemented`
  handling, `sendJoin`.
- RPC streaming: a fixed 64 KiB window, or the transport send buffer
  when one is reported, matching capnp-C++ two-party.
  `AdaptiveStreamWindow` remains available as an explicit `streamWindow`
  opt-in. Serialised server-side stream calls break the capability on
  failure, and `waitAllAcked` resolves after that failure.
- RPC membranes, ported from `capnp/membrane.h` with the C++
  `membrane-test.c++` suite: `membrane`, `reverseMembrane`,
  `MembranePolicy`, `RevocablePolicy`, `copyIntoMembrane` and
  `copyOutOfMembrane`.
- RPC level 2: `savePersistent` and `servePersistent` for capnp-C++'s
  `Persistent` interface; the docs state what C++ leaves unimplemented at
  levels 2, 3 and 4.
- `schema/interop.capnp` and a C++ peer (`interop/rpc_peer.c++`) that both
  serves and dials, so `rpc-interop` runs lifecycle, promise, embargo,
  cancellation, streaming, membrane and persistence scenarios against
  capnp-C++ in both directions.
- `docs/orgmode/rpc.org`.
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
- Generated scalar, Text, Data, and pointer setters; union setters select their
  discriminant, and struct / `List(Struct)` initializers use CGR word counts.
- Generated interface metadata, typed client helpers, and abstract server
  dispatch bases carry the schema interface id, method ordinal, and parameter
  and result struct dimensions.
- Text and Data schema defaults on null pointers, with module-level Data
  constants so generated getters do not allocate the default on every read.
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

### Current limits

- Cross-width list demotion matrix beyond the covered upgrade/downgrade suite
- Generated primitive/pointer-list element builders and group init wrappers
- Live c-capnproto twin interop (Phase 2; offline sketch only)
- Dynamic by-name reflection
