@0xd1e5a3b7c9f20486;
# Interfaces the RPC interop peers exercise: capability lifecycle, promise
# resolution, cancellation, embargo, abort, streaming and membranes. The C++
# peer in interop/rpc_peer.c++ and the TypeScript vat each play both roles.

using Cxx = import "/capnp/c++.capnp";
using import "/capnp/stream.capnp".StreamResult;

interface Counter {
  inc @0 (n :UInt32) -> (n :UInt32);
}

interface Echo {
  ping @0 (n :UInt32) -> (n :UInt32);
  makeCounter @1 () -> (counter :Counter);
  # Returns a promise capability, resolved by resolveLater.
  makePromise @2 () -> (counter :Counter);
  resolveLater @3 ();
  # Blocks until unblock. Cancellation is allowed.
  slow @4 () -> (n :UInt32) $Cxx.allowCancellation;
  unblock @5 ();
  stats @6 () -> (cancelled :UInt32, released :UInt32, completedUncancelable :UInt32);
  callBack @7 (cap :Counter, n :UInt32) -> (n :UInt32);
  echoCap @8 (cap :Counter) -> (cap :Counter);
  fail @9 ();
  brokenCap @10 () -> (cap :Counter);
  hold @11 (cap :Counter);
  callHeld @12 (n :UInt32) -> (n :UInt32);
  # Returns a promise that resolves, on resolveHeld, to the capability hold received.
  promiseOfHeld @13 () -> (cap :Counter);
  resolveHeld @14 ();
  # Blocks until unblock and cannot be canceled.
  slowUncancelable @15 () -> (n :UInt32);
  die @16 ();
  openSink @17 () -> (sink :Sink);
}

interface Sink {
  write @0 (data :Data) -> stream;
  done @1 () -> (total :UInt64);
}
