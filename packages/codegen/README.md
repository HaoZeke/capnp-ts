# `@haozeke/capnpc-ts`

Cap'n Proto schema compiler plugin for TypeScript (HaoZeke family).

**Status:** v1 typed emit. The plugin opens a framed `CodeGeneratorRequest`
(CGR), walks Node/Field/Type, and writes one ESM `.ts` module per requested
schema file with layout constants, field getters, const-map enums, and union
`which()` helpers. UInt64/Int64 always use `getU64` / `bigint` (never `getU32`).

## Requirements

- [Bun](https://bun.sh) on `PATH` (plugin shebang: `#!/usr/bin/env bun`)
- Cap'n Proto CLI **1.4.x** (`capnp compile`). Workspace pin: root `pixi.toml`

```console
$ pixi install          # from monorepo root
$ pixi run -- capnp --version
```

## Compile examples (from monorepo root)

Plugin binary: `packages/codegen/bin/capnpc-ts`. Output files are written into
the **process working directory** (not next to the schema), named
`<schema-stem>.ts`.

### AddressBook via `capnp compile -o`

```console
$ mkdir -p /tmp/capnpc-ts-out && cd /tmp/capnpc-ts-out
$ capnp compile \
    --src-prefix=/path/to/capnp-ts \
    -o/path/to/capnp-ts/packages/codegen/bin/capnpc-ts \
    /path/to/capnp-ts/schema/addressbook.capnp
```

From the monorepo root:

```console
$ cd /path/to/capnp-ts
$ capnp compile --src-prefix=. \
    -o./packages/codegen/bin/capnpc-ts \
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
import type { Ptr } from "@haozeke/capnp";

export const PERSON_DWORDS = 1;
export const PERSON_PWORDS = 4;
export function Person_getId(ptr: Ptr, dflt = 0): number {
  return ptr.getU32(0, dflt);
}
export function Person_getName(ptr: Ptr): string {
  return ptr.getText(0);
}
export function AddressBook_getPeopleAt(ptr: Ptr, index: number): Ptr {
  return ptr.getP(0).listGetP(index);
}
export const Person_PhoneNumber_Type = {
  mobile: 0,
  home: 1,
  work: 2,
} as const;
export function Person_employment_which(ptr: Ptr): number {
  return ptr.getU16(4);
}
```

`--src-prefix` is required when the schema path is absolute or outside the
current directory. Relative schemas under the monorepo root work with
`--src-prefix=.` as above.

### Offline: dump CGR, then run the plugin

```console
$ cd /path/to/capnp-ts
$ capnp compile --src-prefix=. -o- schema/addressbook.capnp > /tmp/addressbook.cgr.bin
$ ./packages/codegen/bin/capnpc-ts /tmp/addressbook.cgr.bin
# writes addressbook.ts into cwd
```

Dry-run to stdout (no files written):

```console
$ ./packages/codegen/bin/capnpc-ts --stdout /tmp/addressbook.cgr.bin
```

### u64probe

```console
$ capnp compile --src-prefix=. \
    -o./packages/codegen/bin/capnpc-ts \
    schema/u64probe.capnp
# → u64probe.ts with U64Probe_getId / getSigned via getU64
```

## How it works

1. `capnp compile -o…/capnpc-ts` spawns this plugin with a framed CGR on stdin
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
| List element helpers (`*At` / `*Len`) | **yes** (struct lists) |
| u64probe `bigint` field paths | **yes** |
| Non-zero schema-default XOR / full setters | **no** (M6) |

## Package scripts

```console
$ bun run --filter @haozeke/capnpc-ts build   # tsc --noEmit
$ bun test packages/codegen
```

Root docs: [../../README.md](../../README.md). Runtime API:
[`@haozeke/capnp`](../runtime).
