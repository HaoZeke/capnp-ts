import { describe, expect, test } from "bun:test";
import { type Ptr, type StructBuilder, MessageBuilder } from "@haozeke/capnp";

import {
  CallBuilder,
  type CallContext,
  Client,
  RpcError,
  type RpcServer,
} from "../src/index.ts";
import { Message as CapnpMessage } from "@haozeke/capnp";
import {
  BOOTSTRAP_DWORDS,
  BOOTSTRAP_PWORDS,
  CALL_DWORDS,
  CALL_PWORDS,
  Call_sendResultsTo,
  Finish_getReleaseResultCaps,
  MESSAGE_DWORDS,
  MESSAGE_PWORDS,
  MESSAGE_TARGET_DWORDS,
  MESSAGE_TARGET_PWORDS,
  Message,
  Message_getFinish,
  Message_getReturn,
  MessageTarget,
  PAYLOAD_DWORDS,
  PAYLOAD_PWORDS,
  RETURN_DWORDS,
  RETURN_PWORDS,
  Return,
  Return_getAnswerId,
  Return_which,
} from "../src/rpc.capnp.ts";
import { MemoryTransportPair } from "../src/transport.ts";
import { RpcConnection } from "../src/vat.ts";
import { IFACE, link } from "./support.ts";

function finishFlags(frame: Uint8Array): { releaseResultCaps: boolean } {
  const finish = Message_getFinish(CapnpMessage.fromFlat(frame).root());
  return { releaseResultCaps: Finish_getReleaseResultCaps(finish) };
}

const arg = (n: number) => (p: StructBuilder) => p.setU32(0, n);

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

/** Returns a fresh Counter capability in pointer field 0. */
class Factory implements RpcServer {
  made: Counter[] = [];
  dispatch(_i: bigint, _m: number, _p: Ptr, _r: StructBuilder, ctx: CallContext): void {
    const counter = new Counter();
    this.made.push(counter);
    ctx.setResultCap(ctx.initResults(0, 1), 0, Client.local(counter).hook);
  }
}

/** Waits for `release`, honouring cancellation if told to. */
class Slow implements RpcServer {
  started = 0;
  finished = 0;
  aborted = 0;
  private gate!: () => void;
  constructor(private readonly cancellable: boolean) {}
  open(): void {
    this.gate();
  }
  dispatch(_i: bigint, _m: number, _p: Ptr, results: StructBuilder, ctx: CallContext) {
    this.started++;
    if (this.cancellable) ctx.allowCancellation();
    ctx.signal.addEventListener("abort", () => this.aborted++);
    return new Promise<void>((resolve) => {
      this.gate = resolve;
    }).then(() => {
      this.finished++;
      results.setU32(0, 99);
    });
  }
}

describe("calls over a connection", () => {
  test("bootstrap and a call return the server's results", async () => {
    const { a, settle } = link(undefined, new Counter());
    const boot = a.bootstrap();
    const out = boot.call(IFACE, 0, arg(41));
    await settle();
    expect((await out).content.getU32(0)).toBe(42);
  });

  test("a call on the unanswered bootstrap is pipelined, not delayed", async () => {
    const server = new Counter();
    const { a, ta, settle } = link(undefined, server);
    const out = a.bootstrap().call(IFACE, 0, arg(1));
    // Both messages left before any Return came back.
    expect(ta.sent).toEqual(["bootstrap", "call"]);
    await settle();
    expect((await out).content.getU32(0)).toBe(2);
    expect(server.seen).toEqual([1]);
  });

  test("a capability returned by a call can be pipelined before the answer", async () => {
    const factory = new Factory();
    const { a, ta, settle } = link(undefined, factory);
    const counter = a.bootstrap().call(IFACE, 0).pipeline(0);
    const out = counter.call(IFACE, 0, arg(6));
    expect(ta.sent).toEqual(["bootstrap", "call", "call"]);
    await settle();
    expect((await out).content.getU32(0)).toBe(7);
    expect(factory.made[0]!.seen).toEqual([6]);
  });

  test("a server exception reaches the caller with its type", async () => {
    const { a, settle } = link(undefined, {
      dispatch() {
        throw new RpcError("too busy", "overloaded");
      },
    });
    const out = a.bootstrap().call(IFACE, 0);
    await settle();
    await expect(Promise.resolve(out)).rejects.toMatchObject({
      message: "too busy",
      type: "overloaded",
    });
  });

  test("a call to a capability that does not exist fails", async () => {
    const { a, settle } = link(undefined, new Counter());
    const boot = a.bootstrap();
    await settle();
    // Poison the id: call something the peer never exported.
    const id = a.sendCall(55, IFACE, 0);
    await settle();
    expect(a.isFailed(id)).toBe(true);
    boot.release();
  });
});

describe("capability lifecycle", () => {
  test("dropping the last reference releases the peer's export", async () => {
    const server = new Counter();
    const { a, b, ta, settle } = link(undefined, server);
    const boot = a.bootstrap();
    const out = boot.call(IFACE, 0, arg(1));
    await settle();
    await out;
    expect(b.liveExports()).toEqual([0]);

    boot.release();
    await settle();
    expect(ta.sent).toContain("release");
    expect(b.liveExports()).toEqual([]);
    expect(a.liveImports()).toEqual([]);
  });

  test("a second reference keeps the export alive", async () => {
    const { a, b, settle } = link(undefined, new Counter());
    const boot = a.bootstrap();
    const out = boot.call(IFACE, 0, arg(1));
    await settle();
    await out;
    const second = boot.dup();
    boot.release();
    await settle();
    expect(b.liveExports()).toEqual([0]);
    second.release();
    await settle();
    expect(b.liveExports()).toEqual([]);
  });

  test("capabilities in results are released with the answer", async () => {
    const factory = new Factory();
    const { a, b, settle } = link(undefined, factory);
    const boot = a.bootstrap();
    const reply = boot.call(IFACE, 0);
    await settle();
    const results = await reply;
    const counter = new Client(results.getCap(results.content.getP(0)));
    expect(b.liveExports().length).toBe(2);

    reply.release();
    counter.release();
    boot.release();
    await settle();
    expect(b.liveExports()).toEqual([]);
    expect(factory.made[0]!.disposed).toBe(1);
  });

  test("a capability passed as a parameter can be called back", async () => {
    const callback = new Counter();
    const caller: RpcServer = {
      async dispatch(_i, _m, params, results, ctx) {
        const cap = new Client(ctx.getCap(params.getP(0)));
        const out = await cap.call(IFACE, 0, arg(10));
        results.setU32(0, out.content.getU32(0));
        cap.release();
      },
    };
    const { a, settle } = link(undefined, caller);
    const boot = a.bootstrap();
    const out = boot.call(
      IFACE,
      0,
      (p, b) => b.setCap(p, 0, Client.local(callback).hook),
      0,
      1,
    );
    await settle();
    expect((await out).content.getU32(0)).toBe(11);
    expect(callback.seen).toEqual([10]);
  });

  test("a capability the same peer sent back is recognised as its own", async () => {
    // B returns the very capability A passed in; A must see its local
    // object again, not an import that loops through B.
    const echo: RpcServer = {
      dispatch(_i, _m, params, _r, ctx) {
        ctx.setResultCap(ctx.initResults(0, 1), 0, ctx.getCap(params.getP(0)));
      },
    };
    const local = new Counter();
    const { a, settle } = link(undefined, echo);
    const boot = a.bootstrap();
    const out = boot.call(IFACE, 0, (p, b) => b.setCap(p, 0, Client.local(local).hook), 0, 1);
    await settle();
    const results = await out;
    const returned = results.getCap(results.content.getP(0));
    await new Client(returned).call(IFACE, 0, arg(5));
    expect(local.seen).toEqual([5]);
    expect(a.liveImports().length).toBe(1);
  });
});

describe("cancellation", () => {
  test("Finish cancels a call whose server allowed it", async () => {
    const slow = new Slow(true);
    const { a, settle, tb, ta } = link(undefined, slow);
    const boot = a.bootstrap();
    const out = boot.call(IFACE, 0);
    await settle();
    expect(slow.started).toBe(1);

    out.release();
    await settle();
    expect(ta.sent).toContain("finish");
    expect(slow.aborted).toBe(1);
    // A canceled call is not answered.
    expect(tb.sent.filter((k) => k === "return").length).toBe(1);
    slow.open();
    await settle();
    expect(tb.sent.filter((k) => k === "return").length).toBe(1);
  });

  test("without allowCancellation the call still runs to completion", async () => {
    const slow = new Slow(false);
    const { a, settle, tb } = link(undefined, slow);
    const boot = a.bootstrap();
    const out = boot.call(IFACE, 0);
    await settle();
    out.release();
    await settle();
    expect(slow.aborted).toBe(0);
    slow.open();
    await settle();
    expect(slow.finished).toBe(1);
    expect(tb.sent.filter((k) => k === "return").length).toBe(1);
  });

  test("the Finish for an unanswered call releases its result caps", async () => {
    const slow = new Slow(true);
    const { a, settle, ta } = link(undefined, slow);
    const out = a.bootstrap().call(IFACE, 0);
    await settle();
    out.release();
    expect(finishFlags(ta.frames[ta.frames.length - 1]!)).toEqual({ releaseResultCaps: true });
  });

  test("the Finish for an answered call leaves the caps to their own Release", async () => {
    const { a, settle, ta } = link(undefined, new Counter());
    const out = a.bootstrap().call(IFACE, 0, arg(1));
    await settle();
    await out;
    out.release();
    expect(finishFlags(ta.frames[ta.frames.length - 1]!)).toEqual({ releaseResultCaps: false });
  });

  test("a pipelined call keeps the question open after the handle is dropped", async () => {
    const factory = new Factory();
    const { a, settle, ta } = link(undefined, factory);
    const reply = a.bootstrap().call(IFACE, 0);
    const counter = reply.pipeline(0);
    reply.release();
    // The pipelined capability still names the question.
    expect(ta.sent).toEqual(["bootstrap", "call"]);
    const out = counter.call(IFACE, 0, arg(1));
    await settle();
    expect((await out).content.getU32(0)).toBe(2);
    // Once the answer came back and the capability resolved to its
    // import, nothing refers to the question and it is finished.
    expect(ta.sent.filter((k) => k === "finish").length).toBeGreaterThan(0);
  });
});

describe("promises over a connection", () => {
  test("a promise capability resolves and queued calls then arrive in order", async () => {
    const target = new Counter();
    let resolve!: (c: Client) => void;
    const server: RpcServer = {
      dispatch(_i, _m, _p, _r, ctx) {
        const promise = Client.fromPromise(new Promise<Client>((r) => (resolve = r)));
        ctx.setResultCap(ctx.initResults(0, 1), 0, promise.hook);
      },
    };
    const { a, b, settle } = link(undefined, server);
    const reply = a.bootstrap().call(IFACE, 0);
    await settle();
    const results = await reply;
    const promise = new Client(results.getCap(results.content.getP(0)));

    const early = [1, 2, 3].map((n) => promise.call(IFACE, 0, arg(n)));
    await settle();
    expect(target.seen).toEqual([]);

    resolve(Client.local(target));
    await settle();
    await Promise.all(early);
    expect(target.seen).toEqual([1, 2, 3]);

    await promise.whenResolved();
    expect(b.liveExports().length).toBeGreaterThan(0);
    const late = promise.call(IFACE, 0, arg(4));
    await settle();
    expect((await late).content.getU32(0)).toBe(5);
  });

  test("a promise the peer breaks fails calls made on it", async () => {
    let reject!: (e: Error) => void;
    const server: RpcServer = {
      dispatch(_i, _m, _p, _r, ctx) {
        const promise = Client.fromPromise(new Promise<Client>((_, r) => (reject = r)));
        ctx.setResultCap(ctx.initResults(0, 1), 0, promise.hook);
      },
    };
    const { a, settle } = link(undefined, server);
    const reply = a.bootstrap().call(IFACE, 0);
    await settle();
    const results = await reply;
    const promise = new Client(results.getCap(results.content.getP(0)));
    const pending = promise.call(IFACE, 0, arg(1));
    await settle();

    reject(new RpcError("gave up", "overloaded"));
    await settle();
    await expect(Promise.resolve(pending)).rejects.toMatchObject({ message: "gave up" });
    await promise.whenResolved().catch(() => {});
    expect(promise.isBroken).toBe(true);
  });

  test("a promise that has already resolved is exported as its target", async () => {
    const target = new Counter();
    const resolved = Client.fromPromise(Promise.resolve(Client.local(target)));
    await resolved.whenResolved();
    const server: RpcServer = {
      dispatch(_i, _m, _p, _r, ctx) {
        ctx.setResultCap(ctx.initResults(0, 1), 0, resolved.hook.addRef());
      },
    };
    const { a, settle } = link(undefined, server);
    const reply = a.bootstrap().call(IFACE, 0);
    await settle();
    const results = await reply;
    const cap = new Client(results.getCap(results.content.getP(0)));
    // A direct import, not a promise: nothing further will be resolved.
    expect(cap.hook.getResolved()).toBeUndefined();
    expect(cap.hook.whenMoreResolved()).toBeUndefined();
    const out = cap.call(IFACE, 0, arg(1));
    await settle();
    expect((await out).content.getU32(0)).toBe(2);
  });

  test("resolving to a capability the caller hosts embargoes until calls land", async () => {
    // A hands B a local capability. B returns a promise P and later
    // resolves it to A's capability, so A ends up holding a promise that
    // resolves back to its own object. Calls A made on P before the
    // resolution travelled through B; calls after must not overtake them.
    const local = new Counter();
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
    const { a, ta, settle } = link(undefined, server);
    const boot = a.bootstrap();
    boot.call(IFACE, 0, (p, b) => b.setCap(p, 0, Client.local(local).hook), 0, 1);
    const reply = boot.call(IFACE, 1);
    await settle();
    const results = await reply;
    const promise = new Client(results.getCap(results.content.getP(0)));

    const before = promise.call(IFACE, 0, arg(1));
    await settle();
    resolveP(held);
    await settle();
    await promise.whenResolved();
    const after = promise.call(IFACE, 0, arg(2));
    await settle();
    await Promise.all([before, after]);

    expect(local.seen).toEqual([1, 2]);
    expect(ta.sent).toContain("disembargo");
  });

  test("no embargo is raised when no call went through the promise", async () => {
    const local = new Counter();
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
    const { a, ta, settle } = link(undefined, server);
    const boot = a.bootstrap();
    boot.call(IFACE, 0, (p, b) => b.setCap(p, 0, Client.local(local).hook), 0, 1);
    const reply = boot.call(IFACE, 1);
    await settle();
    await reply;
    resolveP(held);
    await settle();
    expect(ta.sent).not.toContain("disembargo");
  });
});

describe("protocol errors", () => {
  test("a senderLoopback Disembargo aimed at a local object aborts", async () => {
    const { a, b, settle, tb } = link(undefined, new Counter());
    a.bootstrap();
    await settle();
    // Export 0 is a local object on B, so it cannot point back at A.
    const builder = new CallBuilder(0, 0);
    void builder;
    (a as unknown as { startEmbargo(t: unknown): void }).startEmbargo({
      writeTarget(t: StructBuilder) {
        t.setU16(4, 0);
        t.setU32(0, 0);
      },
    });
    await settle();
    expect(tb.sent).toContain("abort");
    expect(b.disconnected).toBeInstanceOf(RpcError);
    expect(a.disconnected?.type).toBe("disconnected");
  });
});

describe("shutdown", () => {
  test("abort fails outstanding questions and breaks imports on both ends", async () => {
    const slow = new Slow(true);
    const { a, b, settle } = link(undefined, slow);
    const boot = a.bootstrap();
    const out = boot.call(IFACE, 0);
    await settle();
    expect(slow.started).toBe(1);

    b.abort(new RpcError("shutting down"));
    await settle();
    await expect(Promise.resolve(out)).rejects.toMatchObject({ type: "disconnected" });
    await expect(Promise.resolve(boot.call(IFACE, 0))).rejects.toMatchObject({
      type: "disconnected",
    });
    expect(a.disconnected?.message).toContain("shutting down");
    expect(slow.aborted).toBe(1);
  });

  test("a closed transport disconnects", async () => {
    const { a, settle } = link(undefined, new Counter());
    const boot = a.bootstrap();
    await settle();
    (a as unknown as { transport: { close(): void } }).transport.close();
    a.pump();
    expect(a.disconnected).toBeDefined();
    await expect(Promise.resolve(boot.call(IFACE, 0))).rejects.toMatchObject({
      type: "disconnected",
    });
  });

  test("calls after disconnect fail without touching the transport", async () => {
    const { a, ta } = link(undefined, new Counter());
    a.disconnect(new RpcError("bye", "disconnected"));
    const sent = ta.frames.length;
    await expect(Promise.resolve(a.bootstrap().call(IFACE, 0))).rejects.toMatchObject({
      type: "disconnected",
    });
    expect(ta.frames.length).toBe(sent);
  });
});

describe("results sent elsewhere", () => {
  // The peer forwards a call back with sendResultsTo.yourself, then answers
  // our own question with takeFromOtherQuestion pointing at it. Frames are
  // built by hand because this vat never forwards that way itself.
  test("a held answer is claimed by takeFromOtherQuestion", async () => {
    const pair = new MemoryTransportPair();
    const server = new Counter();
    const a = new RpcConnection(pair.a, server);
    const peer = pair.b;

    const frame = (fill: (root: StructBuilder, b: MessageBuilder) => void): Uint8Array => {
      const b = new MessageBuilder();
      fill(b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS), b);
      return b.toFlat();
    };
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
        call.initStruct(1, PAYLOAD_DWORDS, PAYLOAD_PWORDS).initStruct(0, 1, 0).setU32(0, 20);
      }),
    );
    const mine = a.sendBootstrap();
    peer.receive(); // our bootstrap question
    a.pump();

    const held = CapnpMessage.fromFlat(peer.receive()!).root();
    const ret = Message_getReturn(held);
    expect(Return_getAnswerId(ret)).toBe(2);
    expect(Return_which(ret)).toBe(Return.resultsSentElsewhere);
    expect(server.seen).toEqual([20]);

    peer.send(
      frame((root) => {
        root.setU16(0, Message.return);
        const r = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
        r.setU32(0, mine);
        r.setU16(6, Return.takeFromOtherQuestion);
        r.setU32(8, 2);
      }),
    );
    a.pump();
    expect(a.isAnswered(mine)).toBe(true);
    expect(a.isFailed(mine)).toBe(false);
    expect(a.answerContent(mine)?.getU32(0)).toBe(21);
  });
});
