import { describe, expect, test } from "bun:test";
import type { Ptr, StructBuilder } from "@haozeke/capnp";

import {
  CallBuilder,
  type CallContext,
  type ClientHook,
  Client,
  failedCall,
  newBrokenCap,
  Payload,
  RefHook,
  RpcError,
  type RpcServer,
} from "../src/capability.ts";

const IFACE = 0x1234n;

/** Adds one to its argument and records the order calls arrived in. */
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

/** Returns a capability to a fresh Counter in pointer field 0. */
class Factory implements RpcServer {
  made: Counter[] = [];
  dispatch(
    _i: bigint,
    _m: number,
    _params: Ptr,
    _results: StructBuilder,
    ctx: CallContext,
  ): void {
    const counter = new Counter();
    this.made.push(counter);
    const results = ctx.initResults(0, 1);
    ctx.setResultCap(results, 0, Client.local(counter).hook);
  }
}

const arg = (n: number) => (p: StructBuilder) => p.setU32(0, n);

describe("local capabilities", () => {
  test("a call reaches the server and returns its results", async () => {
    const c = Client.local(new Counter());
    const out = await c.call(IFACE, 0, arg(41));
    expect(out.content.getU32(0)).toBe(42);
  });

  test("a server that throws fails the call with its message", async () => {
    const c = Client.local({
      dispatch() {
        throw new Error("nope");
      },
    });
    await expect(Promise.resolve(c.call(IFACE, 0))).rejects.toThrow("nope");
  });

  test("an async server answers later and calls still run in order", async () => {
    const order: number[] = [];
    const c = Client.local({
      async dispatch(_i, _m, params, results) {
        const n = params.getU32(0);
        order.push(n);
        await new Promise((r) => setTimeout(r, 5 - n));
        results.setU32(0, n);
      },
    });
    const calls = [1, 2, 3].map((n) => c.call(IFACE, 0, arg(n)));
    const got = await Promise.all(calls.map(async (p) => (await p).content.getU32(0)));
    expect(order).toEqual([1, 2, 3]);
    expect(got).toEqual([1, 2, 3]);
  });

  test("the server is disposed when the last reference goes", () => {
    const server = new Counter();
    const a = Client.local(server);
    const b = a.dup();
    a.release();
    expect(server.disposed).toBe(0);
    b.release();
    expect(server.disposed).toBe(1);
  });

  test("a reference used after release is refused", () => {
    const a = Client.local(new Counter());
    const hook = a.hook;
    a.release();
    expect(() => hook.addRef()).toThrow(RpcError);
  });
});

describe("promise pipelining on local calls", () => {
  test("a call on a pipelined capability waits for the results", async () => {
    const factory = new Factory();
    const f = Client.local(factory);
    const pending = f.call(IFACE, 0);
    const counter = pending.pipeline(0);
    const out = await counter.call(IFACE, 0, arg(9));
    expect(out.content.getU32(0)).toBe(10);
    expect(factory.made[0]!.seen).toEqual([9]);
  });

  test("pipelined calls are delivered in the order they were made", async () => {
    const factory = new Factory();
    const counter = Client.local(factory).call(IFACE, 0).pipeline(0);
    const calls = [5, 6, 7].map((n) => counter.call(IFACE, 0, arg(n)));
    await Promise.all(calls);
    expect(factory.made[0]!.seen).toEqual([5, 6, 7]);
  });

  test("pipelining through a failed call fails the pipelined call", async () => {
    const f = Client.local({
      dispatch() {
        throw new Error("no factory today");
      },
    });
    const counter = f.call(IFACE, 0).pipeline(0);
    await expect(Promise.resolve(counter.call(IFACE, 0, arg(1)))).rejects.toThrow("no factory today");
  });

  test("a pipeline path through a null pointer is a broken capability", async () => {
    const f = Client.local({
      dispatch() {},
    });
    const missing = f.call(IFACE, 0).pipeline(0);
    await expect(Promise.resolve(missing.call(IFACE, 0))).rejects.toThrow("null capability");
  });

  test("dropping the call handle does not cancel a local call with a live pipelined cap", async () => {
    const factory = new Factory();
    let release!: () => void;
    const asyncFactory: RpcServer = {
      dispatch(i, m, p, r, ctx) {
        ctx.allowCancellation();
        return new Promise<void>((res) => (release = res)).then(() => {
          factory.dispatch(i, m, p, r, ctx);
        });
      },
    };
    const f = Client.local(asyncFactory);
    const pending = f.call(IFACE, 0);
    const counter = pending.pipeline(0);
    pending.release();
    const out = counter.call(IFACE, 0, arg(4));
    release();
    expect((await out).content.getU32(0)).toBe(5);
  });

  test("local tailCall forwards results and pipelined capabilities", async () => {
    const factory = new Factory();
    const proxy: RpcServer = {
      dispatch(_i, _m, _p, _r, ctx) {
        const target = Client.local(factory);
        return ctx.tailCall(target, IFACE, 0).finally(() => target.release());
      },
    };
    const p = Client.local(proxy);
    const counter = p.call(IFACE, 0).pipeline(0);
    const out = await counter.call(IFACE, 0, arg(11));
    expect(out.content.getU32(0)).toBe(12);
    expect(factory.made[0]!.seen).toEqual([11]);
  });
});

describe("broken capabilities", () => {
  test("every call fails with the same error", async () => {
    const c = Client.broken(new RpcError("gone", "disconnected"));
    expect(c.isBroken).toBe(true);
    await expect(Promise.resolve(c.call(IFACE, 0))).rejects.toMatchObject({ message: "gone", type: "disconnected" });
    await expect(Promise.resolve(c.call(IFACE, 1))).rejects.toMatchObject({ message: "gone" });
  });

  test("a capability that becomes broken after a promise rejects is broken", async () => {
    const c = Client.fromPromise(Promise.reject(new RpcError("late failure")));
    await c.whenResolved().catch(() => {});
    await expect(Promise.resolve(c.call(IFACE, 0))).rejects.toThrow("late failure");
    expect(c.isBroken).toBe(true);
  });

  test("newBrokenCap keeps the error type", () => {
    const hook = newBrokenCap(new RpcError("x", "overloaded"));
    expect(hook.brokenError?.type).toBe("overloaded");
  });
});

describe("promise capabilities", () => {
  test("calls made before resolution are forwarded in order", async () => {
    const server = new Counter();
    let resolve!: (c: Client) => void;
    const promise = Client.fromPromise(new Promise<Client>((r) => (resolve = r)));
    const early = [1, 2, 3].map((n) => promise.call(IFACE, 0, arg(n)));
    expect(server.seen).toEqual([]);
    resolve(Client.local(server));
    await Promise.all(early);
    expect(server.seen).toEqual([1, 2, 3]);
  });

  test("whenResolved settles and getResolved then sees the target", async () => {
    const server = new Counter();
    const promise = Client.fromPromise(Promise.resolve(Client.local(server)));
    await promise.whenResolved();
    expect(promise.hook.getResolved()).toBeDefined();
    const out = await promise.call(IFACE, 0, arg(1));
    expect(out.content.getU32(0)).toBe(2);
  });
});

describe("cancellation", () => {
  test("a canceled call is not stopped unless the server allowed it", async () => {
    let finished = false;
    const c = Client.local({
      async dispatch() {
        await new Promise((r) => setTimeout(r, 10));
        finished = true;
      },
    });
    const call = c.call(IFACE, 0);
    call.release();
    await new Promise((r) => setTimeout(r, 30));
    expect(finished).toBe(true);
    await expect(Promise.resolve(call)).rejects.toThrow("canceled");
  });

  test("a cancel that arrived first aborts once cancellation is allowed", async () => {
    let ctx!: CallContext;
    const c = Client.local({
      dispatch(_i, _m, _p, _r, context) {
        ctx = context;
        return new Promise(() => {});
      },
    });
    const call = c.call(IFACE, 0);
    call.release();
    expect(ctx.signal.aborted).toBe(false);
    ctx.allowCancellation();
    expect(ctx.signal.aborted).toBe(true);
    await expect(Promise.resolve(call)).rejects.toThrow("canceled");
  });

  test("a server that allowed cancellation sees its signal abort at once", async () => {
    let aborted = false;
    const c = Client.local({
      async dispatch(_i, _m, _p, _r, ctx) {
        ctx.allowCancellation();
        ctx.signal.addEventListener("abort", () => (aborted = true));
        await new Promise((r) => setTimeout(r, 50));
      },
    });
    const call = c.call(IFACE, 0);
    call.release();
    expect(aborted).toBe(true);
    await expect(Promise.resolve(call)).rejects.toThrow("canceled");
  });
});

/** Records stream calls so a queue cannot satisfy them with plain call(). */
class StreamTarget extends RefHook implements ClientHook {
  readonly brand = StreamTarget;
  readonly brokenError = undefined;
  readonly streams: number[] = [];
  calls = 0;
  flushes = 0;

  getResolved(): undefined {
    return undefined;
  }

  whenMoreResolved(): undefined {
    return undefined;
  }

  call(_interfaceId: bigint, _methodId: number, params: Payload): ReturnType<ClientHook["call"]> {
    this.calls++;
    params.release();
    return failedCall(new RpcError("used call"));
  }

  callStreaming(_interfaceId: bigint, _methodId: number, params: Payload): Promise<void> {
    this.streams.push(params.content.getU32(0));
    params.release();
    return Promise.resolve();
  }

  flush(): Promise<void> {
    this.flushes++;
    return Promise.resolve();
  }

  protected dispose(): void {}
}

describe("queued calls", () => {
  test("streaming calls and flush wait for the resolved client", async () => {
    let resolve!: (c: Client) => void;
    const queued = Client.fromPromise(new Promise<Client>((r) => (resolve = r)));
    const inner = new StreamTarget();
    const sent = queued.callStreaming(IFACE, 0, arg(7));
    let flushed = false;
    const flushing = queued.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    expect(inner.streams).toEqual([]);
    expect(inner.calls).toBe(0);
    resolve(new Client(inner));
    await sent;
    await flushing;
    expect(inner.calls).toBe(0);
    expect(inner.streams).toEqual([7]);
    expect(inner.flushes).toBe(1);
    expect(flushed).toBe(true);
  });

  test("canceling a queued call releases its parameters", () => {
    let resolve!: (c: Client) => void;
    const promise = Client.fromPromise(new Promise<Client>((r) => (resolve = r)));
    const param = new Counter();
    const call = promise.call(
      IFACE,
      0,
      (p, cb) => cb.setCap(p, 0, Client.local(param).hook),
      0,
      1,
    );
    call.release();
    expect(param.disposed).toBe(1);
    resolve(Client.local(new Counter()));
  });

  test("a pipelined cap keeps a queued call alive after its promise is released", async () => {
    let resolve!: (c: Client) => void;
    const queued = Client.fromPromise(new Promise<Client>((r) => (resolve = r)));
    const factory = new Factory();
    const pending = queued.call(IFACE, 0);
    const counter = pending.pipeline(0);
    pending.release();
    const out = counter.call(IFACE, 0, arg(4));
    resolve(Client.local(factory));
    expect((await out).content.getU32(0)).toBe(5);
    expect(factory.made.length).toBe(1);
  });

  test("a queued call is still canceled when its pipelined caps are dropped too", () => {
    let resolve!: (c: Client) => void;
    const queued = Client.fromPromise(new Promise<Client>((r) => (resolve = r)));
    const param = new Counter();
    const factory = new Factory();
    const pending = queued.call(
      IFACE,
      0,
      (p, cb) => cb.setCap(p, 0, Client.local(param).hook),
      0,
      1,
    );
    const counter = pending.pipeline(0);
    pending.release();
    expect(param.disposed).toBe(0);
    counter.hook.release();
    expect(param.disposed).toBe(1);
    resolve(Client.local(factory));
    expect(factory.made.length).toBe(0);
  });
});

describe("streaming calls on a local server", () => {
  const stream = (log: string[], failOn?: number): RpcServer => ({
    isStreaming: (_i, m) => m === 0,
    async dispatch(_i, m, params) {
      const n = params.getU32(0);
      log.push(`${m === 0 ? "write" : "end"}${n}`);
      await new Promise((r) => setTimeout(r, 3));
      if (m === 0 && n === failOn) throw new Error("write failed");
    },
  });

  test("a call waits for the streaming call ahead of it", async () => {
    const log: string[] = [];
    const sink = Client.local(stream(log));
    const writes = [1, 2, 3].map((n) => sink.call(IFACE, 0, arg(n)));
    const end = sink.call(IFACE, 1, arg(0));
    await end;
    await Promise.all(writes);
    expect(log).toEqual(["write1", "write2", "write3", "end0"]);
  });

  test("a failed streaming call breaks the capability for later calls", async () => {
    const log: string[] = [];
    const sink = Client.local(stream(log, 2));
    const first = sink.call(IFACE, 0, arg(1));
    const second = sink.call(IFACE, 0, arg(2));
    const third = sink.call(IFACE, 0, arg(3));
    await first;
    await expect(Promise.resolve(second)).rejects.toThrow("write failed");
    await expect(Promise.resolve(third)).rejects.toThrow("write failed");
    expect(log).toEqual(["write1", "write2"]);
    await expect(Promise.resolve(sink.call(IFACE, 1, arg(0)))).rejects.toThrow("write failed");
  });
});

describe("payloads", () => {
  test("a capability pointer outside the cap table is invalid, as capnp-C++ `extractCap`", () => {
    const b = new CallBuilder(0, 1);
    b.root.adopt(0, b.addCap(newBrokenCap(new RpcError("x"))));
    const payload = b.toPayload();
    const ptr = payload.content.getP(0);
    expect(payload.getCap(ptr).brokenError?.message).toBe("x");
    const bare = new Payload(payload.content, []);
    expect(() => bare.getCap(ptr)).toThrow("Message contains invalid capability pointer.");
    expect(() => bare.getPipelinedCap([0])).toThrow("Message contains invalid capability pointer.");
    expect(bare.pipelinedCapAt([0]).brokenError?.message).toBe(
      "Message contains invalid capability pointer.",
    );
  });
});
