# `@haozeke/capnp-rpc`

Cap'n Proto RPC vat for the pure TypeScript runtime (`@haozeke/capnp`),
covering levels 1 through 4 over pluggable transports.

Part of the [HaoZeke/capnp-ts](https://github.com/HaoZeke/capnp-ts) monorepo.
See [docs/orgmode/rpc.org](../../docs/orgmode/rpc.org) for protocol design
notes and [README.md](../../README.md) for the family parity table.

## Install

```console
$ npm install @haozeke/capnp @haozeke/capnp-rpc
```

Node >= 18 or Bun. Pure ESM; no native addon.

### TypeScript consumer settings

The published declarations reference `Symbol.dispose` and `AbortSignal`. When
type-checking with `skipLibCheck: false`, include `esnext.disposable` (or
`es2025`+) in `tsconfig.json` `compilerOptions.lib` and ensure `AbortSignal`
is available via `DOM`, `@types/node`, or `@types/bun`.

## Capabilities and levels

- **Level 1**: `Vat`, `RpcConnection`, `Client`, `RpcPromise`, explicit
  reference counting, promise pipelining, bidirectional `Resolve` and
  `Disembargo`, call cancellation (`Finish`, `allowCancellation`,
  `CallContext.signal`), outgoing and incoming tail calls
  (`CallContext.tailCall`), abort/disconnect handling, streaming flow control
  (`RpcStream`, fixed 64 KiB or transport send-buffer window, opt-in
  `AdaptiveStreamWindow`), and membranes (`membrane`, `reverseMembrane`,
  `MembranePolicy`, `RevocablePolicy`).
- **Level 2**: `Persistent` interface (`savePersistent`, `servePersistent`),
  matching Cap'n Proto C++ (no built-in SturdyRef registry).
- **Level 3**: three-party handoff (`Provide`, `Accept` with embargo,
  `thirdPartyHosted` introductions over `rpc-threeparty.capnp`) across vats.
- **Level 4**: two-party `Join` (`sendJoin` and answer handling).

## Tests

From the monorepo root (after `bun run build`):

```console
$ bun test packages/rpc
```

Live bidirectional interop against a Cap'n Proto C++ 1.4.0 peer runs via
`interop/run_rpc_interop.sh`.

## License

MIT — see [LICENSE](LICENSE).
