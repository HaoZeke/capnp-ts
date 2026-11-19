/**
 * Protocol errors where capnp-C++ disconnects, and refcount cases the
 * suite was missing.
 */
import { describe, expect, test } from "bun:test";
import { Message as CapnpMessage, MessageBuilder, type Ptr, type StructBuilder } from "@haozeke/capnp";

import {
  CallBuilder,
  type CallContext,
  Client,
  RpcError,
  type RpcServer,
} from "../src/index.ts";
import {
  BOOTSTRAP_DWORDS,
  BOOTSTRAP_PWORDS,
  CALL_DWORDS,
  CALL_PWORDS,
  DISEMBARGO_DWORDS,
  DISEMBARGO_PWORDS,
  EXCEPTION_DWORDS,
  EXCEPTION_PWORDS,
  Exception_getType,
  Exception_Type,
  FINISH_DWORDS,
  FINISH_PWORDS,
  MESSAGE_DWORDS,
  MESSAGE_PWORDS,
  MESSAGE_TARGET_DWORDS,
  MESSAGE_TARGET_PWORDS,
  Message,
  Message_getAbort,
  Message_which,
  MessageTarget,
  PAYLOAD_DWORDS,
  PAYLOAD_PWORDS,
  RESOLVE_DWORDS,
  RESOLVE_PWORDS,
  Resolve,
  RETURN_DWORDS,
  RETURN_PWORDS,
  Return,
} from "../src/rpc.capnp.ts";
import { MemoryTransportPair, type Transport } from "../src/transport.ts";
import { RpcConnection } from "../src/vat.ts";
import { IFACE, link } from "./support.ts";

class Counter implements RpcServer {
  seen: number[] = [];
  disposed = 0;
  dispatch(_i: bigint, _m: number, params: Ptr, results: StructBuilder): void {
    const n = params.getU32(0);
    this.seen.push(n);
    results.setU32(0, n + 1);
  }
  dispose(): void {
    this.disposed++;
  }
}

const arg = (n: number) => (p: StructBuilder) => p.setU32(0, n);

function frame(fill: (root: StructBuilder) => void): Uint8Array {
  const b = new MessageBuilder();
  fill(b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS));
  return b.toFlat();
}

function sendReturn(t: Transport, answerId: number, which: number, takeFrom?: number): void {
  t.send(
    frame((root) => {
      root.setU16(0, Message.return);
      const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
      ret.setU32(0, answerId);
      ret.setU16(6, which);
      ret.setBool(32, false, true);
      if (which === Return.takeFromOtherQuestion && takeFrom !== undefined) ret.setU32(8, takeFrom);
      if (which === Return.results) ret.initStruct(0, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
    }),
  );
}

function expectAbort(t: Transport, vat: RpcConnection, message: string): void {
  expect(vat.disconnected?.message).toContain(message);
  const reply = CapnpMessage.fromFlat(t.receive()!).root();
  expect(Message_which(reply)).toBe(Message.abort);
  expect(Exception_getType(Message_getAbort(reply))).toBe(Exception_Type.failed);
}

describe("return protocol errors", () => {
  test("Return.canceled for a question the caller still holds aborts", async () => {
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a);
    const call = a.sendCallTo(
      (t) => {
        t.setU16(4, MessageTarget.importedCap);
        t.setU32(0, 0);
      },
      IFACE,
      0,
      new CallBuilder(0, 0).toPayload(),
    );
    pair.b.receive();
    sendReturn(pair.b, 0, Return.canceled);
    a.pump();
    expectAbort(pair.b, a, "falsely claims call was canceled");
    await expect(call.result.promise).rejects.toMatchObject({ type: "disconnected" });
  });

  test("Return.canceled after Finish does not abort", () => {
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a);
    const call = a.sendCallTo(
      (t) => {
        t.setU16(4, MessageTarget.importedCap);
        t.setU32(0, 0);
      },
      IFACE,
      0,
      new CallBuilder(0, 0).toPayload(),
    );
    pair.b.receive();
    call.release();
    const finish = pair.b.receive();
    expect(finish).not.toBeNull();
    sendReturn(pair.b, 0, Return.canceled);
    a.pump();
    expect(a.disconnected).toBeUndefined();
  });

  test("takeFromOtherQuestion with a bad answer id aborts", async () => {
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a);
    const call = a.sendCallTo(
      (t) => {
        t.setU16(4, MessageTarget.importedCap);
        t.setU32(0, 0);
      },
      IFACE,
      0,
      new CallBuilder(0, 0).toPayload(),
    );
    pair.b.receive();
    sendReturn(pair.b, 0, Return.takeFromOtherQuestion, 99);
    a.pump();
    expectAbort(pair.b, a, "invalid answer ID");
    await expect(call.result.promise).rejects.toMatchObject({ type: "disconnected" });
  });

  test("a second Return for the same question aborts", () => {
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a);
    a.sendCallTo(
      (t) => {
        t.setU16(4, MessageTarget.importedCap);
        t.setU32(0, 0);
      },
      IFACE,
      0,
      new CallBuilder(0, 0).toPayload(),
    );
    pair.b.receive();
    sendReturn(pair.b, 0, Return.results);
    a.pump();
    expect(a.disconnected).toBeUndefined();
    sendReturn(pair.b, 0, Return.results);
    a.pump();
    expectAbort(pair.b, a, "Duplicate Return");
  });

  test("an unknown Return variant aborts", async () => {
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a);
    const call = a.sendCallTo(
      (t) => {
        t.setU16(4, MessageTarget.importedCap);
        t.setU32(0, 0);
      },
      IFACE,
      0,
      new CallBuilder(0, 0).toPayload(),
    );
    pair.b.receive();
    sendReturn(pair.b, 0, 9);
    a.pump();
    expectAbort(pair.b, a, "Unknown 'Return' type");
    await expect(call.result.promise).rejects.toMatchObject({ type: "disconnected" });
  });

  test("a Return for a high question id is ignored", () => {
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a);
    sendReturn(pair.b, 0x80000000, Return.results);
    a.pump();
    expect(a.disconnected).toBeUndefined();
  });
});

describe("other incoming protocol errors", () => {
  test("an unknown Disembargo context aborts", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new Counter());
    pair.a.send(
      frame((root) => {
        root.setU16(0, Message.disembargo);
        const dis = root.initStruct(0, DISEMBARGO_DWORDS, DISEMBARGO_PWORDS);
        dis.setU16(4, 9);
      }),
    );
    vat.pump();
    expectAbort(pair.a, vat, "Unimplemented Disembargo type");
  });

  test("an unsupported pipeline op aborts", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new Counter());
    pair.a.send(
      frame((root) => {
        root.setU16(0, Message.bootstrap);
        root.initStruct(0, BOOTSTRAP_DWORDS, BOOTSTRAP_PWORDS).setU32(0, 4);
      }),
    );
    vat.pump();
    pair.a.receive();
    pair.a.send(
      frame((root) => {
        root.setU16(0, Message.call);
        const call = root.initStruct(0, CALL_DWORDS, CALL_PWORDS);
        call.setU32(0, 5);
        const target = call.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
        target.setU16(4, MessageTarget.promisedAnswer);
        const promised = target.initStruct(0, 1, 1);
        promised.setU32(0, 4);
        const op = promised.initCompositeList(0, 1, 1, 0);
        op.setU16(0, 7);
        call.initStruct(1, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
      }),
    );
    vat.pump();
    expectAbort(pair.a, vat, "Unsupported pipeline op");
  });

  test("an unknown capability descriptor aborts", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new Counter());
    pair.a.send(
      frame((root) => {
        root.setU16(0, Message.call);
        const call = root.initStruct(0, CALL_DWORDS, CALL_PWORDS);
        call.setU32(0, 1);
        const target = call.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
        target.setU16(4, MessageTarget.importedCap);
        target.setU32(0, 0);
        const params = call.initStruct(1, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
        const table = params.initCompositeList(1, 1, 1, 1);
        table.setU16(0, 9);
      }),
    );
    vat.pump();
    expect(vat.disconnected?.message).toContain("unknown CapDescriptor type");
    expect(Message_which(CapnpMessage.fromFlat(pair.a.receive()!).root())).toBe(Message.abort);
  });

  test("Resolve for an import that was never a promise aborts", async () => {
    const { a, tb, settle } = link(undefined, new Counter());
    const boot = a.bootstrap();
    await settle();
    expect(a.liveImports()).toEqual([0]);
    tb.send(
      frame((root) => {
        root.setU16(0, Message.resolve);
        const resolve = root.initStruct(0, RESOLVE_DWORDS, RESOLVE_PWORDS);
        resolve.setU32(0, 0);
        resolve.setU16(4, Resolve.exception);
        const exc = resolve.initStruct(0, EXCEPTION_DWORDS, EXCEPTION_PWORDS);
        exc.setU16(4, Exception_Type.failed);
        exc.setText(0, "again");
      }),
    );
    a.pump();
    expect(a.disconnected?.message).toContain("non-promise import");
    boot.release();
  });

  test("a second Resolve of a fulfilled promise does not abort", async () => {
    let resolveP!: (c: Client) => void;
    const server: RpcServer = {
      dispatch(_i, _m, _p, _r, ctx: CallContext) {
        const p = Client.fromPromise(new Promise<Client>((r) => (resolveP = r)));
        ctx.setResultCap(ctx.initResults(0, 1), 0, p.hook);
      },
    };
    const { a, tb, settle } = link(undefined, server);
    const reply = a.bootstrap().call(IFACE, 0);
    await settle();
    resolveP(Client.local(new Counter()));
    await settle();
    const promiseId = tb.frames.reduce((id, raw) => {
      const root = CapnpMessage.fromFlat(raw).root();
      return Message_which(root) === Message.resolve ? root.getP(0).getU32(0) : id;
    }, -1);
    expect(promiseId).toBeGreaterThanOrEqual(0);
    tb.send(
      frame((root) => {
        root.setU16(0, Message.resolve);
        const resolve = root.initStruct(0, RESOLVE_DWORDS, RESOLVE_PWORDS);
        resolve.setU32(0, promiseId);
        resolve.setU16(4, Resolve.exception);
        const exc = resolve.initStruct(0, EXCEPTION_DWORDS, EXCEPTION_PWORDS);
        exc.setU16(4, Exception_Type.failed);
        exc.setText(0, "again");
      }),
    );
    a.pump();
    expect(a.disconnected).toBeUndefined();
    reply.release();
  });
});
