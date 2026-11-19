import { describe, expect, test } from "bun:test";
import type { Ptr, StructBuilder } from "@haozeke/capnp";

import {
  type CallContext,
  Client,
  RpcError,
  RpcStream,
  type RpcServer,
  Settle,
  WindowFlowController,
} from "../src/index.ts";
import { ImportClient } from "../src/remote.ts";
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

  test("after a failure every later send rejects and so does waitAllAcked", async () => {
    const flow = new WindowFlowController(() => 1000);
    const a = ack();
    void flow.send(10, a);
    a.reject(new RpcError("boom"));
    await expect(flow.send(10, ack())).rejects.toThrow("boom");
    await expect(flow.waitAllAcked()).rejects.toThrow("boom");
  });

  test("a sender blocked when a call fails is released with the failure", async () => {
    const flow = new WindowFlowController(() => 0);
    const a = ack();
    await flow.send(10, a);
    const blocked = flow.send(10, ack());
    a.reject(new RpcError("late"));
    await expect(blocked).rejects.toThrow("late");
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
    expect(results.slice(0, 3).every((r) => r.status === "fulfilled")).toBe(true);
    const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(failures.length).toBeGreaterThan(0);
    for (const f of failures) expect(f.reason).toMatchObject({ message: "disk full" });
    expect(results[results.length - 2]!.status).toBe("rejected");
    expect(results[results.length - 1]!.status).toBe("rejected");
    // After the failure the server did no more writes.
    expect(sink.writes).toEqual([0, 1, 2, 3]);
  });

  test("after a failure a further send is refused", async () => {
    const sink = new Sink(0, 0);
    const { stream, settle } = await openSink(sink, 1 << 20);
    void stream.send(IFACE, WRITE, chunk(0, 8), 1, 1).catch(() => {});
    await settle();
    await expect(stream.send(IFACE, WRITE, chunk(1, 8), 1, 1)).rejects.toThrow("disk full");
    await expect(stream.finish()).rejects.toThrow("disk full");
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
});
