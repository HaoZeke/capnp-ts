import { Message as CapnpMessage, MessageBuilder, type Ptr, type StructBuilder } from "@haozeke/capnp";
import { describe, expect, test } from "bun:test";

import {
  PERSISTENT_INTERFACE_ID,
  RpcConnection,
  type RpcServer,
  savePersistent,
  servePersistent,
} from "../src/index.ts";
import { Message, MESSAGE_DWORDS, MESSAGE_PWORDS, Message_which } from "../src/rpc.capnp.ts";
import { MemoryTransportPair } from "../src/transport.ts";
import { IFACE, link } from "./support.ts";

class Counter implements RpcServer {
  dispatch(_i: bigint, _m: number, params: Ptr, results: StructBuilder): void {
    results.setU32(0, params.getU32(0) + 1);
  }
}

describe("level 2: Persistent", () => {
  test("save reaches a server that implements it, with the owner and the SturdyRef", async () => {
    let sealedFor = "";
    const keep = servePersistent(new Counter(), (params, results) => {
      sealedFor = params.getText(0);
      results.setText(0, "ref-1");
    });
    const { a, settle } = link(undefined, keep);
    const boot = a.bootstrap();
    const saved = savePersistent(boot, (params) => params.setText(0, "alice"));
    await settle();
    expect((await saved).content.getText(0)).toBe("ref-1");
    expect(sealedFor).toBe("alice");
  });

  test("the rest of the interface is delegated", async () => {
    const keep = servePersistent(new Counter(), () => {});
    const { a, settle } = link(undefined, keep);
    const out = a.bootstrap().call(IFACE, 0, (p) => p.setU32(0, 4));
    await settle();
    expect((await out).content.getU32(0)).toBe(5);
    expect(PERSISTENT_INTERFACE_ID).toBe(0xc8cb212fcd9f5691n);
  });

  test("the obsolete restore messages are answered Unimplemented", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new Counter());
    for (const tag of [Message.obsoleteSave, Message.obsoleteDelete]) {
      const b = new MessageBuilder();
      const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
      root.setU16(0, tag);
      root.initStruct(0, 0, 0);
      pair.a.send(b.toFlat());
      vat.pump();
      const reply = CapnpMessage.fromFlat(pair.a.receive()!).root();
      expect(Message_which(reply)).toBe(Message.unimplemented);
    }
  });
});
