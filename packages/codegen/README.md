# `@haozeke/capnpc-ts`

Cap'n Proto schema compiler plugin for TypeScript (HaoZeke family).

## Usage

From the monorepo root (or any cwd where you want `.ts` stubs written):

```bash
capnp compile -o./packages/codegen/bin/capnpc-ts schema/addressbook.capnp
```

`capnp` spawns this plugin with a framed `CodeGeneratorRequest` on stdin. The
plugin writes one stub TypeScript module per requested schema file into the
**current working directory** (e.g. `addressbook.ts`).

### Offline / file argument

```bash
capnp compile -o- schema/addressbook.capnp > /tmp/addressbook.cgr.bin
./packages/codegen/bin/capnpc-ts /tmp/addressbook.cgr.bin
```

Dry-run to stdout (no files):

```bash
./packages/codegen/bin/capnpc-ts --stdout /tmp/addressbook.cgr.bin
```

Requires [Bun](https://bun.sh) on `PATH` (shebang is `#!/usr/bin/env bun`). Cap'n
Proto CLI **1.4.x** is pinned via the workspace `pixi.toml`.

## Status (skeleton)

- Opens framed CGR and reports `nodes` / `requestedFiles` counts (hand offsets
  from `schema.capnp`, same layout as `capnp-fortran` `capnp_schema.f90`).
- Prefers `@haozeke/capnp` `Message` / `fromFlat` when that API exists; falls
  back to the hand walk.
- Emits a **stub** module with counts in a header comment - full struct/enum/
  union emit is TODO (see vault issue capnp-ts-mga5).
- Interim hand-rolled AddressBook helpers:
  `packages/runtime/src/generated/addressbook.ts`.

## Package scripts

```bash
bun run --filter @haozeke/capnpc-ts build   # tsc --noEmit
```
