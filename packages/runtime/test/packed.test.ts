import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { CapnpError } from "../src/kinds.ts";
import { MessageBuilder } from "../src/builder.ts";
import { Message } from "../src/message.ts";
import { storeU32 } from "../src/endian.ts";
import { pack, unpack } from "../src/packed.ts";

const golden = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dir, "golden", name)));

function capnpVersion(bin: string): string | null {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const match = text.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

interface CapnpInstall {
  bin: string;
  include: string;
  libDir: string;
}

/** Locate an installed capnp 1.4.0 from PATH. CAPNP_INCLUDE is optional. */
function locateCapnp140(): CapnpInstall | null {
  const which = spawnSync("which", ["capnp"], { encoding: "utf8" });
  const bin = which.status === 0 ? which.stdout.trim() : "";
  if (!bin || capnpVersion(bin) !== "1.4.0") return null;

  const prefix = dirname(dirname(bin));
  const include = [
    process.env.CAPNP_INCLUDE,
    join(prefix, "include"),
    "/usr/local/include",
    "/usr/include",
    join(homedir(), ".local/include"),
  ]
    .filter((dir): dir is string => !!dir)
    .find((dir) => existsSync(join(dir, "capnp/serialize-packed.h")));
  if (!include) return null;

  const libDir = [
    join(dirname(include), "lib"),
    join(prefix, "lib"),
    join(prefix, "lib64"),
    "/usr/local/lib",
    "/usr/lib",
  ].find(
    (dir) =>
      existsSync(join(dir, "libcapnp.so")) ||
      existsSync(join(dir, "libcapnp.a")) ||
      existsSync(join(dir, "libcapnp.dylib")),
  );
  if (!libDir) return null;
  return { bin, include, libDir };
}

const capnp140 = locateCapnp140();
const inCi = Boolean(
  process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.CIRRUS_CI,
);

function requireCapnp140(): CapnpInstall {
  if (capnp140) return capnp140;
  throw new Error(
    "capnp 1.4.0 was not found on PATH with its headers and libcapnp. Install it, or set CAPNP_INCLUDE to that install's include directory. This test fails in CI instead of skipping.",
  );
}

function hasCapnp(): boolean {
  const which = spawnSync("which", ["capnp"], { encoding: "utf8" });
  const bin = which.status === 0 ? which.stdout.trim() : "";
  return bin !== "" && capnpVersion(bin) === "1.4.0";
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

let packedWriterBin: string | undefined;

/** Compile writePackedMessage against the installed capnp 1.4.0. */
function writePackedMessage(frame: Uint8Array): Uint8Array {
  if (packedWriterBin === undefined) {
    const install = requireCapnp140();
    if (spawnSync("g++", ["--version"]).status !== 0) {
      throw new Error(
        "g++ is required to compile the capnp 1.4.0 writePackedMessage helper",
      );
    }
    const dir = mkdtempSync(join(tmpdir(), "capnp-pack-"));
    const src = join(dir, "packmsg.c++");
    const bin = join(dir, "packmsg");
    writeFileSync(src, PACKED_WRITER_SRC);
    const args = [
      "-std=c++17",
      "-O2",
      "-o",
      bin,
      src,
      `-I${install.include}`,
      `-L${install.libDir}`,
      `-Wl,-rpath,${install.libDir}`,
      "-lcapnp",
      "-lkj",
      "-pthread",
    ];
    const compiled = spawnSync("g++", args, { encoding: "utf8" });
    if (compiled.status !== 0) {
      throw new Error(
        `g++ pack helper failed (include ${install.include}, lib ${install.libDir}): ${compiled.stderr}`,
      );
    }
    packedWriterBin = bin;
  }
  const r = spawnSync(packedWriterBin, [], { input: frame });
  if (r.status !== 0) {
    const err = r.stderr ? new TextDecoder().decode(r.stderr) : "";
    throw new Error(`writePackedMessage helper exited ${r.status}: ${err}`);
  }
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

  test("pack accepts a large verbatim input", () => {
    const input = new Uint8Array(8 * 200_000).fill(0xff);
    expect(unpack(pack(input))).toEqual(input);
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

  test.skipIf(!capnp140 && !inCi)(
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

  test("a raw buffer of leading zeros round-trips", () => {
    const raw = new Uint8Array(48);
    expect([...unpack(pack(raw))]).toEqual([...raw]);
    const leading = new Uint8Array(16);
    leading[8] = 1;
    expect([...unpack(pack(leading))]).toEqual([...leading]);
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
