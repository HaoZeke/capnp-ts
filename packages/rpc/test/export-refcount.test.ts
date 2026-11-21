/**
 * Named Bootstrap must not leak a reference on the exported capability.
 * `ExportMap` keeps the copy from `export`, and the vat addRefs for the
 * answer. Finish drops that answer ref.
 */
import { describe, expect, test } from "bun:test";
import { MessageBuilder, type StructBuilder } from "@haozeke/capnp";

import { Client, LocalClient } from "../src/capability.ts";
import { ExportMap } from "../src/restorer.ts";
import { Message } from "../src/rpc.capnp.ts";
import { MemoryTransportPair } from "../src/transport.ts";
import { RpcConnection } from "../src/vat.ts";

function frame(tag: number, fill?: (m: StructBuilder) => void): Uint8Array {
  const b = new MessageBuilder();
  const root = b.initRoot(1, 1);
  root.setU16(0, tag);
  fill?.(root);
  return b.toFlat();
}

function named(q: number, name: string): Uint8Array {
  return frame(Message.bootstrap, (m) => {
    const bs = m.initStruct(0, 1, 1);
    bs.setU32(0, q);
    bs.setText(0, name);
  });
}

function finish(q: number): Uint8Array {
  return frame(Message.finish, (m) => {
    const fin = m.initStruct(0, 1, 0);
    fin.setU32(0, q >>> 0);
    fin.setBool(32, true, true);
  });
}

describe("named Bootstrap refcount", () => {
  test("repeated Bootstrap and Finish leave the stored refcount unchanged", () => {
    const cap = new Client(new LocalClient({ dispatch() {} }));
    const refs = (): number => (cap.hook as unknown as { refs: number }).refs;
    const exports = new ExportMap();
    exports.exportCap("echo", cap);
    cap.release();
    const start = refs();
    expect(start).toBe(1);
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, undefined, undefined, { restorer: exports.restore });
    for (let q = 0; q < 4; q++) {
      pair.b.send(named(q, "echo"));
      vat.pump();
      pair.b.send(finish(q));
      vat.pump();
      while (pair.b.receive() !== null) {
        // drain the Return
      }
      expect(vat.disconnected).toBeUndefined();
    }
    expect(refs()).toBe(start);
  });
});
