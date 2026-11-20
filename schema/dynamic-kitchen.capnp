@0xd48e91a56c3b72f0;

annotation docTag @0xe1a2b3c4d5e6f701 (file, enum, struct, field, enumerant, interface, method) :Text;
annotation weight @0xe1a2b3c4d5e6f702 (struct, field) :Int32;

# Canonical capnp/compat/json.capnp annotation IDs for self-contained JSON tests.
struct JsonFlattenOptions {
  prefix @0 :Text = "";
}

struct JsonDiscriminatorOptions {
  name @0 :Text;
  valueName @1 :Text;
}

annotation jsonName @0xfa5b1fd61c2e7c3d (field, enumerant, method, group, union) :Text;
annotation jsonFlatten @0x82d3e852af0336bf (field, group, union) :JsonFlattenOptions;
annotation jsonDiscriminator @0xcfa794e8d19a0162 (struct, union) :JsonDiscriminatorOptions;
annotation jsonBase64 @0xd7d879450a253e4b (field) :Void;
annotation jsonHex @0xf061e22f0ae5c7b5 (field) :Void;

$docTag("dynamic-kitchen-file");

enum Priority $docTag("priority-enum") {
  low @0;
  normal @1 $docTag("default-priority");
  high @2;
  critical @3 $jsonName("CRITICAL");
}

struct Tag $docTag("tag-struct") $weight(7) {
  key @0 :Text = "default-key" $docTag("tag-key");
  code @1 :Int32 = -42 $weight(3);
}

struct Envelope(Payload) {
  label @0 :Text;
  payload @1 :Payload;
  items @2 :List(Entry);

  struct Entry {
    value @0 :Payload;
  }
}

struct KitchenSink $docTag("sink") {
  nothing @0 :Void;
  flag @1 :Bool;
  flagDefaultTrue @2 :Bool = true;

  i8 @3 :Int8 = -12;
  i16 @4 :Int16 = -3000;
  i32 @5 :Int32 = -100000;
  i64 @6 :Int64 = -9007199254740993;

  u8 @7 :UInt8 = 200;
  u16 @8 :UInt16 = 50000;
  u32 @9 :UInt32 = 3000000000;
  u64 @10 :UInt64 = 9007199254740995;

  f32 @11 :Float32 = 1.5;
  f64 @12 :Float64 = -2.25;

  title @13 :Text = "untitled";
  raw @14 :Data = 0x"cafe";
  priority @15 :Priority = normal;

  defaultTag @16 :Tag = (key = "preset", code = 99);
  defaultNums @17 :List(Int32) = [10, -20, 30];

  matrix @18 :List(List(Int32));
  wordGrid @19 :List(List(Text));
  tags @20 :List(Tag);
  flags @21 :List(Bool);
  voids @22 :List(Void);
  priorities @23 :List(Priority);

  meta :group {
    author @24 :Text = "anon";
    revision @25 :UInt32 = 1;
    nested :group {
      ok @26 :Bool = true;
      score @27 :Float64 = 0.5;
    }
  }

  union {
    none @28 :Void;
    note @29 :Text;
    count @30 :Int64;
    detail :group {
      detailId @31 :UInt32;
      detailName @32 :Text;
    }
  }

  source :union {
    unset @33 :Void;
    uri @34 :Text;
    inlineData @35 :Data;
  }

  stringBox @36 :Envelope(Text);
  tagBox @37 :Envelope(Tag);
}

struct JsonCustom $jsonDiscriminator(name = "kind") {
  renamedField @0 :Text $jsonName("renamed_field");
  hexBlob @1 :Data $jsonHex;
  b64Blob @2 :Data $jsonBase64;
  flatTag @3 :Tag $jsonFlatten(prefix = "tag_");
  prio @4 :Priority;

  union {
    emptyVariant @5 :Void $jsonName("empty");
    textVariant @6 :Text $jsonName("text_val");
    flatVariant @7 :Tag $jsonName("tag_val") $jsonFlatten(prefix = "v_");
  }

  boxedUnion :union $jsonDiscriminator(name = "boxType", valueName = "boxValue") {
    none @8 :Void;
    num @9 :Int64;
    label @10 :Text;
  }
}

interface BaseService $docTag("base-iface") {
  ping @0 (msg :Text) -> (reply :Text) $docTag("ping-method");
}

interface SubService extends(BaseService) {
  compute @0 (input :Tag) -> (output :KitchenSink);
}

const extremeConst :KitchenSink = (
  flag = true,
  flagDefaultTrue = false,
  i8 = -128,
  i16 = 32767,
  i32 = -2147483648,
  i64 = -9223372036854775808,
  u8 = 255,
  u16 = 65535,
  u32 = 4294967295,
  u64 = 18446744073709551615,
  f32 = nan,
  f64 = -inf,
  title = "Hello\n\"Cap'n\"\tProto",
  raw = 0x"0001020708090a0b0c0d1f207f80feff",
  priority = critical,
  matrix = [[1, -2, 3], [], [2147483647, -2147483648]],
  wordGrid = [["alpha", "beta"], ["gamma"]],
  tags = [(key = "first", code = 1), (key = "second", code = -2)],
  flags = [true, false, true, true, false, false, true, false, true],
  voids = [void, void, void],
  priorities = [low, high, critical],
  meta = (author = "Grace", revision = 7, nested = (ok = false, score = inf)),
  detail = (detailId = 404, detailName = "missing"),
  source = (inlineData = 0x"deadbeef"),
  stringBox = (label = "str-env", payload = "inside", items = [(value = "one"), (value = "two")]),
  tagBox = (label = "tag-env", payload = (key = "inner", code = 11), items = [(value = (key = "elem", code = 22))])
);

const magicAnswer :Int64 = 9223372036854775807;
const greetingList :List(Text) = ["ni hao", "shalom", "hello"];
