/**
 * Attached file descriptors over a real unix socket, against capnp-C++ 1.4.0.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "../src/index.ts";
import { openFdLib, UnixFdTransport, unixConnect } from "../src/unix.ts";
import { RpcConnection } from "../src/vat.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function buildPeer(): { so: string; peer: string } | undefined {
  const so = "/tmp/libfdmsg-r6.so";
  const dir = "/tmp/fd-peer-r6";
  const peer = join(dir, "fd_peer");
  const cc = spawnSync("cc", ["-shared", "-fPIC", "-o", so, join(root, "packages/rpc/src/fdmsg.c")]);
  if (cc.status !== 0) return undefined;
  spawnSync("mkdir", ["-p", dir]);
  const schema = join(root, "schema/fdcap.capnp");
  const gen = spawnSync(
    "capnp",
    ["compile", "--src-prefix=" + join(root, "schema"), "-oc++:" + dir, schema],
    { encoding: "utf8" },
  );
  if (gen.status !== 0) return undefined;
  const cxx = spawnSync(
    "g++",
    [
      "-std=c++17",
      "-o",
      peer,
      join(root, "interop/fd_peer.c++"),
      join(dir, "fdcap.capnp.c++"),
      "-I",
      dir,
      ...spawnSync("pkg-config", ["--cflags", "--libs", "capnp-rpc"], { encoding: "utf8" }).stdout.trim().split(/\s+/),
    ],
  );
  if (cxx.status !== 0) return undefined;
  return { so, peer };
}

describe("unix socket attached fd", () => {
  test("a C++ peer's bootstrap capability arrives with its pipe", async () => {
    const built = buildPeer();
    expect(built).toBeDefined();
    const sock = `/tmp/fd-r6-${process.pid}.sock`;
    const child = Bun.spawn([built!.peer, sock], { stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("ready");
    const lib = openFdLib(built!.so);
    const fd = unixConnect(lib, sock);
    expect(fd).toBeGreaterThan(2);
    const transport = new UnixFdTransport(fd, lib);
    const conn = new RpcConnection(transport);
    const cap: Client = conn.bootstrap();
    let got: number | undefined;
    for (let i = 0; i < 20 && got === undefined; i++) {
      transport.pull();
      conn.pump();
      got = cap.getFd();
      if (got === undefined) await new Promise((r) => setTimeout(r, 10));
    }
    expect(got).toBeGreaterThan(2);
    const buf = Buffer.alloc(1);
    expect(readSync(got!, buf, 0, 1, null)).toBe(1);
    expect(String.fromCharCode(buf[0]!)).toBe("Q");
    cap.release();
    child.kill();
    lib.close();
  });
});
