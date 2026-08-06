@0x9f8e7d6c5b4a3928;

# Minimal schema for codegen smoke: UInt64/Int64 must emit capnp/get-u64.
struct U64Probe {
  id @0 :UInt64;
  signed @1 :Int64;
}
