# capnp-ts

Pure TypeScript [Cap'n Proto](https://capnproto.org) wire runtime and
`capnpc-ts` schema-compiler plugin. Same product family as
[capnp-fortran](https://github.com/HaoZeke/capnp-fortran),
[capnp-janet](https://github.com/HaoZeke/capnp-janet), and
[c-capnproto](https://github.com/HaoZeke/c-capnproto): encoding.html first,
zero-copy segment views, defensive traversal limits, and CLI golden parity
where claimed.

**Status:** early (`0.1.0-dev`). Runtime ships a message reader, stream
framing, multi-segment builder, packed codec, canonical form, orphans,
deep-copy, and list upgrade/downgrade views. Packed and canonical match
Cap'n C++ 1.4.0 AddressBook goldens **byte-for-byte** (see
[`packages/runtime/test/golden/`](packages/runtime/test/golden/):
`addressbook.bin` 288 B → `addressbook.packed.bin` 151 B,
`addressbook.canonical.bin` 272 B; proven by `packed.test.ts` and
`canonical.test.ts`). `capnpc-ts` walks a framed `CodeGeneratorRequest` and
emits typed ESM (structs, const-map enums, unions/`which`, UInt64 via
`getU64`/`bigint`). RPC is a later package, not a v1 gate.

npm packages:

| Package | Role |
|---------|------|
| [`@haozeke/capnp`](packages/runtime) | Wire runtime (kinds, pointer, message, builder, packed, canonical) |
| [`@haozeke/capnpc-ts`](packages/codegen) | `capnp compile -o` plugin (typed struct/enum/union emit) |

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
- Multi-segment `MessageBuilder` arena with far / double-far pointer paths
- Same-message orphan `disown` / `adopt`; cross-message `deepCopyPtr` / `structSetP`
- Scalar get/set with schema-default XOR on the runtime (`get*` / `set*` take
  an optional `dflt`); codegen still emits zero-only default arguments (M6
  wires schema `Field.defaultValue` into getters/setters)
- Packed codec (`pack` / `unpack`) byte-identical to Cap'n C++ 1.4.0 on
  AddressBook (`pack(addressbook.bin) == addressbook.packed.bin`, 151 B)
- Canonical form (`canonicalize` / `canonicalizeFlat`) byte-identical to
  `capnp convert binary:canonical` on AddressBook
  (`canonicalizeFlat(addressbook.bin) == addressbook.canonical.bin`, 272 B)
- Traversal word budget (8 Mi words) and nesting depth limit (64), matching
  Cap'n C++ reader defaults (`DEFAULT_TRAVERSAL_WORDS` / `DEFAULT_DEPTH_LIMIT`;
  far hops and `getP` / `listGetP` accumulate depth)
- CLI goldens under `packages/runtime/test/golden/`: AddressBook encode /
  packed / canonical plus calculator Expression samples
  (`calculator_add_2_3.bin`, `calculator_mul_add.bin`, `calculator_value_5.bin`)
- `capnpc-ts` plugin: framed CGR on stdin/file, typed `.ts` per requested schema
  (layout constants, getters, const-map enums, union `which`, List(Text) via
  `listGetText`, u64probe-safe `getU64`/`bigint`); AddressBook decode test

Not yet shipped: full list-evolution matrix, non-zero default XOR in codegen
emit, dynamic reflection, RPC.

## Parity

Feature coverage against the family peers. **partial** means code exists but
is incomplete or not golden-proven across the full matrix; **no** means not
present. Do not treat this table as a green checklist for unbuilt work.

| Feature | capnp-c | capnp-C++ | capnp-fortran | capnp-janet | capnp-ts |
|---------|---------|-----------|---------------|-------------|----------|
| Wire format read (struct/list/far/cap) | yes | yes | yes | yes | **yes** (struct/list/far/double-far/cap; AddressBook + hand fixtures) |
| Stream framing | yes | yes | yes | yes | **yes** (`fromFlat` / `viewFlat` / `serializeToFlat` / `frameSegments`) |
| Packed codec | yes | yes | yes | yes | **yes** (C++ 1.4.0 `0xff` fewer-than-two-zeros heuristic; AddressBook golden) |
| Zero-copy reads from caller buffer | yes | yes | yes | yes | **yes** (`Message.viewFlat`) |
| Traversal and depth limits | no | yes | yes | yes | **yes** (8 Mi words + depth 64; far/`getP`/`listGetP` accumulate; see SECURITY.md) |
| Schema-evolution reads (defaults past end, list up/downgrade) | partial | yes | yes | yes | **partial** (supported upgrade/downgrade views; not full matrix) |
| Builder / deep copy / orphans | limited | yes | yes | partial | **yes** (multi-seg arena + far/double-far; orphan disown/adopt; deepCopyPtr) |
| Canonical form | no | yes | yes | yes | **yes** (AddressBook golden byte-identical to CLI) |
| Code generator (`capnp compile -o`) | yes | yes | yes | yes | **yes** (v1: structs/enums/unions/getters/List helpers; schema defaults in emit still zero-only) |
| RPC | no | yes | yes | out of scope for v0.x | **no** (Phase 2 package) |

The serialization bar is Cap'n C++ 1.4.0 (`capnp encode` /
`convert binary:packed` / `binary:canonical`) plus the same AddressBook and
calculator Expression samples used by fortran/janet. Goldens are regenerated
by `scripts/gen-sample-fixtures.sh` / `bun run fixtures` and checked in under
`packages/runtime/test/golden/`. Live twin vs c-capnproto is Phase 2 interop,
not a v1 claim.

Builder output is **not** claimed byte-identical without a documented alloc
order; semantic build → serialize → decode is the bar and is green for
AddressBook.

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

Package exports (dual):

| Consumer | Resolution |
|----------|------------|
| **Bun** | TypeScript `packages/runtime/src/` via the `bun` export condition (no build) |
| **Node / other** | `dist/` from `bun run build` / `tsup` in `@haozeke/capnp` before publish or Node use |

Generated modules import `import type { Ptr } from "@haozeke/capnp"`. In this
workspace, Bun resolves that to the runtime package via the workspace link.

## Quick start: AddressBook

Pointer slots use **`getP(index)`** (also aliased as `getp`). Decode the classic
Cap'n sample (Alice / Bob) from a framed golden:

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
const name = view.root().getP(0).listGetP(0).getText(0); // Alice
```

Build a message with the multi-segment arena (semantic layout, not CLI byte
identity):

```typescript
import { Message, MessageBuilder } from "@haozeke/capnp";

const PERSON_D = 1;
const PERSON_P = 4;

const b = new MessageBuilder();
const book = b.initRoot(0, 1); // AddressBook: 0 data words, 1 pointer
const people = book.initList(0, 2, PERSON_D, PERSON_P);
people.setU32(0, 123);
people.setText(0, "Alice");
people.setText(1, "alice@example.com");
const bob = people.nextElement();
bob.setU32(0, 456);
bob.setText(0, "Bob");
bob.setText(1, "bob@example.com");

const flat = b.toFlat();
const again = Message.fromFlat(flat);
console.log(again.root().getP(0).listGetP(0).getText(0)); // Alice
```

Packed / canonical helpers (whole-buffer):

```typescript
import { pack, unpack, canonicalizeFlat } from "@haozeke/capnp";

const packed = pack(bytes);
const unpacked = unpack(packed); // same bytes as framed input
const canonical = canonicalizeFlat(bytes); // single-segment preorder form
```

Regenerate goldens (needs system `capnp` 1.4.*):

```console
$ ./scripts/gen-sample-fixtures.sh
```

Codegen plugin usage (typed emit v1): see
[packages/codegen/README.md](packages/codegen/README.md).

```console
$ capnp compile --src-prefix=. \
    -o./packages/codegen/bin/capnpc-ts \
    schema/addressbook.capnp
# → addressbook.ts in cwd (Person getters, PhoneNumber.Type const map, which)
```

## Layout

```
packages/runtime/   @haozeke/capnp wire runtime + golden tests
packages/codegen/   @haozeke/capnpc-ts plugin (typed emit v1)
schema/             addressbook, calculator Expression, u64probe
scripts/            fixture regen against capnp CLI
interop/            offline twin sketch; live twin is Phase 2
docs/orgmode/       architecture layering
examples/           pi-admit-harness (Message.fromFlat Alice/Bob dogfood)
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
| TypeScript | this repo | Wire runtime + `capnpc-ts` (typed emit v1) |
| Fortran | [capnp-fortran](https://github.com/HaoZeke/capnp-fortran) | Serialization + RPC parity bar |
| Janet | [capnp-janet](https://github.com/HaoZeke/capnp-janet) | Ship lessons (`List(Text)` C=6, pack 0xff) |
| C | [c-capnproto](https://github.com/HaoZeke/c-capnproto) | Live golden peer (Phase 2) |
| Spec CLI | Cap'n C++ 1.4.0 `capnp` | encode / packed / canonical oracle |

Shared AddressBook schema id: `@0x9eb32e19f86ee174`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).
