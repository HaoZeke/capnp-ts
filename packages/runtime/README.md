# @haozeke/capnp

Pure TypeScript Cap'n Proto **wire** runtime: stream framing, pointer
resolution, field accessors, packed codec, and canonicalization.

Part of the [HaoZeke/capnp-ts](https://github.com/HaoZeke/capnp-ts) monorepo.
Root [README](../../README.md) has the family parity table, AddressBook quick
start, install, and non-goals.

## Install

```console
$ bun add @haozeke/capnp
```

Node ≥ 18 or Bun. Pure ESM; no native addon.

Package exports:

| Condition | Resolution |
|-----------|------------|
| `bun` | TypeScript sources under `src/` (no build step) |
| `types` / `import` / `default` | `dist/` (run `bun run build` / `tsup` before publish) |

## Public surface

Import from the package root:

```typescript
import {
  Message,
  CapnpPointer,
  MessageBuilder,
  pack,
  unpack,
  serializeToFlat,
  canonicalizeFlat,
  CapnpError,
  DEFAULT_TRAVERSAL_WORDS,
  DEFAULT_DEPTH_LIMIT,
} from "@haozeke/capnp";
```

Subpath entry points (same modules):

- `@haozeke/capnp/packed` — `pack` / `unpack`
- `@haozeke/capnp/canonical` — `canonicalize` / `canonicalizeFlat`

Layers: `kinds` → `endian` → `pointer` → `message` / `builder` →
(`serialize` | `packed` | `canonical`). Codegen lives in
`@haozeke/capnpc-ts`.

## Tests

From the monorepo root:

```console
$ bun test packages/runtime
```

Goldens under `test/golden/` are produced by `capnp` 1.4.0
(`scripts/gen-sample-fixtures.sh`).

## Security

Untrusted Cap'n streams need the default traversal/depth limits. See
[SECURITY.md](../../SECURITY.md).

## License

MIT.
