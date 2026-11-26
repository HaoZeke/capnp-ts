#!/usr/bin/env bash
# Print Cap'n Proto 1.4.0 bits for Float32/Float64 defaults of -0.0 and nan.
# Usage: negzero-float-probe.sh [output-dir]
set -euo pipefail

prefix=${CAPNP_PREFIX:-"${HOME}/.local/capnproto-1.4.0"}
if [[ -x "${prefix}/bin/capnp" ]]; then
  export PATH="${prefix}/bin:${PATH}"
  export LD_LIBRARY_PATH="${prefix}/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
fi

out=${1:-$(mktemp -d)}
mkdir -p -- "${out}"

cat > "${out}/probe.capnp" << 'EOF'
@0xa1b2c3d4e5f60718;
struct Z {
  f32 @0 :Float32 = -0.0;
  f64 @1 :Float64 = -0.0;
  f32p @2 :Float32 = 0.0;
  f64p @3 :Float64 = 0.0;
  f32nan @4 :Float32 = nan;
  f64nan @5 :Float64 = nan;
}
EOF

cat > "${out}/probe.c++" << 'EOF'
#include "probe.capnp.h"
#include <capnp/message.h>
#include <capnp/serialize.h>
#include <capnp/schema-parser.h>
#include <capnp/dynamic.h>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cmath>

static uint32_t f32bits(float v) {
  uint32_t u;
  std::memcpy(&u, &v, 4);
  return u;
}
static uint64_t f64bits(double v) {
  uint64_t u;
  std::memcpy(&u, &v, 8);
  return u;
}

static void dumpSeg(const char* label, capnp::MessageBuilder& b) {
  auto words = b.getSegmentsForOutput()[0];
  const auto* bytes = reinterpret_cast<const unsigned char*>(words.begin());
  std::printf("%s segment_words=%zu\n", label, words.size());
  for (size_t i = 0; i < words.size(); i++) {
    uint64_t w;
    std::memcpy(&w, bytes + i * 8, 8);
    std::printf("  word[%zu]=%016llx\n", i, static_cast<unsigned long long>(w));
  }
}

static void printGen(const char* label, Z::Reader r) {
  std::printf(
      "%s gen f32=%08x f64=%016llx f32p=%08x f64p=%016llx f32nan=%08x f64nan=%016llx\n",
      label, f32bits(r.getF32()),
      static_cast<unsigned long long>(f64bits(r.getF64())),
      f32bits(r.getF32p()),
      static_cast<unsigned long long>(f64bits(r.getF64p())),
      f32bits(r.getF32nan()),
      static_cast<unsigned long long>(f64bits(r.getF64nan())));
}

static void printDyn(const char* label, capnp::DynamicStruct::Reader r) {
  std::printf(
      "%s dyn f32=%08x f64=%016llx f32p=%08x f64p=%016llx f32nan=%08x f64nan=%016llx\n",
      label, f32bits(r.get("f32").as<float>()),
      static_cast<unsigned long long>(f64bits(r.get("f64").as<double>())),
      f32bits(r.get("f32p").as<float>()),
      static_cast<unsigned long long>(f64bits(r.get("f64p").as<double>())),
      f32bits(r.get("f32nan").as<float>()),
      static_cast<unsigned long long>(f64bits(r.get("f64nan").as<double>())));
}

int main() {
  {
    capnp::MallocMessageBuilder b;
    auto w = b.initRoot<Z>();
    printGen("unset", w.asReader());
    dumpSeg("unset_gen", b);
  }
  {
    capnp::MallocMessageBuilder b;
    auto w = b.initRoot<Z>();
    w.setF32(-0.0f);
    w.setF64(-0.0);
    printGen("set_neg0", w.asReader());
    dumpSeg("set_neg0_gen", b);
  }
  {
    capnp::MallocMessageBuilder b;
    auto w = b.initRoot<Z>();
    w.setF32(+0.0f);
    w.setF64(+0.0);
    printGen("set_pos0", w.asReader());
    dumpSeg("set_pos0_gen", b);
  }

  capnp::SchemaParser parser;
  auto parsed = parser.parseDiskFile(
      "probe.capnp", "probe.capnp", {});
  auto schema = parsed.getNested("Z").asStruct();
  {
    capnp::MallocMessageBuilder b;
    auto w = b.initRoot<capnp::DynamicStruct>(schema);
    printDyn("unset", w.asReader());
    dumpSeg("unset_dyn", b);
  }
  {
    capnp::MallocMessageBuilder b;
    auto w = b.initRoot<capnp::DynamicStruct>(schema);
    w.set("f32", -0.0f);
    w.set("f64", -0.0);
    printDyn("set_neg0", w.asReader());
    dumpSeg("set_neg0_dyn", b);
  }
  {
    capnp::MallocMessageBuilder b;
    auto w = b.initRoot<capnp::DynamicStruct>(schema);
    w.set("f32", 0.0f);
    w.set("f64", 0.0);
    printDyn("set_pos0", w.asReader());
    dumpSeg("set_pos0_dyn", b);
  }
  {
    uint32_t p32 = 0x7fc00001u;
    uint64_t p64 = 0x7ff8000000000001ull;
    float f;
    double d;
    std::memcpy(&f, &p32, 4);
    std::memcpy(&d, &p64, 8);
    capnp::MallocMessageBuilder b;
    auto w = b.initRoot<capnp::DynamicStruct>(schema);
    w.set("f32nan", f);
    w.set("f64nan", d);
    printDyn("set_payload_nan", w.asReader());
    dumpSeg("set_payload_dyn", b);
  }
  return 0;
}
EOF

(
  cd "${out}"
  capnp compile -oc++ probe.capnp
  g++ -std=c++17 -O2 -o probe probe.c++ probe.capnp.c++ \
    -I"${prefix}/include" -L"${prefix}/lib" -lcapnpc -lcapnp -lkj
  ./probe > probe.out
  {
    echo "----- generated masks (capnpc-c++) -----"
    # Inline accessors. -0.0 fails != 0, so f32/f64 have no mask argument.
    sed -n '/^inline float Z::Reader::getF32/,/^CAPNP_END_HEADER/p' probe.capnp.h
    echo "----- schema forms that are not a NaN payload -----"
    for body in \
      'a @0 :Float32 = nan(1);' \
      'a @0 :Float32 = -nan;' \
      'a @0 :Float64 = 0x7ff8000000000001;'
    do
      printf '@0xaaaaaaaaaaaaaaaa;\nstruct N { %s }\n' "${body}" > one.capnp
      echo "TRY ${body}"
      if capnp compile -oc++ one.capnp > one.log 2>&1; then
        echo "COMPILE_OK"
        awk '/getDataField/,/;/' one.capnp.h
      else
        echo "COMPILE_FAIL"
        cat one.log
      fi
    done
    echo "----- capnp decode of a zero body -----"
    python3 - << 'PY'
import struct, pathlib
frame = struct.pack("<II", 0, 6) + struct.pack("<Q", 0x0000000500000000) + bytes(40)
pathlib.Path("unset.bin").write_bytes(frame)
PY
    capnp decode probe.capnp Z < unset.bin | tee decode-unset.txt
  } >> probe.out
)

echo "${out}"
