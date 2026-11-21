/**
 * Regressions found on the r7b tree: a closed transport must abort
 * `senderLoopback`, unclaimed fds must be closed, `adoptFd` must own
 * the first descriptor, a membrane must hide fds, and 253 is the limit.
 */
import { describe, expect, test } from "bun:test";
import { openSync, closeSync, readFileSync } from "node:fs";
import {
  ElemSize,
  Message as CapnpMessage,
  MessageBuilder,
  Orphan,
  type Ptr,
  type StructBuilder,
  wpMakeList,
} from "@haozeke/capnp";

import { Client, RpcError, type CallContext, type RpcServer } from "../src/index.ts";
import { WindowFlowController } from "../src/flow.ts";
import { membrane, MembranePolicy, RevocablePolicy } from "../src/membrane.ts";
import { ImportClient, type RemoteHost } from "../src/remote.ts";
import {
  Call_getParams,
  Call_getQuestionId,
  Call_sendResultsTo,
  CapDescriptor_getThirdPartyHosted,
  CapDescriptor,
  CAP_DESCRIPTOR_DWORDS,
  CAP_DESCRIPTOR_PWORDS,
  Message,
  Message_getCall,
  Message_getReturn,
  Message_which,
  MESSAGE_DWORDS,
  MESSAGE_PWORDS,
  MessageTarget,
  Return,
  Return_getResults,
  Return_which,
} from "../src/rpc.capnp.ts";
import {
  THIRD_PARTY_CAP_DESCRIPTOR_DWORDS,
  THIRD_PARTY_CAP_DESCRIPTOR_PWORDS,
  ThirdPartyCapDescriptor_getId,
} from "../src/rpc.capnp.ts";
import {
  THIRD_PARTY_CAP_ID_DWORDS,
  THIRD_PARTY_CAP_ID_PWORDS,
  ThirdPartyCapId_getVat,
  VAT_ID_DWORDS,
  VAT_ID_PWORDS,
} from "../src/rpc-threeparty.capnp.ts";
import { StreamTransport } from "../src/socket.ts";
import { MemoryTransportPair, type Transport } from "../src/transport.ts";
import { RpcConnection } from "../src/vat.ts";
import { IFACE, link } from "./support.ts";

function rpcFrame(tag: number, fill?: (m: StructBuilder) => void): Uint8Array {
  const b = new MessageBuilder();
  const root = b.initRoot(1, 1);
  root.setU16(0, tag);
  fill?.(root);
  return b.toFlat();
}

function bootstrap(q: number): Uint8Array {
  return rpcFrame(Message.bootstrap, (m) => m.initStruct(0, 1, 1).setU32(0, q));
}

function callOnBoot(q: number, n: number, opts?: { pipeline?: boolean; yourself?: boolean }): Uint8Array {
  return rpcFrame(Message.call, (m) => {
    const c = m.initStruct(0, 3, 3);
    c.setU32(0, q >>> 0);
    c.setU64(8, IFACE);
    const t = c.initStruct(0, 1, 1);
    t.setU16(4, MessageTarget.importedCap);
    t.setU32(0, 0);
    c.initStruct(1, 0, 2).initStruct(0, 1, 0).setU32(0, n);
    if (opts?.yourself) c.setU16(6, Call_sendResultsTo.yourself);
    if (opts?.pipeline) c.setBool(130, true);
  });
}

function finish(q: number): Uint8Array {
  return rpcFrame(Message.finish, (m) => {
    const fin = m.initStruct(0, 1, 0);
    fin.setU32(0, q >>> 0);
    fin.setBool(32, true, true);
    fin.setBool(33, false, true);
  });
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("senderLoopback after the transport closes", () => {
  test("the echo aborts the connection and does not reject", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const local: RpcServer = { dispatch() {} };
      let resolveP!: (c: Client) => void;
      let held!: Client;
      const server: RpcServer = {
        dispatch(_i, m, params, _r, ctx) {
          if (m === 0) {
            held = new Client(ctx.getCap(params.getP(0)));
            return;
          }
          const promise = Client.fromPromise(new Promise<Client>((r) => (resolveP = r)));
          ctx.setResultCap(ctx.initResults(0, 1), 0, promise.hook);
        },
      };
      const { a, b, tb } = link(undefined, server);
      const boot = a.bootstrap();
      boot.call(IFACE, 0, (p, cb) => cb.setCap(p, 0, Client.local(local).hook), 0, 1);
      const reply = boot.call(IFACE, 1);
      for (let i = 0; i < 8; i++) {
        a.pump();
        b.pump();
        await new Promise((r) => setImmediate(r));
      }
      const results = await reply;
      const promise = new Client(results.getCap(results.content.getP(0)));
      (a as unknown as { startEmbargo(t: unknown): void }).startEmbargo({
        writeTarget(t: StructBuilder) {
          t.setU16(4, 0);
          t.setU32(0, 1);
        },
      });
      b.pump();
      expect(b.disconnected).toBeUndefined();
      resolveP(held);
      // The Resolve goes out in a microtask. The echo waits one more turn.
      await new Promise((r) => setImmediate(r));
      expect(b.disconnected).toBeUndefined();
      tb.close();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(rejections).toEqual([]);
      expect(b.disconnected?.message).toContain("transport is closed");
      promise.release();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

function frame(which: number): Uint8Array {
  const b = new MessageBuilder();
  const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
  root.setU16(0, which);
  return b.toFlat();
}

describe("unclaimed received fds", () => {
  test("a message that names none of them is closed after dispatch", () => {
    const closed: number[] = [];
    const fd = 80;
    const inbox = [frame(Message.bootstrap)];
    const queued = [[fd]];
    let last: readonly number[] = [];
    let shut = false;
    const transport: Transport = {
      send() {},
      receive() {
        last = queued.shift() ?? [];
        return inbox.shift() ?? null;
      },
      receivedFds: () => last,
      ownsReceivedFds: () => true,
      get pending() {
        return inbox.length;
      },
      close() {
        shut = true;
      },
      get closed() {
        return shut;
      },
      closeFd(n: number) {
        closed.push(n);
      },
    };
    const vat = new RpcConnection(transport);
    expect(vat.pumpOnce()).toBe(true);
    expect(closed).toEqual([fd]);
  });

  test("an adopted fd stays open until the import is released", () => {
    const real = openSync("/dev/null", "r");
    const closed: number[] = [];
    const pair = new MemoryTransportPair();
    const server: RpcServer = {
      getFd: () => real,
      dispatch() {},
    };
    const a = new RpcConnection(pair.a, server);
    const inner = pair.b;
    const wrapped: Transport = {
      send(f, fds) {
        inner.send(f, fds);
      },
      receive: () => inner.receive(),
      receivedFds: () => inner.receivedFds?.() ?? [],
      ownsReceivedFds: () => true,
      get pending() {
        return inner.pending;
      },
      close: () => inner.close(),
      get closed() {
        return inner.closed;
      },
      closeFd(n: number) {
        closed.push(n);
      },
    };
    const b = new RpcConnection(wrapped);
    const cap = b.bootstrap();
    for (let i = 0; i < 4; i++) {
      a.pump();
      b.pump();
    }
    expect(cap.getFd()).toBe(real);
    expect(closed).toEqual([]);
    cap.release();
    expect(closed).toEqual([real]);
    try {
      closeSync(real);
    } catch {
      // release already closed it through the spy, or the spy only recorded it
    }
  });
});

describe("ImportClient.adoptFd", () => {
  test("the first fd is owned and a second one is closed", () => {
    const closed: number[] = [];
    const host: RemoteHost = {
      disconnected: undefined,
      streamWindow: 65536,
      createFlowController: () => new WindowFlowController(() => 65536),
      sendCallTo: () => {
        throw new Error("unused");
      },
      importDropped() {},
      promiseDropped() {},
      startEmbargo: () => {
        throw new Error("unused");
      },
      closeFd(fd: number) {
        closed.push(fd);
      },
    };
    const imp = new ImportClient(host, 1);
    imp.adoptFd(10);
    expect(imp.getFd()).toBe(10);
    imp.adoptFd(11);
    expect(imp.getFd()).toBe(10);
    expect(closed).toEqual([11]);
    imp.release();
    expect(closed).toEqual([11, 10]);
  });
});

class FdPolicy extends MembranePolicy {
  constructor(private readonly allow: boolean) {
    super();
  }
  inboundCall(): undefined {
    return undefined;
  }
  outboundCall(): undefined {
    return undefined;
  }
  override allowFdPassthrough(): boolean {
    return this.allow;
  }
}

describe("membrane fd passthrough", () => {
  test("getFd is hidden unless the policy opts in", () => {
    const server: RpcServer = {
      getFd: () => 9,
      dispatch() {},
    };
    const hidden = membrane(Client.local(server), new FdPolicy(false));
    expect(hidden.getFd()).toBeUndefined();
    const shown = membrane(Client.local(server), new FdPolicy(true));
    expect(shown.getFd()).toBe(9);
    hidden.release();
    shown.release();
  });
});

function fdClient(n: number): Client {
  return Client.local({
    getFd: () => n,
    dispatch() {},
  });
}

describe("attached fd limit", () => {
  test("253 descriptors are sent and a 254th is refused before encoding", () => {
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a);
    const boot = a.bootstrap();
    boot.call(
      0n,
      0,
      (p, caps) => {
        for (let i = 0; i < 253; i++) caps.setCap(p, i, fdClient(1000 + i).hook);
      },
      0,
      253,
    );
    expect(pair.b.receive()).not.toBeNull();
    const call = pair.b.receive();
    expect(call).not.toBeNull();
    expect(pair.b.receivedFds?.()?.length).toBe(253);

    const pair2 = new MemoryTransportPair();
    const c = new RpcConnection(pair2.a);
    const boot2 = c.bootstrap();
    expect(() =>
      boot2.call(
        0n,
        0,
        (p, caps) => {
          for (let i = 0; i < 254; i++) caps.setCap(p, i, fdClient(2000 + i).hook);
        },
        0,
        254,
      ),
    ).toThrow(/too many attached file descriptors/);
    expect(pair2.b.pending).toBe(1);
    c.disconnect(new RpcError("done", "disconnected"));
    a.disconnect(new RpcError("done", "disconnected"));
  });
});

describe("pipeline-only Finish", () => {
  const hang = (): { server: RpcServer; seen: number[] } => {
    const seen: number[] = [];
    return {
      seen,
      server: {
        dispatch(_i, _m, params) {
          seen.push(params.getU32(0));
          return new Promise(() => {});
        },
      },
    };
  };

  test("Finish frees the question id and the words still in flight", () => {
    const { server, seen } = hang();
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, server, undefined, { flowLimit: 1 << 20 });
    pair.b.send(bootstrap(0));
    pair.b.send(callOnBoot(1, 1, { pipeline: true }));
    vat.pump();
    expect(seen).toEqual([1]);
    pair.b.send(finish(1));
    vat.pump();
    vat.setFlowLimit(0);
    pair.b.send(callOnBoot(1, 9, { pipeline: true }));
    vat.pump();
    expect(seen).toEqual([1, 9]);
    expect(vat.disconnected).toBeUndefined();
  });

  test("Finish disposes the local server the call was forwarded to", () => {
    class Target implements RpcServer {
      seen = 0;
      disposed = 0;
      dispatch(): Promise<void> {
        this.seen++;
        return new Promise(() => {});
      }
      dispose(): void {
        this.disposed++;
      }
    }
    const target = new Target();
    const held = Client.local(target);
    const forwarder: RpcServer = {
      dispatch(_i: bigint, _m: number, _p: Ptr, _r: StructBuilder, ctx: CallContext) {
        const tail = ctx.tailCall(held, IFACE, 0, (p) => p.setU32(0, 4));
        held.release();
        return tail;
      },
    };
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, forwarder);
    pair.b.send(bootstrap(0));
    pair.b.send(callOnBoot(1, 1, { pipeline: true }));
    vat.pump();
    expect(target.seen, vat.disconnected?.message).toBe(1);
    expect(target.disposed).toBe(0);
    pair.b.send(finish(1));
    vat.pump();
    expect(target.disposed).toBe(1);
    expect(vat.disconnected).toBeUndefined();
  });
});

describe("null content and two-party vines", () => {
  test("bootstrap against a null capability is a null cap", async () => {
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a);
    const cap = a.bootstrap();
    expect(pair.b.receive()).not.toBeNull();
    pair.b.send(
      rpcFrame(Message.return, (m) => {
        const ret = m.initStruct(0, 2, 1);
        ret.setU32(0, 0);
        ret.setU16(6, Return.results);
        ret.initStruct(0, 0, 2);
      }),
    );
    a.pump();
    await cap.whenResolved();
    await expect(Promise.resolve(cap.call(IFACE, 0))).rejects.toThrow(/Called null capability/);
    expect(a.disconnected).toBeUndefined();
  });

  test("a two-party import of a non-text third-party id keeps the vine", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, { dispatch() {} });
    pair.b.send(bootstrap(0));
    const b = new MessageBuilder();
    const root = b.initRoot(1, 1);
    root.setU16(0, Message.call);
    const call = root.initStruct(0, 3, 3);
    call.setU32(0, 1);
    call.setU64(8, IFACE);
    const target = call.initStruct(0, 1, 1);
    target.setU16(4, MessageTarget.importedCap);
    target.setU32(0, 0);
    const payload = call.initStruct(1, 0, 2);
    payload.initStruct(0, 0, 0);
    const cd = payload.initCompositeList(1, 1, CAP_DESCRIPTOR_DWORDS, CAP_DESCRIPTOR_PWORDS);
    cd.setU16(0, CapDescriptor.thirdPartyHosted);
    const tp = cd.initStruct(0, THIRD_PARTY_CAP_DESCRIPTOR_DWORDS, THIRD_PARTY_CAP_DESCRIPTOR_PWORDS);
    tp.setU32(0, 7);
    const id = tp.initStruct(0, THIRD_PARTY_CAP_ID_DWORDS, THIRD_PARTY_CAP_ID_PWORDS);
    id.setU64(0, 1n);
    const vatId = id.initStruct(0, VAT_ID_DWORDS, VAT_ID_PWORDS);
    vatId.initStruct(0, 0, 0);
    pair.b.send(b.toFlat());
    vat.pump();
    expect(vat.disconnected).toBeUndefined();
    const reply = pair.b.receive();
    expect(reply).not.toBeNull();
    expect(Message_which(CapnpMessage.fromFlat(reply!).root())).toBe(Message.return);
  });

  test("a two-party import of a corrupt third-party host keeps the vine", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, { dispatch() {} });
    pair.b.send(bootstrap(0));
    const b = new MessageBuilder();
    const root = b.initRoot(1, 1);
    root.setU16(0, Message.call);
    const call = root.initStruct(0, 3, 3);
    call.setU32(0, 1);
    call.setU64(8, IFACE);
    const target = call.initStruct(0, 1, 1);
    target.setU16(4, MessageTarget.importedCap);
    target.setU32(0, 0);
    const payload = call.initStruct(1, 0, 2);
    payload.initStruct(0, 0, 0);
    const cd = payload.initCompositeList(1, 1, CAP_DESCRIPTOR_DWORDS, CAP_DESCRIPTOR_PWORDS);
    cd.setU16(0, CapDescriptor.thirdPartyHosted);
    const tp = cd.initStruct(0, THIRD_PARTY_CAP_DESCRIPTOR_DWORDS, THIRD_PARTY_CAP_DESCRIPTOR_PWORDS);
    tp.setU32(0, 7);
    const id = tp.initStruct(0, THIRD_PARTY_CAP_ID_DWORDS, THIRD_PARTY_CAP_ID_PWORDS);
    id.setU64(0, 1n);
    id.initStruct(0, VAT_ID_DWORDS, VAT_ID_PWORDS);
    const flat = b.toFlat();
    const viewed = CapnpMessage.viewFlat(flat);
    const params = Call_getParams(Message_getCall(viewed.root()));
    const desc = params.getP(1).listGetP(0);
    const hosted = CapDescriptor_getThirdPartyHosted(desc);
    const vatId = ThirdPartyCapId_getVat(ThirdPartyCapDescriptor_getId(hosted));
    const seg = viewed.segments[vatId.seg]!;
    const byte = seg.byteOffset + (vatId.word + vatId.dwords) * 8;
    new DataView(flat.buffer, byte, 8).setBigUint64(0, wpMakeList(0, ElemSize.Byte, 1 << 20), true);
    pair.b.send(flat);
    vat.pump();
    expect(vat.disconnected).toBeUndefined();
    const reply = pair.b.receive();
    expect(reply).not.toBeNull();
    expect(Message_which(CapnpMessage.fromFlat(reply!).root())).toBe(Message.return);
  });
});

describe("return bookkeeping", () => {
  test("one thrown return still lets the queued returns send", async () => {
    const pair = new MemoryTransportPair();
    let armed = false;
    let thrown = false;
    let sent = 0;
    const wrapped: Transport = {
      send(frame) {
        if (armed && Message_which(CapnpMessage.fromFlat(frame).root()) === Message.return) {
          if (!thrown) {
            thrown = true;
            throw new Error("return failed");
          }
          sent++;
        }
        pair.a.send(frame);
      },
      receive: () => pair.a.receive(),
      get pending() {
        return pair.a.pending;
      },
      close() {
        pair.a.close();
      },
      get closed() {
        return pair.a.closed;
      },
    };
    const server: RpcServer = {
      dispatch(_i, m, _p, results, ctx) {
        if (m === 0) {
          ctx.setResultCap(
            ctx.initResults(0, 1),
            0,
            Client.fromPromise(new Promise<Client>(() => {})).hook,
          );
          return;
        }
        results.setU32(0, m);
      },
    };
    const vat = new RpcConnection(wrapped, server);
    pair.b.send(bootstrap(0));
    pair.b.send(callOnBoot(1, 0));
    vat.pump();
    await tick();
    armed = true;
    pair.b.send(callOnBoot(2, 1));
    pair.b.send(callOnBoot(3, 2));
    vat.pump();
    await tick();
    expect(thrown).toBe(true);
    expect(sent).toBe(1);
    expect(vat.disconnected?.message).toContain("return failed");
  });

  test("a duplicate pipeline-only question sends no Return", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, {
      dispatch() {
        return new Promise(() => {});
      },
    });
    pair.b.send(bootstrap(0));
    pair.b.send(callOnBoot(1, 1));
    pair.b.send(callOnBoot(1, 2, { pipeline: true }));
    vat.pump();
    const kinds: number[] = [];
    for (;;) {
      const f = pair.b.receive();
      if (f === null) break;
      const root = CapnpMessage.fromFlat(f).root();
      if (Message_which(root) !== Message.return) continue;
      kinds.push(Return_which(Message_getReturn(root)));
    }
    expect(kinds).not.toContain(Return.canceled);
    expect(vat.disconnected?.message).toContain("already in use");
  });

  test("a reused question with yourself and onlyPromisePipeline returns resultsSentElsewhere", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, {
      dispatch() {
        return new Promise(() => {});
      },
    });
    pair.b.send(bootstrap(0));
    pair.b.send(callOnBoot(1, 1));
    pair.b.send(callOnBoot(1, 2, { yourself: true, pipeline: true }));
    vat.pump();
    const kinds: number[] = [];
    for (;;) {
      const f = pair.b.receive();
      if (f === null) break;
      const root = CapnpMessage.fromFlat(f).root();
      if (Message_which(root) !== Message.return) continue;
      kinds.push(Return_which(Message_getReturn(root)));
    }
    expect(kinds).toContain(Return.resultsSentElsewhere);
    expect(vat.disconnected?.message).toContain("already in use");
  });

  test("a duplicate redirected question returns resultsSentElsewhere", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, {
      dispatch() {
        return new Promise(() => {});
      },
    });
    pair.b.send(bootstrap(0));
    pair.b.send(callOnBoot(1, 1));
    pair.b.send(callOnBoot(1, 2, { yourself: true }));
    vat.pump();
    const kinds: number[] = [];
    for (;;) {
      const f = pair.b.receive();
      if (f === null) break;
      const root = CapnpMessage.fromFlat(f).root();
      if (Message_which(root) !== Message.return) continue;
      kinds.push(Return_which(Message_getReturn(root)));
    }
    expect(kinds).toContain(Return.resultsSentElsewhere);
    expect(vat.disconnected?.message).toContain("already in use");
  });

  test("a second Return names question->isAwaitingReturn", () => {
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a);
    const q = a.sendCall(0, IFACE, 0);
    pair.b.receive();
    const ret = rpcFrame(Message.return, (m) => {
      const body = m.initStruct(0, 2, 1);
      body.setU32(0, q);
      body.setU16(6, Return.results);
      body.initStruct(0, 0, 2);
    });
    pair.b.send(ret);
    pair.b.send(ret);
    a.pump();
    expect(a.disconnected?.message).toContain("expected question->isAwaitingReturn; Duplicate Return.");
  });

  test("param capabilities stay until Finish", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, {
      dispatch(_i, _m, _p, _r, ctx) {
        ctx.setResultCap(ctx.initResults(0, 1), 0, Client.local({ dispatch() {} }).hook);
      },
    });
    pair.b.send(bootstrap(0));
    const b = new MessageBuilder();
    const root = b.initRoot(1, 1);
    root.setU16(0, Message.call);
    const call = root.initStruct(0, 3, 3);
    call.setU32(0, 1);
    call.setU64(8, IFACE);
    const target = call.initStruct(0, 1, 1);
    target.setU16(4, MessageTarget.importedCap);
    target.setU32(0, 0);
    const payload = call.initStruct(1, 0, 2);
    payload.adopt(0, Orphan.cap(b, 0));
    const table = payload.initCompositeList(1, 1, 1, 1);
    table.setU16(0, CapDescriptor.senderHosted);
    table.setU32(4, 5);
    pair.b.send(b.toFlat());
    vat.pump();
    const before: number[] = [];
    for (;;) {
      const f = pair.b.receive();
      if (f === null) break;
      before.push(Message_which(CapnpMessage.fromFlat(f).root()));
    }
    expect(before).toContain(Message.return);
    expect(before).not.toContain(Message.release);
    pair.b.send(finish(1));
    vat.pump();
    const after: number[] = [];
    for (;;) {
      const f = pair.b.receive();
      if (f === null) break;
      after.push(Message_which(CapnpMessage.fromFlat(f).root()));
    }
    expect(after).toContain(Message.release);
    expect(vat.disconnected).toBeUndefined();
  });

  test("a bad results pointer is the call's error when the results are read", async () => {
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a);
    const cap = a.bootstrap();
    expect(pair.b.receive()).not.toBeNull();
    const ok = new MessageBuilder();
    const okRoot = ok.initRoot(1, 1);
    okRoot.setU16(0, Message.return);
    const okRet = okRoot.initStruct(0, 2, 1);
    okRet.setU32(0, 0);
    okRet.setU16(6, Return.results);
    const okPayload = okRet.initStruct(0, 0, 2);
    okPayload.adopt(0, Orphan.cap(ok, 0));
    const okTable = okPayload.initCompositeList(1, 1, 1, 1);
    okTable.setU16(0, CapDescriptor.senderHosted);
    okTable.setU32(4, 0);
    pair.b.send(ok.toFlat());
    a.pump();
    await cap.whenResolved();
    const pending = cap.call(IFACE, 0);
    let q = -1;
    for (;;) {
      const sent = pair.b.receive();
      if (sent === null) break;
      const root = CapnpMessage.fromFlat(sent).root();
      if (Message_which(root) === Message.call) {
        q = Call_getQuestionId(Message_getCall(root));
      }
    }
    expect(q).toBeGreaterThanOrEqual(0);
    const bad = new MessageBuilder();
    const badRoot = bad.initRoot(1, 1);
    badRoot.setU16(0, Message.return);
    const badRet = badRoot.initStruct(0, 2, 1);
    badRet.setU32(0, q);
    badRet.setU16(6, Return.results);
    const badPayload = badRet.initStruct(0, 0, 2);
    badPayload.initStruct(0, 0, 0);
    const flat = bad.toFlat();
    const viewed = CapnpMessage.viewFlat(flat);
    const results = Return_getResults(Message_getReturn(viewed.root()));
    const seg = viewed.segments[results.seg]!;
    const byte = seg.byteOffset + (results.word + results.dwords) * 8;
    new DataView(flat.buffer, byte, 8).setBigUint64(0, 100n << 32n, true);
    pair.b.send(flat);
    a.pump();
    expect(a.disconnected).toBeUndefined();
    const payload = await pending;
    expect(() => payload.content.getU32(0)).toThrow(/out-of-bounds/);
  });
});

describe("flow pause", () => {
  test("feed keeps bytes until reading resumes", () => {
    const t = new StreamTransport(() => {});
    t.setPaused(true);
    t.feed(new Uint8Array(8));
    expect(t.pending).toBe(0);
    t.setPaused(false);
    expect(t.pending).toBe(1);
  });
});

describe("an exported membrane", () => {
  test("revoking one that is already exported does not reject unhandled", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const policy = new RevocablePolicy();
      const wrapped = membrane(Client.fromPromise(new Promise<Client>(() => {})), policy);
      let resolveOuter!: (c: Client) => void;
      const server: RpcServer = {
        dispatch(_i, m, _p, _r, ctx) {
          if (m === 0) {
            ctx.setResultCap(ctx.initResults(0, 1), 0, wrapped.hook);
            return;
          }
          const pending = Client.fromPromise(new Promise<Client>((r) => (resolveOuter = r)));
          ctx.setResultCap(ctx.initResults(0, 1), 0, pending.hook);
        },
      };
      const { a, settle } = link(undefined, server);
      const boot = a.bootstrap();
      await settle();
      const first = boot.call(IFACE, 0, undefined, 0, 1);
      const second = boot.call(IFACE, 1, undefined, 0, 1);
      await settle();
      resolveOuter(wrapped);
      await settle();
      policy.revoke("revoked!");
      await settle();
      expect(rejections).toEqual([]);
      first.release();
      second.release();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

describe("portable core", () => {
  test("vat.ts and remote.ts do not import node:fs", () => {
    const vat = readFileSync(new URL("../src/vat.ts", import.meta.url), "utf8");
    const remote = readFileSync(new URL("../src/remote.ts", import.meta.url), "utf8");
    expect(vat.includes("node:fs")).toBe(false);
    expect(remote.includes("node:fs")).toBe(false);
    expect(readFileSync(new URL("../src/unix.ts", import.meta.url), "utf8").includes("node:fs")).toBe(
      true,
    );
  });
});
