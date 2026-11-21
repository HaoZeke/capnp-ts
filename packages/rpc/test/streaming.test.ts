import { describe, expect, test } from "bun:test";
import type { Ptr, StructBuilder } from "@haozeke/capnp";

import {
  AdaptiveStreamWindow,
  type CallContext,
  Client,
  membrane,
  RevocablePolicy,
  RpcConnection,
  RpcError,
  RpcStream,
  type RpcServer,
  Settle,
  StreamTransport,
  WindowFlowController,
} from "../src/index.ts";
import { ImportClient } from "../src/remote.ts";
import { frameLength } from "../src/socket.ts";
import { IFACE, link } from "./support.ts";

const WRITE = 0;
const DONE = 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Sink: write is `-> stream`, done reports the total. */
class Sink implements RpcServer {
  total = 0;
  writes: number[] = [];
  doneAt: number | undefined;
  constructor(
    private readonly delayMs = 0,
    private readonly failOn = -1,
  ) {}
  isStreaming(_i: bigint, m: number): boolean {
    return m === WRITE;
  }
  async dispatch(_i: bigint, m: number, params: Ptr, _r: StructBuilder, ctx: CallContext) {
    if (m === WRITE) {
      const n = params.getU32(0);
      this.writes.push(n);
      if (this.delayMs > 0) await sleep(this.delayMs);
      if (n === this.failOn) throw new RpcError("disk full", "overloaded");
      this.total += params.getData(0).length;
      return;
    }
    this.doneAt = this.writes.length;
    ctx.initResults(1, 0).setU64(0, BigInt(this.total));
  }
}

const chunk =
  (n: number, bytes: number) =>
  (p: StructBuilder): void => {
    p.setU32(0, n);
    p.setData(0, new Uint8Array(bytes));
  };

async function openSink(sink: Sink, window: number) {
  const { a, b, settle } = link(undefined, sink, { streamWindow: window });
  const client = a.bootstrap();
  await settle();
  return { a, b, settle, client, stream: new RpcStream(client) };
}

describe("flow controller", () => {
  const ack = () => new Settle<void>();

  test("sends resolve while the window has room and wait once it is full", async () => {
    const flow = new WindowFlowController(() => 100);
    const a = ack();
    const b = ack();
    const c = ack();
    // Window 100 plus the largest message seen (60) is 160 bytes in flight.
    await flow.send(60, a);
    await flow.send(60, b);
    let third = false;
    const blocked = flow.send(60, c).then(() => (third = true));
    await sleep(1);
    expect(third).toBe(false);
    expect(flow.inFlight).toBe(180);
    a.resolve();
    await blocked;
    expect(flow.waits).toBe(1);
  });

  test("a message larger than the window is let through, and only the next one waits", async () => {
    const flow = new WindowFlowController(() => 10);
    await flow.send(500, ack());
    // 500 in flight is within window + largest message, so the first send
    // does not wait even though it is fifty times the window.
    expect(flow.waits).toBe(0);
    void flow.send(500, ack());
    expect(flow.waits).toBe(1);
  });

  test("waitAllAcked resolves when the last ack arrives", async () => {
    const flow = new WindowFlowController(() => 1000);
    const a = ack();
    const b = ack();
    void flow.send(10, a);
    void flow.send(10, b);
    let done = false;
    const all = flow.waitAllAcked().then(() => (done = true));
    a.resolve();
    await sleep(1);
    expect(done).toBe(false);
    b.resolve();
    await all;
    expect(flow.inFlight).toBe(0);
  });

  test("after a failure later sends reject and waitAllAcked still resolves", async () => {
    const flow = new WindowFlowController(() => 1000);
    const a = ack();
    void flow.send(10, a);
    a.reject(new RpcError("boom"));
    const b = ack();
    await expect(flow.send(10, b)).rejects.toThrow("boom");
    expect(flow.inFlight).toBe(10);
    b.resolve(undefined);
    await flow.waitAllAcked();
    expect(flow.inFlight).toBe(0);
  });

  test("a sender blocked when a call fails is released with the failure", async () => {
    const flow = new WindowFlowController(() => 0);
    const a = ack();
    await flow.send(10, a);
    const blocked = flow.send(10, ack());
    a.reject(new RpcError("late"));
    await expect(blocked).rejects.toThrow("late");
  });

  test("skips querying window when inFlight is within maxMessageSize", async () => {
    let calls = 0;
    const flow = new WindowFlowController(() => {
      calls++;
      return 100;
    });
    const a = ack();
    await flow.send(50, a);
    expect(calls).toBe(0);
    await flow.send(50, ack());
    expect(calls).toBe(1);
    a.resolve();
  });

  test("AdaptiveStreamWindow grows when saturated at low RTT and backs off on congestion", async () => {
    let clock = 0;
    const win = new AdaptiveStreamWindow({
      initialWindow: 100,
      minWindow: 100,
      maxWindow: 500,
      minRttFloorMs: 1,
      now: () => clock,
    });
    const flow = new WindowFlowController(win);
    const a = ack();
    const b = ack();
    const c = ack();
    await flow.send(60, a);
    await flow.send(60, b);
    const blocked = flow.send(60, c);
    clock = 2; // low RTT while saturated -> grows window
    a.resolve();
    await blocked;
    const grown = win.getWindow();
    expect(grown).toBeGreaterThan(100);

    // High RTT spike -> multiplicative backoff, clamped at minWindow.
    clock = 50;
    b.resolve();
    expect(win.getWindow()).toBeLessThan(grown);
    expect(win.getWindow()).toBeGreaterThanOrEqual(100);
    c.resolve();
  });

  test("RpcConnection tracks a dynamic transport sendBufferSize window", () => {
    let bufSize = 16384;
    const t = new StreamTransport(() => {}, () => bufSize);
    const conn = new RpcConnection(t);
    expect(conn.streamWindow).toBe(16384);
    bufSize = 131072;
    expect(conn.streamWindow).toBe(131072);
    // No reported buffer falls back to the fixed 64 KiB window.
    const t2 = new StreamTransport(() => {});
    const conn2 = new RpcConnection(t2);
    expect(conn2.streamWindow).toBe(65536);
  });

  test("the default window stays fixed while an explicit adaptive window grows", async () => {
    const fixed = new RpcConnection(new StreamTransport(() => {}));
    const flow = fixed.createFlowController();
    const a = ack();
    const b = ack();
    const c = ack();
    await flow.send(40000, a);
    await flow.send(40000, b);
    const blocked = flow.send(40000, c);
    a.resolve();
    await blocked;
    b.resolve();
    c.resolve();
    expect(fixed.streamWindow).toBe(65536);

    let clock = 0;
    const adaptive = new AdaptiveStreamWindow({
      initialWindow: 100,
      minWindow: 100,
      maxWindow: 500,
      minRttFloorMs: 1,
      now: () => clock,
    });
    const opted = new RpcConnection(new StreamTransport(() => {}), undefined, undefined, {
      streamWindow: adaptive,
    });
    const optedFlow = opted.createFlowController();
    const d = ack();
    const e = ack();
    const f = ack();
    await optedFlow.send(60, d);
    await optedFlow.send(60, e);
    const wait = optedFlow.send(60, f);
    clock = 2;
    d.resolve();
    await wait;
    expect(opted.streamWindow).toBeGreaterThan(100);
    e.resolve();
    f.resolve();
  });
});

describe("stream framing", () => {
  // capnp-C++ reads RPC frames with FlatArrayMessageReader, which has no
  // segment cap; only InputStreamMessageReader stops at 511.
  test("accepts 511, 512 and 1000 segments", () => {
    for (const [n, bytes] of [
      [511, 2048],
      [512, 2056],
      [1000, 4008],
    ] as const) {
      const frame = new Uint8Array(bytes);
      new DataView(frame.buffer).setUint32(0, n - 1, true);
      expect(frameLength(frame)).toBe(frame.length);
    }
  });
});

describe("streaming over a connection", () => {
  test("a sender that awaits each call stays inside the window", async () => {
    const sink = new Sink(0);
    const { a, client, stream, settle } = await openSink(sink, 4096);
    void a;
    const pump = setInterval(() => void settle(), 1);
    for (let n = 0; n < 200; n++) await stream.send(IFACE, WRITE, chunk(n, 1000), 1, 1);
    await stream.finish();
    clearInterval(pump);
    const out = client.call(IFACE, DONE, undefined, 0, 0);
    await settle();
    expect((await out).content.getU64(0)).toBe(200_000n);

    const flow = (client.resolved() as ImportClient).flow;
    expect(flow.waits).toBeGreaterThan(0);
    // The window, the largest message, and the message whose send found
    // the window full; each frame is a little over 1000 bytes.
    expect(flow.peakInFlight).toBeLessThanOrEqual(4096 + 2 * 1200);
    expect(flow.peakInFlight).toBeGreaterThan(2048);
    expect(flow.inFlight).toBe(0);
  });

  test("the server runs stream calls in the order they were sent", async () => {
    const sink = new Sink(1);
    const { client, stream, settle } = await openSink(sink, 1 << 20);
    for (let n = 0; n < 20; n++) void stream.send(IFACE, WRITE, chunk(n, 8), 1, 1);
    const out = client.call(IFACE, DONE, undefined, 0, 0);
    while (out.result.state === "pending") await settle();
    expect(sink.writes).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  test("a call after the stream waits for every write to finish", async () => {
    const sink = new Sink(2);
    const { client, stream, settle } = await openSink(sink, 1 << 20);
    for (let n = 0; n < 10; n++) void stream.send(IFACE, WRITE, chunk(n, 8), 1, 1);
    const out = client.call(IFACE, DONE, undefined, 0, 0);
    while (out.result.state === "pending") await settle();
    expect(sink.doneAt).toBe(10);
    expect((await out).content.getU64(0)).toBe(80n);
  });

  test("a failed write surfaces at the next send, at finish and at the next call", async () => {
    const sink = new Sink(1, 3);
    const { client, stream, settle } = await openSink(sink, 1 << 20);
    const sends: Array<Promise<void>> = [];
    for (let n = 0; n < 8; n++) sends.push(stream.send(IFACE, WRITE, chunk(n, 8), 1, 1));
    const flushed = stream.finish();
    const out = client.call(IFACE, DONE, undefined, 0, 0);
    const outcome = Promise.allSettled([...sends, flushed, Promise.resolve(out)]);
    const timer = setInterval(() => void settle(), 1);
    const results = await outcome;
    clearInterval(timer);

    // Writes 0 to 2 were accepted; the 3rd failed and broke the capability.
    // finish() is waitAllAcked, which resolves once the acks settle.
    expect(results.slice(0, 3).every((r) => r.status === "fulfilled")).toBe(true);
    expect(results[results.length - 2]!.status).toBe("fulfilled");
    expect(results[results.length - 1]!.status).toBe("rejected");
    const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    for (const f of failures) expect(f.reason).toMatchObject({ message: "remote exception: disk full" });
    // After the failure the server did no more writes.
    expect(sink.writes).toEqual([0, 1, 2, 3]);
  });

  test("after a failure a further send is refused", async () => {
    const sink = new Sink(0, 0);
    const { stream, settle } = await openSink(sink, 1 << 20);
    void stream.send(IFACE, WRITE, chunk(0, 8), 1, 1).catch(() => {});
    await settle();
    await expect(stream.send(IFACE, WRITE, chunk(1, 8), 1, 1)).rejects.toThrow("disk full");
    await settle();
    await stream.finish();
  });

  test("streaming to a local capability resolves when the call returns", async () => {
    const sink = new Sink(1);
    const c = Client.local(sink);
    await c.callStreaming(IFACE, WRITE, chunk(0, 5), 1, 1);
    expect(sink.total).toBe(5);
    await c.flush();
  });

  test("a failed local stream call breaks the capability", async () => {
    const c = Client.local(new Sink(0, 0));
    await expect(c.callStreaming(IFACE, WRITE, chunk(0, 5), 1, 1)).rejects.toThrow("disk full");
    await expect(c.callStreaming(IFACE, WRITE, chunk(1, 5), 1, 1)).rejects.toThrow("disk full");
  });

  test("pipelined stream calls keep their flow controller and errors after resolution", async () => {
    let openGate!: () => void;
    const sink = new Sink(0, 2);
    const factory: RpcServer = {
      dispatch(_i, _m, _p, _r, ctx) {
        return new Promise<void>((r) => (openGate = r)).then(() => {
          ctx.setResultCap(ctx.initResults(0, 1), 0, Client.local(sink).hook);
        });
      },
    };
    const { a, settle } = link(undefined, factory, { streamWindow: 1 << 20 });
    const boot = a.bootstrap();
    await settle();
    const pipelinedSink = boot.call(IFACE, 0).pipeline(0);
    const stream = new RpcStream(pipelinedSink);
    const sends = [0, 1, 2, 3].map((n) => stream.send(IFACE, WRITE, chunk(n, 16), 1, 1));
    await settle();
    openGate();
    await settle();
    await Promise.allSettled(sends);
    await stream.finish();
    await expect(stream.send(IFACE, WRITE, chunk(4, 16), 1, 1)).rejects.toThrow("disk full");
  });

  test("Return.canceled after a stream cancel frees the flow window", async () => {
    const hang: RpcServer = {
      isStreaming() {
        return true;
      },
      dispatch(_i, _m, _p, _r, ctx) {
        ctx.allowCancellation();
        return new Promise<void>(() => {});
      },
    };
    const { a, settle } = link(undefined, hang, { streamWindow: 1 << 20 });
    const client = a.bootstrap();
    await settle();
    const pending = client.callStreaming(IFACE, WRITE, chunk(1, 8), 1, 1) as Promise<void> & {
      cancel(): void;
    };
    await settle();
    const flow = (client.resolved() as ImportClient).flow;
    expect(flow.inFlight).toBeGreaterThan(0);
    const flushing = client.flush();
    pending.cancel();
    await settle();
    expect(flow.inFlight).toBe(0);
    await flushing;
    expect(flow.failed).toBe(false);
  });

  test("canceling a membraned remote stream frees the flow window", async () => {
    const hang: RpcServer = {
      isStreaming() {
        return true;
      },
      dispatch(_i, _m, _p, _r, ctx) {
        ctx.allowCancellation();
        return new Promise<void>(() => {});
      },
    };
    const { a, settle } = link(undefined, hang, { streamWindow: 1 << 20 });
    const client = a.bootstrap();
    await settle();
    const policy = new RevocablePolicy();
    const wrapped = membrane(client, policy);
    const pending = wrapped.callStreaming(IFACE, WRITE, chunk(1, 8), 1, 1) as Promise<void> & {
      cancel(): void;
    };
    const flow = (client.resolved() as ImportClient).flow;
    expect(flow.inFlight).toBeGreaterThan(0);
    // Cancel before the flow-control promise is observed, so Finish goes
    // out while the call is still in flight. Return.canceled must release
    // the window and let flush() finish.
    const flushing = client.flush();
    pending.cancel();
    await expect(pending).rejects.toThrow("canceled");
    await settle();
    expect(flow.inFlight).toBe(0);
    await flushing;
  });
});
