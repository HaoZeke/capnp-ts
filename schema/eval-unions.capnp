@0xb6d6a1e2c3f40a11;
# Constants whose `capnp eval -o json` output depends on union placement and
# on how a null default union member is written.

using Kitchen = import "dynamic-kitchen.capnp";

struct PointerArms {
  union {
    textA @0 :Text;
    num @1 :Int32;
    tag @2 :Kitchen.Tag;
  }
  after @3 :Text;
}

struct GroupArms {
  before @0 :Text;
  union {
    a @1 :Void;
    b :group {
      x @2 :Int32;
      y @3 :Text;
    }
  }
  mid @4 :Int32;
  last @5 :List(Int32);
}

struct Holder {
  arms @0 :List(PointerArms);
  inner @1 :GroupArms;
  named :union {
    first @2 :Text;
    second @3 :PointerArms;
  }
}

const emptyDefault :PointerArms = (textA = "");
const unsetArms :PointerArms = ();
const numArm :PointerArms = (num = 5, after = "z");
const tagArm :PointerArms = (tag = (key = "k"));
const groupArm :GroupArms = (before = "s", b = (x = 1), mid = 2);
const voidArm :GroupArms = (before = "s", mid = 2, last = [1]);
const nested :Holder = (arms = [(), (num = 1), (after = "x")], inner = (), named = (second = (tag = ())));
const custom :Kitchen.JsonCustom = (renamedField = "r", hexBlob = 0x"0102", b64Blob = 0x"0304", flatTag = (key = "f", code = 1), prio = critical, textVariant = "tv", boxedUnion = (num = 9));
const customFlat :Kitchen.JsonCustom = (flatVariant = (key = "fv"), boxedUnion = (label = "L"));
const customEmpty :Kitchen.JsonCustom = ();
