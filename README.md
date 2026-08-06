# capnp-ts

Pure TypeScript [Cap'n Proto](https://capnproto.org) wire runtime and
`capnpc-ts` schema-compiler plugin. Same product family as
[capnp-fortran](https://github.com/HaoZeke/capnp-fortran),
[capnp-janet](https://github.com/HaoZeke/capnp-janet), and
[c-capnproto](https://github.com/HaoZeke/c-capnproto): encoding.html first,
zero-copy segment views, defensive traversal limits, and CLI golden parity
where claimed.

**Status:** early (`0.1.0-dev`). Reader, stream framing, packed codec,
canonicalization, and a multi-segment builder are landing in the runtime
package. Schema codegen is still a scaffold. RPC is a later package, not a
v1 gate.

npm packages:

| Package | Role |
|---------|------|
| [`@haozeke/capnp`](packages/runtime) | Wire runtime (kinds, pointer, message, packed, canonical) |
| [`@haozeke/capnpc-ts`](packages/codegen) | `capnp compile -o` plugin (scaffold; not ready) |

Not a soft fork of the unmaintained `jdiaz5513/capnp-ts`, not a libcapnp /
node-capnp FFI wrapper, and not Cap'n Web.

Architecture notes: [docs/orgmode/architecture.org](docs/orgmode/architecture.org).
Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Security: [SECURITY.md](SECURITY.md).

## Features (current)

- Stream-framed deserialize (copy) and zero-copy view of a caller buffer
- Struct / list / far / double-far / capability pointer resolution
- Scalar field readers (`u8`/`u16`/`u32`/`u64`/`f64`/`bool`) with past-end defaults
- Text, Data, pointer lists, primitive lists, bit-lists; composite list elements
- Schema-evolution list upgrade/downgrade for the supported cases (see runtime)
- Stream segment-table serialize (`serializeToFlat` / `frameSegments`)
- Multi-segment `MessageBuilder` arena (far / double-far path in progress)
- Packed codec (`pack` / `unpack`) targeting Cap'n C++ 1.4.0 byte identity
- Canonical form (`canonicalize` / `canonicalizeFlat`) targeting
  `capnp convert binary:canonical`
- Traversal word budget (8 Mi words) and nesting depth limit (64), C++ defaults
- AddressBook sample schema and CLI goldens under `packages/runtime/test/golden/`

Not yet shipped: orphans / deep-copy cross-message `setp`, full list-evolution
matrix, `capnpc-ts` codegen, dynamic reflection, RPC.

## Parity

Feature coverage against the family peers. **partial** means code exists but
is incomplete or not golden-proven; **no** means not present. Do not treat
this table as a green checklist for unbuilt work.

| Feature | capnp-c | capnp-C++ | capnp-fortran | capnp-janet | capnp-ts |
|---------|---------|-----------|---------------|-------------|----------|
| Wire format read (struct/list/far/cap) | yes | yes | yes | yes | **partial** |
| Stream framing | yes | yes | yes | yes | **partial** |
| Packed codec | yes | yes | yes | yes | **yes** (C++ 0xff fewer-than-two-zeros heuristic) |
| Zero-copy reads from caller buffer | yes | yes | yes | yes | **partial** (`Message.viewFlat`) |
| Traversal and depth limits | no | yes | yes | yes | **yes** |
| Schema-evolution reads (defaults past end, list up/downgrade) | partial | yes | yes | yes | **partial** |
| Builder / deep copy / orphans | limited | yes | yes | partial | **partial** (builder arena; no orphans / deep-copy yet) |
| Canonical form | no | yes | yes | yes | **partial** |
| Code generator (`capnp compile -o`) | yes | yes | yes | yes | **no** (`capnpc-ts` scaffold only) |
| RPC | no | yes | yes | out of scope for v0.x | **no** (Phase 2 package; not Tier A) |

The serialization bar is Cap'n C++ 1.4.0 (`capnp encode` /
`convert binary:packed` / `binary:canonical`) plus the same AddressBook and
calculator Expression samples used by fortran/janet. Live twin vs
c-capnproto is Phase 2 interop, not a v1 claim.

## Install

Runtime is pure TypeScript ESM (Node ≥ 18 or Bun). Workspace root:

```console
$ bun install
$ bun test
```

Toolchain for fixture regen (Cap'n CLI 1.4.*) via [pixi](https://pixi.sh):

```console
$ pixi install
$ pixi run fixtures   # or: bun run fixtures
$ pixi run test
```

Consume the runtime from the workspace path (or a published tarball when
tagged):

```console
$ bun add @haozeke/capnp
```

## Quick start: AddressBook

Decode the classic Cap'n sample (Alice / Bob) from a framed golden:

```typescript
import { readFileSync } from "node:fs";
import { Message, PtrKind } from "@haozeke/capnp";

// Person: id @0 :UInt32 (data byte 0); name @1 :Text (ptr 0); email @2 :Text (ptr 1)
// AddressBook: people @0 :List(Person) composite list at root pointer 0
const bytes = new Uint8Array(
  readFileSync("packages/runtime/test/golden/addressbook.bin"),
);
const msg = Message.fromFlat(bytes);
const root = msg.root();
const people = root.getP(0);

if (people.kind !== PtrKind.List) throw new Error("expected people list");
console.log(people.listLen()); // 2

const alice = people.listGetP(0);
console.log(alice.getU32(0)); // 123
console.log(alice.getText(0)); // Alice
console.log(alice.getText(1)); // alice@example.com

const bob = people.listGetP(1);
console.log(bob.getU32(0)); // 456
console.log(bob.getText(0)); // Bob
```

Zero-copy view of a buffer you own (buffer must outlive the message):

```typescript
const view = Message.viewFlat(bytes);
const name = view.root().getP(0).listGetP(0).getText(0);
```

Packed / canonical helpers (whole-buffer):

```typescript
import { pack, unpack, canonicalizeFlat } from "@haozeke/capnp";

const packed = pack(bytes);
const again = unpack(packed);
const canonical = canonicalizeFlat(bytes);
```

Regenerate goldens (needs system `capnp` 1.4.*):

```console
$ ./scripts/gen-sample-fixtures.sh
```

## Layout

```
packages/runtime/   @haozeke/capnp wire runtime + golden tests
packages/codegen/   @haozeke/capnpc-ts plugin (scaffold)
schema/             addressbook, calculator Expression, u64probe
scripts/            fixture regen against capnp CLI
interop/            live twin notes (Phase 2)
docs/orgmode/       architecture layering
examples/           Pi/OMP admit harness (planned)
```

## Non-goals (v1 / Tier A)

| Non-goal | Note |
|----------|------|
| RPC inside `@haozeke/capnp` | Optional `@haozeke/capnp-rpc` L1 later; L3/4 unimplemented like C++/fortran |
| Wrapping node-capnp / libcapnp | Pure TS only (Bun strip loaders and extension packs) |
| Cap'n Web | Separate ecosystem |
| Byte-identical *builder* output without documented alloc order | Semantic round-trip first; live twin is Phase 2 |
| Full dynamic reflection | Optional later |

## Family

| Tree | Product | Role |
|------|---------|------|
| TypeScript | this repo | Wire runtime + future `capnpc-ts` |
| Fortran | [capnp-fortran](https://github.com/HaoZeke/capnp-fortran) | Serialization + RPC parity bar |
| Janet | [capnp-janet](https://github.com/HaoZeke/capnp-janet) | Ship lessons (`List(Text)` C=6, pack 0xff) |
| C | [c-capnproto](https://github.com/HaoZeke/c-capnproto) | Live golden peer (Phase 2) |
| Spec CLI | Cap'n C++ 1.4.0 `capnp` | encode / packed / canonical oracle |

Shared AddressBook schema id: `@0x9eb32e19f86ee174`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).
