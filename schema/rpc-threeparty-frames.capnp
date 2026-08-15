@0xb1f2c3d4e5a60789;
# Layout-exact subset of rpc.capnp with the three-party ids bound to real
# structs, so that the reference `capnp` CLI can encode level 3 frames.
#
# rpc.capnp types ProvisionId and RecipientId as AnyPointer, which the
# text format cannot fill, so the CLI cannot encode a Provide or an
# Accept from rpc.capnp directly. A struct pointer and an AnyPointer
# holding that same struct encode identically, so binding the ids here
# yields exactly the bytes a conforming vat puts on the wire, produced by
# the reference implementation rather than by one of ours.
#
# Every field below repeats rpc.capnp's ordinals and types verbatim.
# Union discriminants follow ordinals, so the members this file does not
# care about are AnyPointer placeholders holding their ordinals open; all
# members of Message are pointers and share pointer slot 0 either way.
#
# The goldens under test/golden/ come from this schema; see
# scripts/gen-rpc-frames.sh.

struct Message {
  union {
    unimplemented @0 :AnyPointer;
    abort @1 :AnyPointer;
    call @2 :Call;
    return @3 :Return;
    finish @4 :AnyPointer;
    resolve @5 :AnyPointer;
    release @6 :AnyPointer;
    obsoleteSave @7 :AnyPointer;
    bootstrap @8 :AnyPointer;
    obsoleteDelete @9 :AnyPointer;
    provide @10 :Provide;
    accept @11 :Accept;
    join @12 :AnyPointer;
    disembargo @13 :AnyPointer;
  }
}

struct Provide {
  questionId @0 :UInt32;
  target @1 :MessageTarget;
  recipient @2 :RecipientId;
}

struct Accept {
  questionId @0 :UInt32;
  provision @1 :ProvisionId;
  embargo @2 :Bool;
}

struct Call {
  questionId @0 :UInt32;
  target @1 :MessageTarget;
  interfaceId @2 :UInt64;
  methodId @3 :UInt16;
  allowThirdPartyTailCall @8 :Bool = false;
  noPromisePipelining @9 :Bool = false;
  onlyPromisePipeline @10 :Bool = false;
  params @4 :Payload;
  sendResultsTo :union {
    caller @5 :Void;
    yourself @6 :Void;
    thirdParty @7 :RecipientId;
  }
}

struct Return {
  answerId @0 :UInt32;
  releaseParamCaps @1 :Bool = true;
  noFinishNeeded @8 :Bool = false;
  union {
    results @2 :Payload;
    exception @3 :AnyPointer;
    canceled @4 :Void;
    resultsSentElsewhere @5 :Void;
    takeFromOtherQuestion @6 :UInt32;
    acceptFromThirdParty @7 :ThirdPartyCapId;
  }
}

struct Payload {
  content @0 :AnyPointer;
  capTable @1 :List(CapDescriptor);
}

struct CapDescriptor {
  union {
    none @0 :Void;
    senderHosted @1 :UInt32;
    senderPromise @2 :UInt32;
    receiverHosted @3 :UInt32;
    receiverAnswer @4 :AnyPointer;
    thirdPartyHosted @5 :ThirdPartyCapDescriptor;
  }
  attachedFd @6 :UInt8 = 0xff;
}

struct ThirdPartyCapDescriptor {
  id @0 :ThirdPartyCapId;
  vineId @1 :UInt32;
}

struct MessageTarget {
  union {
    importedCap @0 :UInt32;
    promisedAnswer @1 :AnyPointer;
  }
}

# Bound from rpc-threeparty.capnp, unchanged.

struct VatId {
  host @0 :Text;
  port @1 :UInt16;
}

struct ProvisionId {
  nonce @0 :UInt64;
}

struct RecipientId {
  vat @0 :VatId;
  nonce @1 :UInt64;
}

struct ThirdPartyCapId {
  vat @0 :VatId;
  nonce @1 :UInt64;
}
