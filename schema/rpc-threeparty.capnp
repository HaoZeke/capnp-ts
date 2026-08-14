@0xd94d1d3f0d9f8a11;
# A three-party network layer for Cap'n Proto RPC level 3.
#
# rpc.capnp leaves ProvisionId, RecipientId, ThirdPartyCapId and the join
# keys as AnyPointer on purpose: what a "vat" is, and how one vat names
# another, belongs to the network. rpc-twoparty.capnp answers that by
# declaring most of them empty, because a connection between exactly two
# vats has no third to name. This layer answers it differently.
#
# The handoff (encoding of rpc.capnp's Provide / Accept):
#
#   Alice holds a capability hosted by Bob and wants Carol to have it.
#   1. Alice -> Bob   Provide{target, recipient = RecipientId{carol, nonce}}
#   2. Alice -> Carol a ThirdPartyCapDescriptor{id = ThirdPartyCapId{bob, nonce}}
#   3. Carol -> Bob   Accept{provision = ProvisionId{nonce}}
#   4. Bob   -> Carol Return carrying the capability
#
# The nonce is what ties the three messages together: Bob matches Carol's
# Accept against Alice's Provide by nonce alone, so Bob never has to trust
# Carol's account of who sent her.

struct VatId {
  # Where a vat can be reached. A network with a directory would carry an
  # opaque id instead; an address is what this one has.

  host @0 :Text;
  port @1 :UInt16;
}

struct ProvisionId {
  # Accept.provision: which pending Provide is being claimed.

  nonce @0 :UInt64;
}

struct RecipientId {
  # Provide.recipient: who the provider should expect an Accept from.

  vat @0 :VatId;
  nonce @1 :UInt64;
}

struct ThirdPartyCapId {
  # ThirdPartyCapDescriptor.id: how the recipient reaches the provider,
  # and which pending Provide to claim once there.

  vat @0 :VatId;
  nonce @1 :UInt64;
}

struct JoinKeyPart {
  # Level 4 over this network, same shape the two-party layer uses.

  joinId @0 :UInt32;
  partCount @1 :UInt16;
  partNum @2 :UInt16;
}

struct JoinResult {
  joinId @0 :UInt32;
  succeeded @1 :Bool;
  cap @2 :Capability;
}
