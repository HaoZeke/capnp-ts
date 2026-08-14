@0xbf5e831ac9f0d2a1;
# RPC interop test interface: served by capnp-C++ (interop/rpc_peer_server.c++),
# called by the Fortran vat (interop/rpc_client.f90). The explicit interface id
# is mirrored as ADDER_IFACE in the Fortran client.

interface Adder @0xea01e10cbc414411 {
  add @0 (a :Int64, b :Int64) -> (sum :Int64);
}
