# Interop

CLI goldens under `packages/runtime/test/golden/` are the primary serialization
oracle (`capnp encode` / `convert binary:packed` / `binary:canonical` with
Cap'n Proto C++ 1.4.0).

## Live Cap'n Proto C++ 1.4.0 RPC peer

`rpc_peer.c++`, `build-peer.sh`, and `run_rpc_interop.sh` test
`@haozeke/capnp-rpc` against a real `capnp::EzRpcServer` / `EzRpcClient` in
both directions over TCP (`pixi run rpc-interop`).

## Offline c-capnproto twin sketch

`emit_c_twin.c` builds a tiny framed message with the same alloc order used
by capnp-fortran `interop/golden_master.c` (root struct, text, composite
list). Needs HaoZeke/c-capnproto headers (`capnp_c.h`) on the include path:

```console
$ cc -I/path/to/c-capnproto -o /tmp/emit_c_twin emit_c_twin.c \
    /path/to/c-capnproto/libcapnp_c.a
$ /tmp/emit_c_twin > golden/c_twin_demo.bin
```

`golden/c_twin_demo.bin` is a checked-in sample frame for offline decode
experiments; it is not a Tier A identity claim against the TS builder.
