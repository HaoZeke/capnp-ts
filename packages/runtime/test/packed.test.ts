import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { CapnpError } from "../src/kinds.ts";
import { MessageBuilder } from "../src/builder.ts";
import { Message } from "../src/message.ts";
import { storeU32 } from "../src/endian.ts";
import { pack, unpack } from "../src/packed.ts";

const golden = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dir, "golden", name)));

function hasCapnp(): boolean {
  return spawnSync("capnp", ["--version"], { encoding: "utf8" }).status === 0;
}

const PACKED_WRITER_SRC = `
#include <capnp/serialize-packed.h>
#include <kj/io.h>
#include <unistd.h>
#include <vector>
#include <cstdint>
#include <cstring>
int main() {
  std::vector<uint8_t> buf;
  uint8_t tmp[4096];
  for (;;) {
    ssize_t n = ::read(0, tmp, sizeof(tmp));
    if (n == 0) break;
    if (n < 0) return 1;
    buf.insert(buf.end(), tmp, tmp + n);
  }
  if (buf.size() < 8 || buf.size() % 8 != 0) return 2;
  uint32_t nseg = 0;
  std::memcpy(&nseg, buf.data(), 4);
  nseg += 1;
  size_t tableBytes = 4u + 4u * nseg;
  if (tableBytes % 8u) tableBytes += 4u;
  std::vector<uint32_t> sizes(nseg);
  size_t body = 0;
  for (uint32_t i = 0; i < nseg; i++) {
    std::memcpy(&sizes[i], buf.data() + 4 + 4 * i, 4);
    body += sizes[i];
  }
  if (tableBytes + body * 8 != buf.size()) return 4;
  std::vector<kj::ArrayPtr<const capnp::word>> segs;
  const uint8_t* p = buf.data() + tableBytes;
  for (uint32_t i = 0; i < nseg; i++) {
    segs.push_back(kj::arrayPtr(reinterpret_cast<const capnp::word*>(p), sizes[i]));
    p += sizes[i] * 8;
  }
  kj::FdOutputStream out(1);
  capnp::writePackedMessage(out, kj::arrayPtr(segs.data(), segs.size()));
  return 0;
}
`;

function capnpIncludeDir(): string | null {
  const candidates = [
    process.env.CAPNP_INCLUDE,
    join(homedir(), ".local/include"),
    "/usr/include",
    "/usr/local/include",
  ].filter((p): p is string => !!p);
  for (const dir of candidates) {
    if (existsSync(join(dir, "capnp/serialize-packed.h"))) return dir;
  }
  return null;
}

let packedWriterBin: string | null | undefined;

/** Compile writePackedMessage once. Null when headers or g++ are absent. */
function writePackedMessage(frame: Uint8Array): Uint8Array {
  if (packedWriterBin === undefined) {
    const include = capnpIncludeDir();
    if (!include || spawnSync("g++", ["--version"]).status !== 0) {
      packedWriterBin = null;
    } else {
      const dir = mkdtempSync(join(tmpdir(), "capnp-pack-"));
      const src = join(dir, "packmsg.c++");
      const bin = join(dir, "packmsg");
      writeFileSync(src, PACKED_WRITER_SRC);
      const libDir = join(include, "../lib");
      const args = ["-std=c++17", "-O2", "-o", bin, src, `-I${include}`];
      if (existsSync(libDir)) args.push(`-L${libDir}`);
      args.push("-lcapnp", "-lkj", "-pthread");
      const compiled = spawnSync("g++", args, { encoding: "utf8" });
      packedWriterBin = compiled.status === 0 ? bin : null;
      if (compiled.status !== 0) {
        throw new Error(`g++ pack helper failed: ${compiled.stderr}`);
      }
    }
  }
  if (!packedWriterBin) {
    throw new Error("writePackedMessage helper is not available");
  }
  const r = spawnSync(packedWriterBin, [], { input: frame });
  expect(r.status).toBe(0);
  return new Uint8Array(r.stdout as Uint8Array);
}

function capnpConvert(mode: string, input: Uint8Array): Uint8Array {
  const r = spawnSync("capnp", ["convert", mode], { input });
  expect(r.status).toBe(0);
  return new Uint8Array(r.stdout as Uint8Array);
}

function buildMultiSegmentTextFrame(): Uint8Array {
  const b = new MessageBuilder({ firstWords: 1, maxSegWords: 32 });
  const root = b.initRoot(0, 1);
  root.setText(
    0,
    "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
  );
  return b.toFlat();
}

describe("packed codec", () => {
  test("spec vector from encoding.html", () => {
    const unpacked = Uint8Array.from([
      0x08, 0x00, 0x00, 0x00, 0x03, 0x00, 0x02, 0x00, 0x19, 0x00, 0x00, 0x00, 0xaa, 0x01, 0x00,
      0x00,
    ]);
    const expected = Uint8Array.from([0x51, 0x08, 0x03, 0x02, 0x31, 0x19, 0xaa, 0x01]);
    expect([...pack(unpacked)]).toEqual([...expected]);
    expect([...unpack(expected)]).toEqual([...unpacked]);
  });

  test("AddressBook pack byte-identical to CLI golden", () => {
    const bin = golden("addressbook.bin");
    const packed = golden("addressbook.packed.bin");
    expect([...pack(bin)]).toEqual([...packed]);
  });

  test("AddressBook unpack packed golden", () => {
    const bin = golden("addressbook.bin");
    const packed = golden("addressbook.packed.bin");
    expect([...unpack(packed)]).toEqual([...bin]);
  });

  test("default pack round-trips a multi-segment frame", () => {
    const frame = buildMultiSegmentTextFrame();
    const packed = pack(frame);
    expect([...unpack(packed)]).toEqual([...frame]);
  });

  test("multi-segment pack does not run across segment boundaries", () => {
    // Three segments. The first two are all zeros, so one continuous run
    // would swallow both. The packed writer stops the run at each segment.
    const sizes = [4, 4, 1];
    let tableBytes = 4 + 4 * sizes.length;
    if (tableBytes % 8 !== 0) tableBytes += 4;
    const bodyWords = sizes.reduce((sum, n) => sum + n, 0);
    const frame = new Uint8Array(tableBytes + bodyWords * 8);
    storeU32(frame, 0, sizes.length - 1);
    for (let i = 0; i < sizes.length; i++) storeU32(frame, 4 + 4 * i, sizes[i]!);
    for (let i = 0; i < 8; i++) frame[frame.length - 8 + i] = 0x11 * (i + 1);
    // Bytes from writePackedMessage on this frame (segment table, then each segment).
    const expected = [
      0x11, 0x02, 0x04, 0x11, 0x04, 0x01, 0x00, 0x03, 0x00, 0x03, 0xff, 0x11, 0x22, 0x33,
      0x44, 0x55, 0x66, 0x77, 0x88, 0x00,
    ];
    const packed = pack(frame);
    expect([...packed]).toEqual(expected);
    expect([...unpack(packed)]).toEqual([...frame]);
  });

  test.skipIf(!hasCapnp() || !capnpIncludeDir())(
    "default pack matches writePackedMessage on a 3-segment frame",
    () => {
    const frame = buildMultiSegmentTextFrame();
    expect(Message.fromFlat(frame).segmentCount).toBe(3);
    const packed = pack(frame);
    expect([...unpack(packed)]).toEqual([...frame]);
    const cpp = writePackedMessage(frame);
    expect([...packed]).toEqual([...cpp]);
    expect(packed.length).toBe(106);
    },
  );

  test.skipIf(!hasCapnp())("compactFramed pack matches capnp convert", () => {
    const frame = buildMultiSegmentTextFrame();
    const expected = capnpConvert("binary:packed", frame);
    expect([...pack(frame, { compactFramed: true })]).toEqual([...expected]);
    // Default packing keeps the framed bytes, so it diverges from convert
    // when the frame has more than one segment.
    const raw = pack(frame);
    expect([...unpack(raw)]).toEqual([...frame]);
    expect([...raw]).not.toEqual([...expected]);
    expect(frame.length).toBeGreaterThan(unpack(expected).length);
  });

  test("unpack rejects packed amplification bomb with PACKED", () => {
    // Each 0x00 0xff expands to 256 zero words (tag word + 255 more).
    // With a tight maxWords, a short packed stream must not allocate huge.
    const bomb = new Uint8Array(64);
    for (let i = 0; i < bomb.length; i += 2) {
      bomb[i] = 0x00;
      bomb[i + 1] = 0xff;
    }
    try {
      unpack(bomb, { maxWords: 16 });
      expect.unreachable("expected CapnpError PACKED");
    } catch (e) {
      expect(e).toBeInstanceOf(CapnpError);
      expect((e as CapnpError).code).toBe("PACKED");
    }
  });
});
