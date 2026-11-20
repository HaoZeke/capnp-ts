import { Message as CapnpMessage, MessageBuilder, type Ptr, type StructBuilder } from "@haozeke/capnp";
import { describe, expect, test } from "bun:test";

import {
  Client,
  RpcConnection,
  type RpcServer,
} from "../src/index.ts";
import {
  Message,
  MESSAGE_DWORDS,
  MESSAGE_PWORDS,
  Message_which,
  Call_getQuestionId,
  Message_getUnimplemented,
  Message_getCall,
} from "../src/rpc.capnp.ts";
import { MemoryTransportPair } from "../src/transport.ts";
import { IFACE, link } from "./support.ts";

class Counter implements RpcServer {
  dispatch(_i: bigint, _m: number, params: Ptr, results: StructBuilder): void {
    results.setU32(0, params.getU32(0) + 1);
  }
}

describe("a peer that does not implement a message", () => {
  test("an Unimplemented echo of a Call fails that question", () => {
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a);
    const q = a.sendCall(0, IFACE, 0);
    const sent = CapnpMessage.fromFlat(pair.b.receive()!).root();
    expect(Call_getQuestionId(Message_getCall(sent))).toBe(q);

    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(0, Message.unimplemented);
    root.setP(0, sent);
    pair.b.send(b.toFlat());
    a.pump();
    expect(a.isFailed(q)).toBe(true);
    expect(Message_which(Message_getUnimplemented(CapnpMessage.fromFlat(b.toFlat()).root()))).toBe(
      Message.call,
    );
  });
});

describe("level 4: Join", () => {
  const joinResult = (a: RpcConnection, q: number) => {
    const content = a.answerContent(q)!;
    return { joinId: content.getU32(0), succeeded: content.getBool(32) };
  };

  test("two parts naming the same object join", async () => {
    const { a, settle } = link(undefined, new Counter());
    a.bootstrap();
    await settle();
    const q0 = a.sendJoin(0, 7, 2, 0);
    const q1 = a.sendJoin(0, 7, 2, 1);
    await settle();
    expect(joinResult(a, q0)).toEqual({ joinId: 7, succeeded: true });
    expect(joinResult(a, q1)).toEqual({ joinId: 7, succeeded: true });
    // JoinResult is a struct; the joined capability sits in its pointer 0.
    const joined = a.answerCapId(q0, 0);
    expect(joined).toBe(0);
    expect(a.answerCapId(q1, 0)).toBe(-1);
  });

  test("parts naming different objects do not join", async () => {
    const hub: RpcServer = {
      dispatch(_i, _m, _p, _r, ctx) {
        ctx.setResultCap(ctx.initResults(0, 1), 0, Client.local(new Counter()).hook);
      },
    };
    const { a, settle } = link(undefined, hub);
    const boot = a.bootstrap();
    const reply = boot.call(IFACE, 0);
    await settle();
    const results = await reply;
    const counter = new Client(results.getCap(results.content.getP(0)));
    void counter;
    const qa = a.sendJoin(0, 9, 2, 0);
    // Export 1 is the Counter the call returned; export 0 is the hub.
    const qb = a.sendJoin(1, 9, 2, 1);
    await settle();
    expect(joinResult(a, qa).succeeded).toBe(false);
    expect(joinResult(a, qb).succeeded).toBe(false);
  });
});
