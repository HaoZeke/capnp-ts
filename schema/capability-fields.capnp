@0xb48b01d634a9e052;
# Fields the `capnp` tool cannot read, since it reads messages without a
# capability context.

interface Ping {
  ping @0 ();
}

struct CapHolder {
  label @0 :Text;
  ping @1 :Ping;
  pings @2 :List(Ping);
  any @3 :Capability;
}
