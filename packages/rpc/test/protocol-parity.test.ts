/**
 * Protocol errors where capnp-C++ disconnects, and refcount cases the
 * suite was missing.
 */
import { describe, expect, test } from "bun:test";
import {
  Message as CapnpMessage,
  MessageBuilder,
  Orphan,
  type Ptr,
  type StructBuilder,
} from "@haozeke/capnp";

import {
  CallBuilder,
  type CallContext,
  Client,
  type ClientHook,
  QueuedClient,
  RpcError,
  type RpcServer,
  Settle,
} from "../src/index.ts";
import {
  BOOTSTRAP_DWORDS,
  BOOTSTRAP_PWORDS,
  CALL_DWORDS,
  CALL_PWORDS,
  CAP_DESCRIPTOR_DWORDS,
  CAP_DESCRIPTOR_PWORDS,
  Call_sendResultsTo,
  CapDescriptor,
  DISEMBARGO_DWORDS,
  DISEMBARGO_PWORDS,
  Disembargo_context,
  Disembargo_context_which,
  Disembargo_getContext,
  EXCEPTION_DWORDS,
  EXCEPTION_PWORDS,
  Exception_getReason,
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
  Message_getDisembargo,
  Message_getReturn,
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
  Return_getAnswerId,
  Return_which,
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
  test("a named Bootstrap returns the C++ compatibility exception", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new Counter());
    pair.a.send(
      frame((root) => {
        root.setU16(0, Message.bootstrap);
        const bootstrap = root.initStruct(0, BOOTSTRAP_DWORDS, BOOTSTRAP_PWORDS);
        bootstrap.setU32(0, 0);
        bootstrap.setText(0, "named-export");
      }),
    );
    vat.pump();

    const reply = CapnpMessage.fromFlat(pair.a.receive()!).root();
    expect(Message_which(reply)).toBe(Message.return);
    expect(Return_which(reply.getP(0))).toBe(Return.exception);
    expect(reply.getP(0).getP(0).getText(0)).toContain("only supports a bootstrap interface");
    expect(vat.disconnected).toBeUndefined();
  });

  test("a received Abort is echoed with its type and single remote prefix", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new Counter());
    pair.a.send(
      frame((root) => {
        root.setU16(0, Message.abort);
        const exc = root.initStruct(0, EXCEPTION_DWORDS, EXCEPTION_PWORDS);
        exc.setU16(4, Exception_Type.overloaded);
        exc.setText(0, "bye");
      }),
    );
    vat.pump();
    const echoed = Message_getAbort(CapnpMessage.fromFlat(pair.a.receive()!).root());
    expect(Exception_getType(echoed)).toBe(Exception_Type.overloaded);
    expect(Exception_getReason(echoed)).toBe("remote exception: bye");
    expect(vat.disconnected?.message).toBe("remote exception: bye");

    const pair2 = new MemoryTransportPair();
    const vat2 = new RpcConnection(pair2.b, new Counter());
    pair2.a.send(
      frame((root) => {
        root.setU16(0, Message.abort);
        root
          .initStruct(0, EXCEPTION_DWORDS, EXCEPTION_PWORDS)
          .setText(0, "remote exception: already prefixed");
      }),
    );
    vat2.pump();
    const echoed2 = Message_getAbort(CapnpMessage.fromFlat(pair2.a.receive()!).root());
    expect(Exception_getReason(echoed2)).toBe("remote exception: already prefixed");
  });

  test("a null Call.params pointer is an empty Payload", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, {
      dispatch(_i, _m, _params, results) {
        results.setU32(0, 42);
      },
    });
    pair.a.send(
      frame((root) => {
        root.setU16(0, Message.bootstrap);
        root.initStruct(0, BOOTSTRAP_DWORDS, BOOTSTRAP_PWORDS).setU32(0, 0);
      }),
    );
    pair.a.send(
      frame((root) => {
        root.setU16(0, Message.call);
        const call = root.initStruct(0, CALL_DWORDS, CALL_PWORDS);
        call.setU32(0, 1);
        const target = call.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
        target.setU16(4, MessageTarget.promisedAnswer);
        target.initStruct(0, 1, 1).setU32(0, 0);
      }),
    );
    vat.pump();

    const bootstrap = CapnpMessage.fromFlat(pair.a.receive()!).root();
    const call = CapnpMessage.fromFlat(pair.a.receive()!).root();
    expect(Message_which(bootstrap)).toBe(Message.return);
    expect(Message_which(call)).toBe(Message.return);
    expect(Return_which(call.getP(0))).toBe(Return.results);
    expect(vat.disconnected).toBeUndefined();
  });

  test("an invalid importedCap target aborts the connection", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new Counter());
    pair.a.send(
      frame((root) => {
        root.setU16(0, Message.call);
        const call = root.initStruct(0, CALL_DWORDS, CALL_PWORDS);
        call.setU32(0, 0);
        const target = call.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
        target.setU16(4, MessageTarget.importedCap);
        target.setU32(0, 999);
      }),
    );
    vat.pump();
    expectAbort(pair.a, vat, "not a current export ID");
  });

  test("an unknown MessageTarget type aborts the connection", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new Counter());
    pair.a.send(
      frame((root) => {
        root.setU16(0, Message.call);
        const call = root.initStruct(0, CALL_DWORDS, CALL_PWORDS);
        call.setU32(0, 0);
        call.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS).setU16(4, 99);
      }),
    );
    vat.pump();
    expectAbort(pair.a, vat, "Unknown message target type");
  });

  test("Unimplemented of Finish or Abort aborts the connection", () => {
    for (const innerTag of [Message.finish, Message.abort, Message.unimplemented]) {
      const pair = new MemoryTransportPair();
      const vat = new RpcConnection(pair.b, new Counter());
      pair.a.send(
        frame((root) => {
          root.setU16(0, Message.unimplemented);
          root.initStruct(0, MESSAGE_DWORDS, MESSAGE_PWORDS).setU16(0, innerTag);
        }),
      );
      vat.pump();
      expectAbort(pair.a, vat, "required RPC message type");
    }
  });

  test("Resolve with receiverAnswer emits Disembargo.senderLoopback for reflected caps", () => {
    const pair = new MemoryTransportPair();
    const echoCapServer: RpcServer = {
      dispatch(_i, _m, params, _r, ctx) {
        const cap = ctx.getCap(params);
        const r = ctx.initResults(0, 1);
        ctx.setResultCap(r, 0, cap);
      },
    };
    const sut = new RpcConnection(pair.a, echoCapServer);
    const bootCap = sut.bootstrap();
    pair.b.receive(); // Bootstrap(q=0)

    const build = (fill: (root: StructBuilder, b: MessageBuilder) => void): Uint8Array => {
      const b = new MessageBuilder();
      fill(b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS), b);
      return b.toFlat();
    };
    pair.b.send(
      build((root, b) => {
        root.setU16(0, Message.return);
        const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
        ret.setU32(0, 0);
        ret.setU16(6, Return.results);
        const payload = ret.initStruct(0, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
        payload.adopt(0, Orphan.cap(b, 0));
        const cd = payload.initCompositeList(1, 1, CAP_DESCRIPTOR_DWORDS, CAP_DESCRIPTOR_PWORDS);
        cd.setU16(0, CapDescriptor.senderPromise);
        cd.setU32(4, 50);
      }),
    );
    pair.b.send(
      frame((root) => {
        root.setU16(0, Message.bootstrap);
        root.initStruct(0, BOOTSTRAP_DWORDS, BOOTSTRAP_PWORDS).setU32(0, 10);
      }),
    );
    pair.b.send(
      build((root, b) => {
        root.setU16(0, Message.call);
        const c = root.initStruct(0, CALL_DWORDS, CALL_PWORDS);
        c.setU32(0, 11);
        c.setU64(8, 1n);
        c.setU16(4, 0);
        const t = c.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
        t.setU16(4, MessageTarget.promisedAnswer);
        t.initStruct(0, 1, 1).setU32(0, 10);
        const p = c.initStruct(1, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
        p.adopt(0, Orphan.cap(b, 0));
        const cd = p.initCompositeList(1, 1, CAP_DESCRIPTOR_DWORDS, CAP_DESCRIPTOR_PWORDS);
        cd.setU16(0, CapDescriptor.senderHosted);
        cd.setU32(4, 77);
      }),
    );
    const req = bootCap.call(1n, 0);
    sut.pump();
    while (pair.b.receive() !== null) {}

    pair.b.send(
      frame((root) => {
        root.setU16(0, Message.resolve);
        const res = root.initStruct(0, RESOLVE_DWORDS, RESOLVE_PWORDS);
        res.setU32(0, 50);
        res.setU16(4, Resolve.cap);
        const cd = res.initStruct(0, CAP_DESCRIPTOR_DWORDS, CAP_DESCRIPTOR_PWORDS);
        cd.setU16(0, CapDescriptor.receiverAnswer);
        const pa = cd.initStruct(0, 1, 1);
        pa.setU32(0, 11);
        const op = pa.initCompositeList(0, 1, 1, 0);
        op.setU16(0, 1);
        op.setU16(2, 0);
      }),
    );
    sut.pump();
    const sent: number[] = [];
    let sawSenderLoopback = false;
    let f: Uint8Array | null;
    while ((f = pair.b.receive()) !== null) {
      const root = CapnpMessage.fromFlat(f).root();
      const tag = Message_which(root);
      sent.push(tag);
      if (
        tag === Message.disembargo &&
        Disembargo_context_which(Disembargo_getContext(Message_getDisembargo(root))) ===
          Disembargo_context.senderLoopback
      ) {
        sawSenderLoopback = true;
      }
    }
    expect(sawSenderLoopback).toBe(true);
    expect(sent).toEqual([Message.disembargo, Message.release]);
    req.release();
    bootCap.release();
  });

  test("async sendResultsTo.yourself sends resultsSentElsewhere once on takeFromOtherQuestion", async () => {
    let finishServer!: () => void;
    const asyncServer: RpcServer = {
      dispatch(_i, _m, _p, results) {
        return new Promise<void>((res) => {
          finishServer = () => {
            results.setU32(0, 99);
            res();
          };
        });
      },
    };
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a, asyncServer);
    const peer = pair.b;
    peer.send(
      frame((root) => {
        root.setU16(0, Message.bootstrap);
        root.initStruct(0, BOOTSTRAP_DWORDS, BOOTSTRAP_PWORDS).setU32(0, 1);
      }),
    );
    a.pump();
    peer.receive();

    peer.send(
      frame((root) => {
        root.setU16(0, Message.call);
        const call = root.initStruct(0, CALL_DWORDS, CALL_PWORDS);
        call.setU32(0, 2);
        call.setU16(6, Call_sendResultsTo.yourself);
        const target = call.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
        target.setU16(4, MessageTarget.importedCap);
        target.setU32(0, 0);
        call.initStruct(1, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
      }),
    );
    const mine = a.sendBootstrap();
    peer.receive();
    a.pump();
    expect(peer.receive()).toBeNull();

    // Claim before asyncServer resolves: Return.resultsSentElsewhere goes out immediately.
    peer.send(
      frame((root) => {
        root.setU16(0, Message.return);
        const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
        ret.setU32(0, mine);
        ret.setU16(6, Return.takeFromOtherQuestion);
        ret.setU32(8, 2);
      }),
    );
    a.pump();
    const firstRet = Message_getReturn(CapnpMessage.fromFlat(peer.receive()!).root());
    expect(Return_getAnswerId(firstRet)).toBe(2);
    expect(Return_which(firstRet)).toBe(Return.resultsSentElsewhere);
    expect(peer.receive()).toBeNull();

    // Peer sends Finish for answer 2 while asyncServer is still running; it must not cancel.
    peer.send(
      frame((root) => {
        root.setU16(0, Message.finish);
        const fin = root.initStruct(0, FINISH_DWORDS, FINISH_PWORDS);
        fin.setU32(0, 2);
        fin.setBool(32, false, true);
        fin.setBool(33, false, true);
      }),
    );
    a.pump();

    finishServer();
    await Promise.resolve();
    await Promise.resolve();
    expect(peer.receive()).toBeNull();
    expect(a.isAnswered(mine)).toBe(true);
    expect(a.isFailed(mine)).toBe(false);
    expect(a.answerContent(mine)?.getU32(0)).toBe(99);
    expect(a.disconnected).toBeUndefined();
  });

  test("canceled question receiving takeFromOtherQuestion cancels and returns resultsSentElsewhere", () => {
    let canceled = false;
    const asyncServer: RpcServer = {
      dispatch(_i, _m, _p, _r, ctx) {
        ctx.allowCancellation();
        return new Promise<void>((_res, rej) => {
          ctx.signal.addEventListener("abort", () => {
            canceled = true;
            rej(new RpcError("canceled"));
          });
        });
      },
    };
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a, asyncServer);
    const peer = pair.b;
    peer.send(
      frame((root) => {
        root.setU16(0, Message.bootstrap);
        root.initStruct(0, BOOTSTRAP_DWORDS, BOOTSTRAP_PWORDS).setU32(0, 1);
      }),
    );
    a.pump();
    peer.receive();
    peer.send(
      frame((root) => {
        root.setU16(0, Message.call);
        const call = root.initStruct(0, CALL_DWORDS, CALL_PWORDS);
        call.setU32(0, 2);
        call.setU16(6, Call_sendResultsTo.yourself);
        const target = call.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
        target.setU16(4, MessageTarget.importedCap);
        target.setU32(0, 0);
        call.initStruct(1, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
      }),
    );
    const mine = a.sendBootstrap();
    peer.receive();
    a.sendFinish(mine);
    peer.receive();
    a.pump();

    peer.send(
      frame((root) => {
        root.setU16(0, Message.return);
        const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
        ret.setU32(0, mine);
        ret.setU16(6, Return.takeFromOtherQuestion);
        ret.setU32(8, 2);
      }),
    );
    a.pump();
    expect(canceled).toBe(true);
    const ret = Message_getReturn(CapnpMessage.fromFlat(peer.receive()!).root());
    expect(Return_getAnswerId(ret)).toBe(2);
    expect(Return_which(ret)).toBe(Return.resultsSentElsewhere);
    expect(a.disconnected).toBeUndefined();
  });

  test("Finish.requireEarlyCancellationWorkaround defers pending cancellation while dropping pipelining", async () => {
    const run = async (workaround: boolean): Promise<{ calls: number; pipelineWhich: number }> => {
      let calls = 0;
      const srv: RpcServer = {
        dispatch() {
          calls++;
        },
      };
      const eventual = new Settle<ClientHook>();
      queueMicrotask(() => eventual.resolve(Client.local(srv).hook));
      const boot = new Client(new QueuedClient(eventual));
      const pair = new MemoryTransportPair();
      const vat = new RpcConnection(pair.a, boot);
      pair.b.send(
        frame((root) => {
          root.setU16(0, Message.bootstrap);
          root.initStruct(0, BOOTSTRAP_DWORDS, BOOTSTRAP_PWORDS).setU32(0, 0);
        }),
      );
      pair.b.send(
        frame((root) => {
          root.setU16(0, Message.call);
          const call = root.initStruct(0, CALL_DWORDS, CALL_PWORDS);
          call.setU32(0, 1);
          const target = call.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
          target.setU16(4, MessageTarget.promisedAnswer);
          target.initStruct(0, 1, 1).setU32(0, 0);
          call.initStruct(1, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
        }),
      );
      pair.b.send(
        frame((root) => {
          root.setU16(0, Message.finish);
          const fin = root.initStruct(0, FINISH_DWORDS, FINISH_PWORDS);
          fin.setU32(0, 1);
          fin.setBool(32, true, true);
          fin.setBool(33, workaround, true);
        }),
      );
      pair.b.send(
        frame((root) => {
          root.setU16(0, Message.call);
          const call = root.initStruct(0, CALL_DWORDS, CALL_PWORDS);
          call.setU32(0, 2);
          const target = call.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
          target.setU16(4, MessageTarget.promisedAnswer);
          target.initStruct(0, 1, 1).setU32(0, 1);
          call.initStruct(1, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
        }),
      );
      vat.pump();
      let pipelineWhich = -1;
      let f: Uint8Array | null;
      while ((f = pair.b.receive()) !== null) {
        const ret = Message_getReturn(CapnpMessage.fromFlat(f).root());
        if (Return_getAnswerId(ret) === 2) pipelineWhich = Return_which(ret);
      }
      await new Promise((res) => setImmediate(res));
      await new Promise((res) => setImmediate(res));
      boot.release();
      return { calls, pipelineWhich };
    };

    expect(await run(false)).toEqual({ calls: 0, pipelineWhich: Return.exception });
    expect(await run(true)).toEqual({ calls: 1, pipelineWhich: Return.exception });
  });

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

describe("refcount cases", () => {
  test("releasing the caller's bootstrap Client does not break the next Bootstrap", () => {
    const server = new Counter();
    const client = Client.local(server);
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, client);
    client.release();
    for (const id of [1, 2]) {
      pair.a.send(
        frame((root) => {
          root.setU16(0, Message.bootstrap);
          root.initStruct(0, BOOTSTRAP_DWORDS, BOOTSTRAP_PWORDS).setU32(0, id);
        }),
      );
      vat.pump();
      expect(vat.disconnected).toBeUndefined();
      expect(Message_which(CapnpMessage.fromFlat(pair.a.receive()!).root())).toBe(Message.return);
    }
    expect(server.disposed).toBe(0);
  });

  test("disconnect disposes the bootstrap server", () => {
    const server = new Counter();
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, server);
    vat.disconnect(new RpcError("bye", "disconnected"));
    expect(server.disposed).toBe(1);
  });

  test("disconnect disposes an exported server", () => {
    const server = new Counter();
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a);
    a.exportCap(server);
    expect(server.disposed).toBe(0);
    a.disconnect(new RpcError("bye", "disconnected"));
    expect(server.disposed).toBe(1);
  });

  test("Finish releaseResultCaps drops a returned capability", async () => {
    const made: Counter[] = [];
    const factory: RpcServer = {
      dispatch(_i, _m, _p, _r, ctx) {
        const counter = new Counter();
        made.push(counter);
        ctx.setResultCap(ctx.initResults(0, 1), 0, Client.local(counter).hook);
      },
    };
    const { a, b, ta, settle } = link(undefined, factory);
    const reply = a.bootstrap().call(IFACE, 0);
    await settle();
    await reply;
    expect(made[0]!.disposed).toBe(0);
    ta.send(
      frame((root) => {
        root.setU16(0, Message.finish);
        const fin = root.initStruct(0, FINISH_DWORDS, FINISH_PWORDS);
        fin.setU32(0, 1);
        fin.setBool(32, true, true);
      }),
    );
    b.pump();
    expect(b.disconnected).toBeUndefined();
    expect(made[0]!.disposed).toBe(1);
  });

  test("Return.releaseParamCaps releases caps sent in the call", () => {
    const param = new Counter();
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a);
    const params = new CallBuilder(0, 1);
    params.setCap(params.root, 0, Client.local(param).hook);
    a.sendCallTo(
      (t) => {
        t.setU16(4, MessageTarget.importedCap);
        t.setU32(0, 0);
      },
      IFACE,
      0,
      params.toPayload(),
    );
    pair.b.receive();
    expect(a.liveExports()).toEqual([0]);
    pair.b.send(
      frame((root) => {
        root.setU16(0, Message.return);
        const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
        ret.setU32(0, 0);
        ret.setU16(6, Return.results);
        ret.setBool(32, true, true);
        ret.initStruct(0, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
      }),
    );
    a.pump();
    expect(a.disconnected).toBeUndefined();
    expect(a.liveExports()).toEqual([]);
    expect(param.disposed).toBe(1);
  });

  test("an Unimplemented echo of a call aborts and releases its parameter caps", () => {
    const param = new Counter();
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a);
    const params = new CallBuilder(0, 1);
    params.setCap(params.root, 0, Client.local(param).hook);
    a.sendCallTo(
      (t) => {
        t.setU16(4, MessageTarget.importedCap);
        t.setU32(0, 0);
      },
      IFACE,
      0,
      params.toPayload(),
    );
    const sent = pair.b.receive();
    expect(sent).not.toBeNull();
    pair.b.send(
      frame((root) => {
        root.setU16(0, Message.unimplemented);
        root.setP(0, CapnpMessage.fromFlat(sent!).root());
      }),
    );
    a.pump();
    expect(a.disconnected?.message).toContain("required RPC message type");
    expect(Message_which(CapnpMessage.fromFlat(pair.b.receive()!).root())).toBe(Message.abort);
    expect(a.liveExports()).toEqual([]);
    expect(param.disposed).toBe(1);
  });

  test("a receiverHosted export that already points back over the connection embargoes", async () => {
    let echoed: Client | undefined;
    let resolveBack!: (c: Client) => void;
    const server: RpcServer = {
      dispatch(_i, _m, params, _r, ctx) {
        echoed = new Client(ctx.getCap(params.getP(0)));
        const p = Client.fromPromise(new Promise<Client>((r) => (resolveBack = r)));
        ctx.setResultCap(ctx.initResults(0, 1), 0, p.hook);
      },
    };
    const { a, ta, settle } = link(undefined, server);
    const boot = a.bootstrap();
    let resolveLocal!: (c: Client) => void;
    const localPromise = Client.fromPromise(new Promise<Client>((r) => (resolveLocal = r)));
    const reply = boot.call(IFACE, 0, (p, cb) => cb.setCap(p, 0, localPromise.hook), 0, 1);
    await settle();
    const returned = new Client((await reply).getCap((await reply).content.getP(0)));
    // A call through the promise, so resolution has to embargo.
    void returned.call(IFACE, 0, arg(1));
    await settle();
    // Resolve A's exported promise to a capability on this same connection,
    // and do not let B observe that Resolve yet. B still describes the
    // export as receiverHosted. The export table now holds an ImportClient,
    // which receiveCap wraps so the resolution is embargoed.
    resolveLocal(boot.dup());
    await new Promise((r) => setImmediate(r));
    const before = ta.sent.filter((name) => name === "disembargo").length;
    resolveBack(echoed!.dup());
    await new Promise((r) => setImmediate(r));
    a.pump();
    const after = ta.sent.filter((name) => name === "disembargo").length;
    expect(after).toBeGreaterThan(before);
    expect(a.disconnected).toBeUndefined();
  });
});
