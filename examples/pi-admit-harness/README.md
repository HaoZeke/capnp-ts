# Pi / OMP admit harness (`@haozeke/capnp`)

Standalone **admit (prepare)** example: load a Cap'n Proto stream-framed
message with `Message.fromFlat`, inspect segments, and surface decoded fields
without a native addon.

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

From the monorepo root (after `bun install` at the workspace root):

```bash
bun examples/pi-admit-harness/admit-harness.ts
# or
bun run --filter @haozeke/capnp-pi-admit-harness start
```

Default: admit the AddressBook golden via `Message.fromFlat` and print Alice /
Bob with phones and employment:

`packages/runtime/test/golden/addressbook.bin`

Override the path:

```bash
CAPNP_ADMIT_BIN=/path/to/message.bin bun examples/pi-admit-harness/admit-harness.ts
```

Force a tiny builder-encoded Text root (no golden file):

```bash
CAPNP_ADMIT_TINY=1 bun examples/pi-admit-harness/admit-harness.ts
```

Encode a one-person AddressBook with `MessageBuilder`, then admit it:

```bash
CAPNP_ADMIT_BUILD=1 bun examples/pi-admit-harness/admit-harness.ts
```

## Dependency

`package.json` depends on the workspace runtime only:

```json
"@haozeke/capnp": "workspace:*"
```

Root `package.json` workspaces include `examples/*` so the link resolves under
Bun (import works from `examples/pi-admit-harness/` and from repo-root
`bun examples/pi-admit-harness/admit-harness.ts`).

**Do not** add `@oh-my-pi/*` here unless that package is installed in the
environment you ship to. The harness stays free of OMP packages so CI and
laptop clones without `pi_env` still run.

## How an OMP extension would wrap this

When `@oh-my-pi/pi-coding-agent` (or the Pi equivalent) **is** available in the
host that loads extensions, wrap admit as a tool. Comment-only sketch (do not
paste the `@oh-my-pi` import into a tree that lacks the package):

```ts
// Only when the host has OMP/Pi installed:
// import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Message } from "@haozeke/capnp";
import {
  admitFromBytes,
  formatAdmitReport,
} from "./admit-harness.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "capnp_admit",
    label: "Cap'n admit (prepare)",
    description:
      "Admit a Cap'n Proto stream-framed buffer via Message.fromFlat. " +
      "Pure ESM via @haozeke/capnp; no native addon.",
    // parameters: Type.Object({ path: Type.String() }), // host schema helper
    async execute(_toolCallId, params: { path: string }) {
      const { readFile } = await import("node:fs/promises");
      const bytes = new Uint8Array(await readFile(params.path));
      // Prefer the helpers, or call Message.fromFlat directly:
      // const msg = Message.fromFlat(bytes);
      // const people = msg.root().getP(0);
      const view = admitFromBytes(bytes, params.path);
      return { content: [{ type: "text", text: formatAdmitReport(view) }] };
    },
  });
}
```

### ExtensionAPI surface used

| Host API | Role in this pattern |
|----------|----------------------|
| `export default function (pi: ExtensionAPI)` | Extension entry Bun/OMP loads |
| `pi.registerTool({ name, execute })` | Registers the admit tool |
| `execute` return `{ content: [{ type: "text", text }] }` | Tool result for the agent |

Admit-only means: `Message.fromFlat` / `Message.viewFlat` + schema field
access via pointer offsets. RPC, packed transport, and capability tables are
out of scope for this harness (packed helpers exist on `@haozeke/capnp` if the
extension needs them later).

## Decode path (Message + generated getters)

```ts
import { Message } from "@haozeke/capnp";
import {
  AddressBook_getPeopleAt,
  Person_getId,
  Person_getName,
  Person_getEmail,
} from "./gen/addressbook.ts";

const msg = Message.fromFlat(bytes);
const root = msg.root();
const alice = AddressBook_getPeopleAt(root, 0);
Person_getId(alice);    // 123
Person_getName(alice);  // "Alice"
Person_getEmail(alice); // "alice@example.com"
```

`gen/addressbook.ts` is produced by `@haozeke/capnpc-ts` from
`schema/addressbook.capnp`. Admit uses `Message.fromFlat` / `Message.viewFlat`
and the generated `AddressBook_*` / `Person_*` helpers (no hand frame scan).

## Schema compile for harness messages

Regenerate the checked-in module when the schema changes:

```bash
# from monorepo root; plugin binary is packages/codegen/bin/capnpc-ts
capnp compile --src-prefix=. \
  -o./packages/codegen/bin/capnpc-ts:examples/pi-admit-harness/gen \
  schema/addressbook.capnp
```

Generated modules are Bun-strip-safe ESM (const-map enums, no `enum` keyword).
Default admit target is the AddressBook golden (Alice / Bob from
`scripts/gen-sample-fixtures.sh`).

## Layout

| File                 | Role                                         |
|----------------------|----------------------------------------------|
| `admit-harness.ts`   | Standalone admit script + reusable helpers   |
| `gen/addressbook.ts` | capnpc-ts emit (typed getters for decode)    |
| `package.json`       | ESM package; workspace dep on runtime        |
| `README.md`          | This doc                                     |

## Related

- Runtime: `packages/runtime` (`@haozeke/capnp`)
- Codegen: `packages/codegen` (`@haozeke/capnpc-ts`)
- Goldens: `packages/runtime/test/golden/`
- Fixture regen: `scripts/gen-sample-fixtures.sh`
