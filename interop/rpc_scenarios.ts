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

import { Client, RpcError, type RpcConnection } from "../packages/rpc/src/index.ts";
import {
  attach,
  COUNTER_INTERFACE_ID,
  CounterImpl,
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

  async disconnect() {
    const pending = echo(M.slow);
    await u32(echo(M.ping, arg(0), 1, 0));
    const dying = echo(M.die);
    await assert.rejects(Promise.resolve(dying), (e: RpcError) => e.type === "disconnected");
    await assert.rejects(Promise.resolve(pending), (e: RpcError) => e.type === "disconnected");
    await assert.rejects(Promise.resolve(echo(M.ping, arg(1), 1, 0)), (e: RpcError) => e.type === "disconnected");
    assert.ok(conn.disconnected);
  },
};

let failed = false;
for (const [name, run] of Object.entries(scenarios)) {
  if (only.length > 0 && !only.includes(name)) continue;
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
