# `@haozeke/capnpc-ts`

Cap'n Proto schema compiler plugin for TypeScript (HaoZeke family).

**Status:** typed reader and builder emit. The plugin opens a framed
`CodeGeneratorRequest` (CGR), walks Node/Field/Type, and writes one ESM `.ts`
module per requested schema file with layout constants, field accessors,
const-map enums, and union `which()` helpers. UInt64/Int64 always use `getU64`
/ `bigint` (never `getU32`).

## Install

```console
$ npm install @haozeke/capnp
$ npm install -D @haozeke/capnpc-ts
```

## Requirements

- Node.js ≥ 18 on `PATH` for direct `capnp compile -ots` or `./packages/codegen/bin/capnpc-ts.mjs` execution (plugin shebang: `#!/usr/bin/env node`), or [Bun](https://bun.sh) via `bun run` / `bunx @haozeke/capnpc-ts`
- Cap'n Proto CLI **1.4.x** (`capnp compile`). Workspace pin: root `pixi.toml`

```console
$ pixi install          # from monorepo root
$ pixi run -- capnp --version
```

## Compile examples

In a consumer project with `@haozeke/capnpc-ts` installed (`node` and
`node_modules/.bin` on `PATH`):

```console
$ capnp compile -ots schema.capnp
```

In a Bun-only consumer project (with `@haozeke/capnpc-ts` installed locally and
no `node` on `PATH`), run `capnp compile -ots` through a `package.json` script
with `bun run` (which prepends a `node` shim onto `PATH`), or invoke
`bunx @haozeke/capnpc-ts` (or `bun ./node_modules/@haozeke/capnpc-ts/bin/capnpc-ts.mjs`)
on a dumped CGR:

```console
$ bun run codegen                 # e.g. "codegen": "capnp compile -ots schema.capnp"
$ bunx @haozeke/capnpc-ts schema.cgr.bin
```

Note on binary naming: `capnp compile -ots` looks up an executable named
`capnpc-ts`, which collides with an unrelated unscoped `capnpc-ts` package on
npm. Always install `@haozeke/capnpc-ts` locally first or pass the scoped
`bunx @haozeke/capnpc-ts` package name; bare `bunx capnpc-ts` without a local
install downloads that unrelated unscoped package.

From the monorepo root, plugin binary `packages/codegen/bin/capnpc-ts.mjs`
writes output files into the **process working directory** (named
`<schema-stem>.ts`).

### AddressBook via `capnp compile -o`

```console
$ mkdir -p /tmp/capnpc-ts-out && cd /tmp/capnpc-ts-out
$ capnp compile \
    --src-prefix=/path/to/capnp-ts \
    -o/path/to/capnp-ts/packages/codegen/bin/capnpc-ts.mjs \
    /path/to/capnp-ts/schema/addressbook.capnp
```

From the monorepo root:

```console
$ cd /path/to/capnp-ts
$ capnp compile --src-prefix=. \
    -o./packages/codegen/bin/capnpc-ts.mjs \
    schema/addressbook.capnp
# → addressbook.ts in cwd
```

Expected stderr:

```text
capnpc-ts: CGR ok - nodes=6, requestedFiles=1 (schema/addressbook.capnp)
capnpc-ts: wrote .../addressbook.ts
```

Generated module (shape):

```typescript
import type { Ptr, StructBuilder } from "@haozeke/capnp";

export const PERSON_DWORDS = 1;
export const PERSON_PWORDS = 4;
export function Person_getId(ptr: Ptr, dflt = 0): number {
  return ptr.getU32(0, dflt);
}
export function Person_setId(ptr: StructBuilder, value: number, dflt = 0): void {
  ptr.setU32(0, value, dflt);
}
export function Person_getName(ptr: Ptr): string {
  return ptr.getText(0);
}
export function Person_setName(ptr: StructBuilder, value: string): void {
  ptr.setText(0, value);
}
export function AddressBook_initPeople(
  ptr: StructBuilder,
  count: number,
): StructBuilder {
  return ptr.initList(0, count, 1, 4);
}
export function AddressBook_getPeopleAt(ptr: Ptr, index: number): Ptr {
  return ptr.getP(0).listGetP(index);
}
// List(Text) element helpers use listGetText (not listGetP(i).getText(0)):
// export function Holder_getTagsAt(ptr: Ptr, index: number): string {
//   return ptr.getP(0).listGetText(index);
// }
export const Person_PhoneNumber_Type = {
  mobile: 0,
  home: 1,
  work: 2,
} as const;
export function Person_employment_which(ptr: Ptr): number {
  return ptr.getU16(4);
}
```

Generated modules take a type-only import from `@haozeke/capnp` (workspace
link in this monorepo; published consumers need `@haozeke/capnp` installed).

`--src-prefix` is required when the schema path is absolute or outside the
current directory. Relative schemas under the monorepo root work with
`--src-prefix=.` as above.

### Offline: dump CGR, then run the plugin

```console
$ cd /path/to/capnp-ts
$ capnp compile --src-prefix=. -o- schema/addressbook.capnp > /tmp/addressbook.cgr.bin
$ ./packages/codegen/bin/capnpc-ts.mjs /tmp/addressbook.cgr.bin
# (or with Bun only: bun ./packages/codegen/bin/capnpc-ts.mjs /tmp/addressbook.cgr.bin)
# writes addressbook.ts into cwd
```

Dry-run to stdout (no files written):

```console
$ ./packages/codegen/bin/capnpc-ts.mjs --stdout /tmp/addressbook.cgr.bin
```

### u64probe

```console
$ capnp compile --src-prefix=. \
    -o./packages/codegen/bin/capnpc-ts.mjs \
    schema/u64probe.capnp
# → u64probe.ts with U64Probe_getId / getSigned via getU64
```

## How it works

1. `capnp compile -ots` (or `-o…/capnpc-ts.mjs`) spawns this plugin with a framed CGR on stdin
   (or you pass a CGR file path offline).
2. `plugin.ts` uses `@haozeke/capnp` `Message.fromFlat` + `walkCgr` (full Node /
   Field / Type AST; hand-offset walk remains for summary-only fallbacks).
3. `emit.ts` writes one typed TypeScript module per requested filename
   (`foo/bar.capnp` → `bar.ts` in cwd).

## Status (v1)

| Piece | State |
|-------|--------|
| Framed CGR open + rich AST walk | **yes** |
| `nodes` / `requestedFiles` summary on stderr | **yes** |
| Typed struct getters + layout constants | **yes** |
| Enum const maps (no TS `enum`) / unions / `which` | **yes** |
| List element helpers (`*At` / `*Len`) | **yes** (struct via `listGetP`; Text via `listGetText`) |
| CGR walk of `Field.defaultValue` / `hadExplicitDefault` | **yes** (bit 128; float32 as float) |
| Scalar getter defaults from `Field.defaultValue` | **yes** (incl. non-zero; signed + getF32/getF64) |
| u64probe `bigint` field paths | **yes** |
| Scalar/Text/Data/pointer setters | **yes** (union setters also select the arm) |
| Struct, group, and `List(Struct)` initializers | **yes** (shape resolved from CGR nodes; union group arms set discriminant) |
| Primitive/pointer-list element builders | **no** |

## Package scripts

```console
$ bun run --filter @haozeke/capnpc-ts build
$ bun run --filter @haozeke/capnpc-ts typecheck
$ bun test packages/codegen
```

Root docs: [../../README.md](../../README.md). Runtime API:
[`@haozeke/capnp`](../runtime).
