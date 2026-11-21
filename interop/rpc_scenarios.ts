/**
 * Live-peer RPC scenarios: this vat as the client of capnp-C++'s Echo.
 *
 * Each scenario checks the behaviour a C++ peer shows for the same
 * interaction: pipelining, promise resolution, release, cancellation,
 * embargo, exceptions, broken capabilities and loss of the connection.
 */
import { connect, type Socket } from "node:net";
import { strict as assert } from "node:assert";
import type { StructBuilder } from "@haozeke/capnp";

import {
  Client,
  membrane,
  MemoryTransportPair,
  savePersistent,
  RevocablePolicy,
  RpcConnection,
  RpcError,
  RpcStream,
} from "../packages/rpc/src/index.ts";
import type { ImportClient } from "../packages/rpc/src/remote.ts";
import {
  attach,
  COUNTER_INTERFACE_ID,
  CounterImpl,
  SINK_INTERFACE_ID,
  Sink_methods,
  KEEP_INTERFACE_ID,
  Echo_methods as M,
  ECHO_INTERFACE_ID,
} from "./rpc_common.ts";

const port = Number(process.argv[2] ?? 43118);
const only = process.argv.slice(3);

function dial(attempts: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const attempt = (left: number) => {
      const sock = connect({ host: "127.0.0.1", port });
      sock.setNoDelay(true);
      sock.once("connect", () => resolve(sock));
      sock.once("error", (e) => {
        sock.destroy();
        if (left <= 0) reject(e);
        else setTimeout(() => attempt(left - 1), 50);
      });
    };
    attempt(attempts);
  });
}

const sock = await dial(100);
const conn: RpcConnection = attach(sock);
const boot = conn.bootstrap();

const arg = (n: number) => (p: StructBuilder) => p.setU32(0, n);
const echo = (m: { ordinal: number }, fill?: (p: StructBuilder, b: never) => void, dw = 0, pw = 0) =>
  boot.call(ECHO_INTERFACE_ID, m.ordinal, fill as never, dw, pw);
const inc = (c: Client, n: number) => c.call(COUNTER_INTERFACE_ID, 0, arg(n), 1, 0);
const u32 = async (p: PromiseLike<{ content: { getU32(o: number): number } }>, off = 0) =>
  (await p).content.getU32(off);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const scenarios: Record<string, () => Promise<void>> = {
  async ping() {
    assert.equal(await u32(echo(M.ping, arg(41), 1, 0)), 42);
  },

  async pipeline() {
    // The Counter is addressed before makeCounter has answered.
    const counter = echo(M.makeCounter).pipeline(0);
    assert.equal(await u32(inc(counter, 1)), 2);
    counter.release();
  },

  async hints() {
    // capnp-C++ keeps a pipeline-only answer without sending its Return.
    const only = boot.call(ECHO_INTERFACE_ID, M.makeCounter.ordinal, undefined, 0, 0, {
      onlyPromisePipeline: true,
    });
    const counter = only.pipeline(0);
    assert.equal(await u32(inc(counter, 1)), 2);
    counter.release();
    only.release();
    assert.equal((conn as unknown as { gotReturnForHighQuestionId: boolean }).gotReturnForHighQuestionId, false);
    const plain = boot.call(ECHO_INTERFACE_ID, M.ping.ordinal, arg(1), 1, 0, { noPromisePipelining: true });
    assert.equal(await u32(plain), 2);
    assert.ok(plain.pipeline(0).isBroken);
  },

  async tailhint() {
    // A vat in between tail-calls the C++ peer for a call that only
    // pipelines; capnp-C++ `directTailCall` would use `sendForPipeline()`.
    const pair = new MemoryTransportPair();
    const middle = new RpcConnection(pair.b, {
      dispatch(_i, _m, _p, _r, ctx) {
        return ctx.tailCall(boot, ECHO_INTERFACE_ID, M.makeCounter.ordinal, undefined, 0, 0);
      },
    });
    const caller = new RpcConnection(pair.a);
    const tick = setInterval(() => {
      caller.pump();
      middle.pump();
    }, 1);
    const peer = conn as unknown as { nextHighQuestionId: number; gotReturnForHighQuestionId: boolean };
    const highBefore = peer.nextHighQuestionId;
    try {
      const front = caller.bootstrap();
      const only = front.call(ECHO_INTERFACE_ID, M.makeCounter.ordinal, undefined, 0, 0, {
        onlyPromisePipeline: true,
      });
      const counter = only.pipeline(0);
      assert.equal(await u32(inc(counter, 1)), 2);
      assert.equal(peer.nextHighQuestionId, highBefore + 1, "the tail call was not pipeline-only");
      await u32(echo(M.ping, arg(0), 1, 0));
      assert.equal(peer.gotReturnForHighQuestionId, false);
      counter.release();
      only.release();
      front.release();
    } finally {
      clearInterval(tick);
    }
  },

  async named() {
    // capnp-C++ `EzRpcServer` looks a named Bootstrap up in its export map.
    const missing = conn.restore("nope");
    await assert.rejects(Promise.resolve(inc(missing, 1)), /Server exports no such capability\.; name = nope/);
    missing.release();
  },

  async nullpipeline() {
    // Pipelining onto a null capability must fail cleanly without sending a
    // Disembargo that would make capnp-C++ abort the connection.
    const missing = echo(M.echoCap, undefined, 0, 1).pipeline(0);
    await assert.rejects(Promise.resolve(inc(missing, 1)));
    assert.equal(await u32(echo(M.ping, arg(10), 1, 0)), 11);
    missing.release();
  },

  async promise() {
    const reply = echo(M.makePromise);
    const results = await reply;
    const counter = new Client(results.getCap(results.content.getP(0)));
    const early = inc(counter, 5);
    await u32(echo(M.resolveLater));
    assert.equal(await u32(early), 6);
    await counter.whenResolved();
    assert.equal(await u32(inc(counter, 7)), 8);
    counter.release();
  },

  async exception() {
    try {
      await echo(M.fail);
      assert.fail("fail() did not fail");
    } catch (e) {
      assert.ok(e instanceof RpcError, String(e));
      assert.equal((e as RpcError).type, "overloaded");
      assert.match((e as RpcError).message, /busy on purpose/);
    }
  },

  async broken() {
    const results = await echo(M.brokenCap);
    const cap = new Client(results.getCap(results.content.getP(0)));
    await assert.rejects(Promise.resolve(inc(cap, 1)), /broken on purpose/);
  },

  async callback() {
    const mine = new CounterImpl();
    const out = echo(
      M.callBack,
      ((p: StructBuilder, b: { setCap(s: StructBuilder, i: number, h: unknown): void }) => {
        p.setU32(0, 4);
        b.setCap(p, 0, Client.local(mine).hook);
      }) as never,
      1,
      1,
    );
    assert.equal(await u32(out), 5);
    assert.deepEqual(mine.seen, [4]);
  },

  async echocap() {
    const mine = new CounterImpl();
    const local = Client.local(mine);
    const out = echo(
      M.echoCap,
      ((p: StructBuilder, b: { setCap(s: StructBuilder, i: number, h: unknown): void }) =>
        b.setCap(p, 0, local.hook.addRef())) as never,
      0,
      1,
    );
    const results = await out;
    const back = results.getCap(results.content.getP(0));
    // The peer sent our own capability back, so it is the local object.
    assert.equal(back.brand, local.hook.brand);
    await u32(new Client(back).call(COUNTER_INTERFACE_ID, 0, arg(3), 1, 0));
    assert.deepEqual(mine.seen, [3]);
  },

  async release() {
    const before = await echo(M.stats);
    const base = before.content.getU32(4);
    // The server keeps the answer, and what it holds, until Finish.
    const reply = echo(M.makeCounter);
    const results = await reply;
    const counter = new Client(results.getCap(results.content.getP(0)));
    await inc(counter, 1);
    counter.release();
    reply.release();
    let released = base;
    for (let i = 0; i < 50 && released === base; i++) {
      await wait(10);
      released = (await echo(M.stats)).content.getU32(4);
    }
    assert.equal(released, base + 1);
  },

  async cancel() {
    const pending = echo(M.slow);
    await u32(echo(M.ping, arg(0), 1, 0));
    pending.release();
    let cancelled = 0;
    for (let i = 0; i < 50 && cancelled === 0; i++) {
      await wait(10);
      cancelled = (await echo(M.stats)).content.getU32(0);
    }
    assert.equal(cancelled, 1);
    await u32(echo(M.unblock));
  },

  async uncancelable() {
    const before = (await echo(M.stats)).content.getU32(8);
    const pending = echo(M.slowUncancelable);
    await u32(echo(M.ping, arg(0), 1, 0));
    pending.release();
    await u32(echo(M.unblock));
    let done = before;
    for (let i = 0; i < 50 && done === before; i++) {
      await wait(10);
      done = (await echo(M.stats)).content.getU32(8);
    }
    assert.equal(done, before + 1, "a call that cannot be canceled must still complete");
  },

  async embargo() {
    const order: number[] = [];
    const mine = new CounterImpl((n) => order.push(n));
    await echo(
      M.hold,
      ((p: StructBuilder, b: { setCap(s: StructBuilder, i: number, h: unknown): void }) =>
        b.setCap(p, 0, Client.local(mine).hook)) as never,
      0,
      1,
    );
    const results = await echo(M.promiseOfHeld);
    const promise = new Client(results.getCap(results.content.getP(0)));
    const first = inc(promise, 1);
    await u32(echo(M.resolveHeld));
    await promise.whenResolved();
    const second = inc(promise, 2);
    await Promise.all([first, second]);
    assert.deepEqual(order, [1, 2], "calls through a resolving promise reordered");
  },

  async stream() {
    const results = await echo(
      M.openSink,
      ((p: StructBuilder) => p.setU32(0, 0)) as never,
      1,
      0,
    );
    const sink = new Client(results.getCap(results.content.getP(0)));
    const stream = new RpcStream(sink);
    const block = new Uint8Array(4096).fill(7);
    const writes = 500;
    for (let i = 0; i < writes; i++) {
      await stream.send(
        SINK_INTERFACE_ID,
        Sink_methods.write.ordinal,
        (p) => p.setData(0, block),
        0,
        1,
      );
    }
    await stream.finish();
    const total = await sink.call(SINK_INTERFACE_ID, Sink_methods.done.ordinal, undefined, 0, 0);
    assert.equal(total.content.getU64(0), BigInt(writes * block.length));

    // The sender paced itself to the receiver rather than queueing 2 MB.
    const flow = (sink.resolved() as ImportClient).flow;
    assert.ok(flow.waits > 0, "the window never filled");
    assert.ok(flow.peakInFlight <= conn.streamWindow + 2 * 4200, `peak ${flow.peakInFlight}`);
    sink.release();
  },

  async streamfail() {
    const results = await echo(
      M.openSink,
      ((p: StructBuilder) => p.setU32(0, 10)) as never,
      1,
      0,
    );
    const sink = new Client(results.getCap(results.content.getP(0)));
    const stream = new RpcStream(sink);
    let failure: unknown;
    try {
      for (let i = 0; i < 200 && failure === undefined; i++) {
        await stream.send(
          SINK_INTERFACE_ID,
          Sink_methods.write.ordinal,
          (p) => p.setData(0, new Uint8Array(64)),
          0,
          1,
        );
        if (i % 20 === 19) await wait(10);
      }
    } catch (e) {
      failure = e;
    }
    assert.ok(failure instanceof RpcError, "writes kept succeeding after the sink failed");
    assert.match((failure as RpcError).message, /sink full/);
    assert.equal((failure as RpcError).type, "overloaded");
    await stream.finish();
    await assert.rejects(
      Promise.resolve(sink.call(SINK_INTERFACE_ID, Sink_methods.done.ordinal, undefined, 0, 0)),
      /sink full/,
    );
    sink.release();
  },

  async pipelinedstream() {
    // Stream through a pipelined Sink before openSink resolves; errors must
    // survive PromiseClient resolution onto the ImportClient.
    const sink = echo(
      M.openSink,
      ((p: StructBuilder) => p.setU32(0, 3)) as never,
      1,
      0,
    ).pipeline(0);
    const stream = new RpcStream(sink);
    const sends = Array.from({ length: 12 }, () =>
      stream.send(
        SINK_INTERFACE_ID,
        Sink_methods.write.ordinal,
        (p) => p.setData(0, new Uint8Array(64)),
        0,
        1,
      ),
    );
    await Promise.allSettled(sends);
    await stream.finish();
    await assert.rejects(
      stream.send(
        SINK_INTERFACE_ID,
        Sink_methods.write.ordinal,
        (p) => p.setData(0, new Uint8Array(64)),
        0,
        1,
      ),
      /sink full/,
    );
    sink.release();
  },

  async persistent() {
    // Level 2 as capnp-C++ has it: the Persistent interface, saved by the app.
    const opened = await echo(M.openKeep);
    const keep = new Client(opened.getCap(opened.content.getP(0)));
    assert.equal(
      await u32(keep.call(KEEP_INTERFACE_ID, 0, undefined, 0, 0)),
      7,
    );
    const saved = await savePersistent(keep, (p) => p.setText(0, "bob"));
    assert.equal(saved.content.getText(0), "ref-for-bob");
    keep.release();
  },

  async levels() {
    // capnp-C++ implements neither the level 3 handoff nor level 4 Join, and
    // answers them Unimplemented.
    const provide = conn.sendProvide(0, { vineId: 0, host: "127.0.0.1", port: 1 }, 5n);
    const accept = conn.sendAccept(6n);
    const join = conn.sendJoin(0, 1, 1, 0);
    for (let i = 0; i < 50 && !(conn.isAnswered(provide) && conn.isAnswered(accept) && conn.isAnswered(join)); i++) {
      await wait(10);
    }
    for (const [name, q] of [["provide", provide], ["accept", accept], ["join", join]] as const) {
      assert.ok(conn.isFailed(q), `${name} did not fail`);
      assert.equal(conn.answerError(q)?.type, "unimplemented", `${name}: ${conn.answerError(q)?.message}`);
    }
  },

  async membrane() {
    // A membrane around the C++ peer's bootstrap capability.
    const policy = new RevocablePolicy();
    const outside = membrane(boot.dup(), policy);
    const call = (c: Client, m: { ordinal: number }, fill?: (p: StructBuilder) => void, dw = 0, pw = 0) =>
      c.call(ECHO_INTERFACE_ID, m.ordinal, fill as never, dw, pw);

    assert.equal(await u32(call(outside, M.ping, arg(1), 1, 0)), 2);

    // A capability that comes back through the wire is the original.
    const mine = Client.local(new CounterImpl());
    const echoed = await call(
      outside,
      M.echoCap,
      ((p: StructBuilder, b: { setCap(s: StructBuilder, i: number, h: unknown): void }) =>
        b.setCap(p, 0, mine.hook.addRef())) as never,
      0,
      1,
    );
    assert.equal(echoed.getCap(echoed.content.getP(0)), mine.hook);

    // A capability the peer returns is behind the membrane too.
    const made = await call(outside, M.makeCounter);
    const counter = new Client(made.getCap(made.content.getP(0)));
    assert.equal(await u32(inc(counter, 1)), 2);

    // Revocation cancels what is in flight, across the wire, and cuts
    // every capability that came through.
    const before = (await echo(M.stats)).content.getU32(0);
    const pending = call(outside, M.slow);
    await u32(echo(M.ping, arg(0), 1, 0));
    policy.revoke("access withdrawn");
    await assert.rejects(Promise.resolve(pending), /access withdrawn/);
    await assert.rejects(Promise.resolve(inc(counter, 2)), /access withdrawn/);
    await assert.rejects(Promise.resolve(call(outside, M.ping, arg(1), 1, 0)), /access withdrawn/);
    let cancelled = before;
    for (let i = 0; i < 50 && cancelled === before; i++) {
      await wait(10);
      cancelled = (await echo(M.stats)).content.getU32(0);
    }
    assert.equal(cancelled, before + 1, "the peer never saw the revoked call canceled");
    await u32(echo(M.unblock));
    // The peer is still usable through the unwrapped capability.
    assert.equal(await u32(echo(M.ping, arg(5), 1, 0)), 6);
  },

  async disconnect() {
    const pending = echo(M.slow);
    await u32(echo(M.ping, arg(0), 1, 0));
    const dying = echo(M.die);
    await assert.rejects(Promise.resolve(dying), (e: RpcError) => e.type === "disconnected");
    await assert.rejects(Promise.resolve(pending), (e: RpcError) => e.type === "disconnected");
    await assert.rejects(Promise.resolve(echo(M.ping, arg(1), 1, 0)), (e: RpcError) => e.type === "disconnected");
    assert.ok(conn.disconnected);
  },

  // Against interop/raw_server.ts only: makeCounter's results name a
  // capability the cap table cannot give.
  async returncaps() {
    const outcome = async (f: () => unknown): Promise<string> => {
      try {
        await f();
        return "ok";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    const call = echo(M.makeCounter);
    const early = outcome(() => inc(call.pipeline(0), 1));
    const results = await call;
    console.log(`read: ${await outcome(() => results.getCap(results.content.getP(0)))}`);
    console.log(`after: ${await outcome(() => inc(call.pipeline(0), 2))}`);
    console.log(`early: ${await early}`);
  },
};

const explicitOnly = new Set(["returncaps"]);

let failed = false;
for (const [name, run] of Object.entries(scenarios)) {
  if (only.length > 0 ? !only.includes(name) : explicitOnly.has(name)) continue;
  try {
    await run();
    console.log(`ok ${name}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL ${name}: ${e instanceof Error ? e.stack : e}`);
    break;
  }
}
sock.destroy();
if (failed) process.exit(1);
console.log("All rpc scenarios passed.");
process.exit(0);
