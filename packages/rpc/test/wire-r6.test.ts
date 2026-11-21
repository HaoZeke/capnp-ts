/**
 * Wire cases checked against capnp-C++ 1.4.0: non-struct params, the
 * same-burst pipeline, exception text, and attached descriptors.
 */
import { describe, expect, test } from "bun:test";
import { Message as CapnpMessage, MessageBuilder, Ptr, type StructBuilder } from "@haozeke/capnp";

import { Client, type RpcServer } from "../src/index.ts";
import {
  CapDescriptor_getAttachedFd,
  Exception_getReason,
  Message,
  Payload_getCapTable,
  Return,
  Return_getException,
  Return_getResults,
  Return_which,
} from "../src/rpc.capnp.ts";
import { MemoryTransportPair } from "../src/transport.ts";
import { RpcConnection } from "../src/vat.ts";

const IFACE = 0x1234n;

function frame(tag: number, fill?: (m: StructBuilder) => void): Uint8Array {
  const b = new MessageBuilder();
  const root = b.initRoot(1, 1);
  root.setU16(0, tag);
  fill?.(root);
  return b.toFlat();
}

function bootstrap(q: number): Uint8Array {
  return frame(Message.bootstrap, (m) => m.initStruct(0, 1, 1).setU32(0, q));
}

function toAnswer(t: StructBuilder, q: number, ops: number[] = []): void {
  t.setU16(4, 1);
  const pa = t.initStruct(0, 1, 1);
  pa.setU32(0, q);
  if (ops.length === 0) return;
  let op = pa.initCompositeList(0, ops.length, 1, 0);
  ops.forEach((f, i) => {
    if (i > 0) op = op.nextElement();
    op.setU16(0, 1);
    op.setU16(2, f);
  });
}

function callOn(q: number, question: number, ops: number[], method = 0): Uint8Array {
  return frame(Message.call, (m) => {
    const c = m.initStruct(0, 3, 3);
    c.setU32(0, q);
    c.setU16(4, method);
    c.setU64(8, IFACE);
    toAnswer(c.initStruct(0, 1, 1), question, ops);
    c.initStruct(1, 0, 1).initStruct(0, 0, 0);
  });
}

const counter: RpcServer = {
  dispatch(_i, method, _params, _results, ctx) {
    if (method === 1) {
      ctx.setResultCap(ctx.initResults(0, 1), 0, Client.local({ dispatch() {} }).hook);
    }
  },
};

describe("call params match capnp-C++ 1.4.0", () => {
  test("a list pointer in Call.params aborts", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, counter);
    pair.b.send(bootstrap(0));
    vat.pump();
    const b = new MessageBuilder();
    const root = b.initRoot(1, 1);
    root.setU16(0, Message.call);
    const c = root.initStruct(0, 3, 3);
    c.setU32(0, 1);
    c.setU64(8, IFACE);
    toAnswer(c.initStruct(0, 1, 1), 0);
    c.initList(1, 1, 0, 0);
    pair.b.send(b.toFlat());
    vat.pump();
    expect(vat.disconnected).toBeDefined();
    expect(vat.disconnected?.message).toContain("non-struct pointer");
  });

  test("a list in Call.params.content is the call's exception", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, {
      dispatch(_i, _m, params, results) {
        results.setU32(0, params.getU32(0) + 1);
      },
    });
    pair.b.send(bootstrap(0));
    vat.pump();
    pair.b.receive();
    const b = new MessageBuilder();
    const root = b.initRoot(1, 1);
    root.setU16(0, Message.call);
    const c = root.initStruct(0, 3, 3);
    c.setU32(0, 2);
    c.setU64(8, IFACE);
    toAnswer(c.initStruct(0, 1, 1), 0);
    c.initStruct(1, 0, 1).initList(0, 1, 0, 0);
    pair.b.send(b.toFlat());
    vat.pump();
    expect(vat.disconnected).toBeUndefined();
    const ret = CapnpMessage.fromFlat(pair.b.receive()!).root().getP(0);
    expect(Return_which(ret)).toBe(Return.exception);
    expect(Exception_getReason(Return_getException(ret))).toContain("non-struct pointer");
  });

  test("a method that ignores params does not read a bad content pointer", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, {
      dispatch(_i, _m, _params, results) {
        results.setU32(0, 7);
      },
    });
    pair.b.send(bootstrap(0));
    vat.pump();
    const b = new MessageBuilder();
    const root = b.initRoot(1, 1);
    root.setU16(0, Message.call);
    const c = root.initStruct(0, 3, 3);
    c.setU32(0, 3);
    c.setU64(8, IFACE);
    toAnswer(c.initStruct(0, 1, 1), 0);
    c.initStruct(1, 0, 1).initList(0, 1, 0, 0);
    pair.b.send(b.toFlat());
    vat.pump();
    expect(vat.disconnected).toBeUndefined();
    const ret = CapnpMessage.fromFlat(pair.b.receive()!).root().getP(0);
    expect(Return_which(ret)).toBe(Return.results);
  });

  test("a non-list cap table aborts", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, counter);
    pair.b.send(bootstrap(0));
    vat.pump();
    const b = new MessageBuilder();
    const root = b.initRoot(1, 1);
    root.setU16(0, Message.call);
    const c = root.initStruct(0, 3, 3);
    c.setU32(0, 4);
    c.setU64(8, IFACE);
    toAnswer(c.initStruct(0, 1, 1), 0);
    const payload = c.initStruct(1, 0, 2);
    payload.initStruct(0, 0, 0);
    payload.initStruct(1, 1, 0);
    pair.b.send(b.toFlat());
    vat.pump();
    expect(vat.disconnected?.message).toContain("non-list pointer");
  });

  test("a non-struct promised answer aborts", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, counter);
    pair.b.send(bootstrap(0));
    vat.pump();
    const b = new MessageBuilder();
    const root = b.initRoot(1, 1);
    root.setU16(0, Message.call);
    const c = root.initStruct(0, 3, 3);
    c.setU32(0, 5);
    c.setU64(8, IFACE);
    const target = c.initStruct(0, 1, 1);
    target.setU16(4, 1);
    target.initList(0, 1, 0, 0);
    c.initStruct(1, 0, 1).initStruct(0, 0, 0);
    pair.b.send(b.toFlat());
    vat.pump();
    expect(vat.disconnected?.message).toContain("non-struct pointer");
  });

  test("params handed to dispatch are a Ptr", () => {
    let isPtr = false;
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, {
      dispatch(_i, _m, params) {
        isPtr = params instanceof Ptr;
      },
    });
    pair.b.send(bootstrap(0));
    vat.pump();
    pair.b.send(callOn(1, 0, []));
    vat.pump();
    expect(isPtr).toBe(true);
    expect(vat.disconnected).toBeUndefined();
  });
});

describe("post-return pipeline in one pump", () => {
  test("a bad path after a synchronous return aborts", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, counter);
    pair.b.send(bootstrap(0));
    pair.b.send(callOn(1, 0, [], 1));
    pair.b.send(callOn(2, 1, [0, 0]));
    vat.pump();
    expect(vat.disconnected).toBeDefined();
    expect(vat.disconnected?.message).toContain("non-struct pointer");
  });

  test("an empty path after a synchronous return aborts", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, counter);
    pair.b.send(bootstrap(0));
    pair.b.send(callOn(1, 0, [], 1));
    pair.b.send(callOn(2, 1, []));
    vat.pump();
    expect(vat.disconnected?.message).toContain("non-capability pointer");
  });

  test("a promise that is already ready still aborts before the next frame", async () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, {
      dispatch(_i, method, _p, _r, ctx) {
        if (method !== 1) return;
        ctx.setResultCap(ctx.initResults(0, 1), 0, Client.local({ dispatch() {} }).hook);
        return Promise.resolve();
      },
    });
    pair.b.send(bootstrap(0));
    pair.b.send(callOn(1, 0, [], 1));
    pair.b.send(callOn(2, 1, [0, 0]));
    vat.pumpTurns();
    await new Promise((r) => setTimeout(r, 20));
    expect(vat.disconnected?.message).toContain("non-struct pointer");
  });
});

describe("exception trace is text", () => {
  test("a struct trace is a non-list text error, after the reason", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, counter);
    const b = new MessageBuilder();
    const root = b.initRoot(1, 1);
    root.setU16(0, Message.abort);
    const exc = root.initStruct(0, 1, 2);
    exc.setText(0, "because");
    exc.initStruct(1, 1, 0);
    pair.b.send(b.toFlat());
    vat.pump();
    const out = pair.b.receive();
    expect(out).not.toBeNull();
    const body = CapnpMessage.fromFlat(out!).root().getP(0);
    expect(Exception_getReason(body)).toContain("non-list pointer where text was expected");
    expect(Exception_getReason(body).includes("because")).toBe(false);
  });
});

describe("unimplemented level 3 and 4 echoes abort", () => {
  for (const which of [Message.provide, Message.accept, Message.join]) {
    test(`echo of which ${which} aborts`, () => {
      const pair = new MemoryTransportPair();
      const vat = new RpcConnection(pair.a, counter);
      const b = new MessageBuilder();
      const root = b.initRoot(1, 1);
      root.setU16(0, Message.unimplemented);
      root.initStruct(0, 1, 1).setU16(0, which);
      pair.b.send(b.toFlat());
      vat.pump();
      expect(vat.disconnected?.message).toContain(`message.which() = ${which}`);
    });
  }
});

describe("attachedFd on a capability descriptor", () => {
  test("the receiver's import reports the sender's fd index", () => {
    const server: RpcServer = {
      getFd: () => 7,
      dispatch() {},
    };
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a, server);
    const b = new RpcConnection(pair.b);
    const cap = b.bootstrap();
    for (let i = 0; i < 4; i++) {
      a.pump();
      b.pump();
    }
    expect(cap.getFd()).toBe(7);
    const sent = pair.b.receive();
    expect(sent).toBeNull();
  });

  test("the Return cap table stores attachedFd as the fd list index", () => {
    const server: RpcServer = {
      getFd: () => 7,
      dispatch() {},
    };
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a, server);
    new RpcConnection(pair.b).bootstrap();
    a.pump();
    const frame = pair.b.receive();
    expect(frame).not.toBeNull();
    expect(pair.b.receivedFds?.()).toEqual([7]);
    const ret = CapnpMessage.fromFlat(frame!).root().getP(0);
    expect(Return_which(ret)).toBe(Return.results);
    const table = Payload_getCapTable(Return_getResults(ret));
    expect(CapDescriptor_getAttachedFd(table.listGetP(0))).toBe(0);
  });
});
