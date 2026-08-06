# Contributing

Thanks for interest in **capnp-ts**. Short path for local development; product
context lives in the root README and `docs/orgmode/architecture.org`.

## Prerequisites

- [Bun](https://bun.sh/) (tests and workspace scripts) or Node ≥ 18
- Optional: [pixi](https://pixi.sh/) for the Cap'n Proto 1.4.* CLI used by
  fixture regen
- Optional: system `capnp` on `PATH` for `scripts/gen-sample-fixtures.sh`

## Setup

```console
git clone https://github.com/HaoZeke/capnp-ts.git
cd capnp-ts
bun install
bun test
```

With pixi (CLI goldens):

```console
pixi install
pixi run fixtures
pixi run test
```

## Wire changes need golden tests

Any change that touches pointer layout, stream framing, packed encoding,
canonicalization, or field accessors **must** keep the golden suite green:

| Command | Coverage |
| ------- | -------- |
| `bun test packages/runtime` | Unit + AddressBook / packed / pointer tests |
| `./scripts/gen-sample-fixtures.sh` | Regenerate CLI goldens (needs `capnp` 1.4.*) |

Prefer asserting against checked-in bytes under
`packages/runtime/test/golden/` (`addressbook.bin`, `.packed.bin`,
`.canonical.bin`) or the encoding.html pack vector. Semantic round-trips are
fine; byte identity is required where the parity table claims it (packed /
canonical against Cap'n C++ 1.4.0).

Do not weaken or skip goldens to paper over a divergence. If the oracle is
wrong, fix the regen script and document why in the commit message.

## Style

- TypeScript strict ESM; match existing module layering
  (`kinds` → `endian` → `pointer` → `message` → codecs)
- Present-tense comments only (what/why); no temporal "after the fix" notes
- Conventional Commits for subjects: `feat:`, `fix:`, `docs:`, `test:`,
  `refactor:`, `chore:`, …
- Do not commit secrets, machine-local paths, or agent/process narration in
  public commits or source

Builds and review notes may reference internal planning; **public** commits
and source must not attribute AI tooling or carry internal host/path
references.

## Scope

Prefer wire-format, codecs, and `capnpc-ts` work here. Product policy packs
and OMP/Pi extensions belong in downstream trees; keep this library
schema-agnostic beyond sample schemas under `schema/`.

RPC is Phase 2 (`@haozeke/capnp-rpc`); do not grow RPC into the runtime
package without an explicit product decision.

## Pull requests

1. Branch from current `main`.
2. Keep the diff focused; separate mechanical style from behavior when both
   appear.
3. Describe *what* and *why*; link issues when applicable.
4. Ensure `bun test` (and any relevant golden regen) pass before review.

## Security

See [SECURITY.md](SECURITY.md) for private vulnerability reporting. Do not
file public issues for unfixed security bugs.

## License

By contributing, you agree that your contributions are licensed under the
project's MIT license (see [LICENSE](LICENSE)).
