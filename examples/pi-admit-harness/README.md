# Pi / OMP admit harness (`@haozeke/capnp`)

Standalone **admit (prepare)** example: load a Cap'n Proto stream-framed
message, inspect segments, and surface decoded fields without a native addon.

This is **not** a full Oh My Pi / OMP extension. It is pure ESM meant to run
under Bun or Node ≥ 18, including the Bun strip loader used by OMP extensions
under `pi_env`.

## Why pure TS

OMP extensions load TypeScript via Bun:

```ts
export default function (pi: ExtensionAPI) { /* ... */ }
```

Native node addons and libcapnp-linked packages break strip loaders and make
extension distribution painful. `@haozeke/capnp` is pure TypeScript so an
extension can **admit** (prepare / zero-copy view) Cap'n frames with no compile
step.

## Run (standalone)

From the monorepo root (after workspace install):

```bash
bun examples/pi-admit-harness/admit-harness.ts
# or
bun run --filter @haozeke/capnp-pi-admit-harness start
```

By default the harness admits the AddressBook golden:

`packages/runtime/test/golden/addressbook.bin`

Override the path:

```bash
CAPNP_ADMIT_BIN=/path/to/message.bin bun examples/pi-admit-harness/admit-harness.ts
```

Force the built-in tiny framed fixture (no golden file):

```bash
CAPNP_ADMIT_TINY=1 bun examples/pi-admit-harness/admit-harness.ts
```

## Dependency

`package.json` depends on the workspace runtime only:

```json
"@haozeke/capnp": "workspace:*"
```

Root `package.json` workspaces include `examples/*` so the link resolves.

**Do not** add `@oh-my-pi/*` here unless that package is installed in the
environment you ship to. The harness stays free of OMP packages so CI and
laptop clones without `pi_env` still run.

## How an OMP extension would wrap this

When `@oh-my-pi/pi-coding-agent` (or the Pi equivalent) **is** available in the
host that loads extensions, wrap admit as a tool/hook. Comment-only sketch
(do not paste this import into a tree that lacks the package):

```ts
// Only when the host has OMP/Pi installed:
// import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { admitFromBytes, formatAdmitReport } from "./admit-harness.ts";
// Prefer the public runtime once schema-typed roots land:
// import { Message } from "@haozeke/capnp";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "capnp_admit",
    label: "Cap'n admit (prepare)",
    description:
      "Admit a Cap'n Proto stream-framed buffer for zero-copy field access. " +
      "Pure ESM via @haozeke/capnp; no native addon.",
    // parameters: Type.Object({ path: Type.String() }), // host schema helper
    async execute(_toolCallId, params: { path: string }) {
      const { readFile } = await import("node:fs/promises");
      const bytes = new Uint8Array(await readFile(params.path));
      const view = admitFromBytes(bytes);
      return { content: [{ type: "text", text: formatAdmitReport(view) }] };
    },
  });
}
```

Admit-only means: frame parse + segment view + (when runtime/codegen land)
schema-typed getters. RPC, packed transport, and capability tables are out of
scope for this harness.

## Schema compile for harness messages

When `capnpc-ts` is available:

```bash
# plugin on PATH from packages/codegen
capnp compile -o ts schema/addressbook.capnp
```

Generated modules are Bun-strip-safe ESM (const-map enums, no `enum` keyword).
Until codegen lands, this harness uses the wire admit path and prints framing
plus Text payloads discovered in the AddressBook golden (Alice / Bob fixture
from `scripts/gen-sample-fixtures.sh`).

## Layout

| File              | Role                                      |
|-------------------|-------------------------------------------|
| `admit-harness.ts`| Standalone admit script + reusable helpers |
| `package.json`    | ESM package; workspace dep on runtime     |
| `README.md`       | This doc                                  |

## Related

- Runtime: `packages/runtime` (`@haozeke/capnp`)
- Codegen: `packages/codegen` (`@haozeke/capnpc-ts`)
- Goldens: `packages/runtime/test/golden/`
- Fixture regen: `scripts/gen-sample-fixtures.sh`
