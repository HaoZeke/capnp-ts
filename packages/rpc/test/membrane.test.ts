import { describe, expect, test } from "bun:test";
import type { Ptr, StructBuilder } from "@haozeke/capnp";

import {
  type CallContext,
  Client,
  copyIntoMembrane,
  copyOutOfMembrane,
  MembranePolicy,
  membrane,
  Payload,
  RevocablePolicy,
  reverseMembrane,
  RpcError,
  type RpcServer,
  LocalClient,
} from "../src/index.ts";
import { newNullCap } from "../src/capability.ts";
import { IFACE, link } from "./support.ts";

const arg = (n: number) => (p: StructBuilder) => p.setU32(0, n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Method 0 returns a new Counter capability. Method 1 returns the
 * capability it was passed. Method 2 calls the capability it was passed.
 */
class Hub implements RpcServer {
  made: Counter[] = [];
  held: Client | undefined;
  dispatch(
    _i: bigint,
    m: number,
    params: Ptr,
    results: StructBuilder,
    ctx: CallContext,
  ): void | Promise<void> {
    switch (m) {
      case 0: {
        const counter = new Counter();
        this.made.push(counter);
        ctx.setResultCap(ctx.initResults(0, 1), 0, Client.local(counter).hook);
        return;
      }
      case 1:
        ctx.setResultCap(ctx.initResults(0, 1), 0, ctx.getCap(params.getP(0)));
        return;
      case 2: {
        const cap = new Client(ctx.getCap(params.getP(0)));
        return cap.call(IFACE, 0, arg(params.getU32(0))).then((out) => {
          results.setU32(0, out.content.getU32(0));
          cap.release();
        });
      }
      case 3:
        this.held = new Client(ctx.getCap(params.getP(0)));
        return;
      default:
        results.setU32(0, m);
    }
  }
}

class Recorder extends MembranePolicy {
  inbound: string[] = [];
  outbound: string[] = [];
  redirects = new Map<number, Client>();
  failMethod = -1;
  private reject!: (e: Error) => void;
  private readonly revocation = new Promise<never>((_, r) => (this.reject = r));
  constructor(private readonly withRevocation = false) {
    super();
    this.revocation.catch(() => {});
  }
  revoke(e: Error): void {
    this.reject(e);
  }
  inboundCall(_i: bigint, m: number, _target: Client): Client | undefined {
    this.inbound.push(`m${m}`);
    if (m === this.failMethod) throw new RpcError("policy says no");
    return this.redirects.get(m)?.dup();
  }
  outboundCall(_i: bigint, m: number, _target: Client): Client | undefined {
    this.outbound.push(`m${m}`);
    return undefined;
  }
  override onRevoked(): Promise<never> | undefined {
    return this.withRevocation ? this.revocation : undefined;
  }
}

const capIn = (hook: Client) => (p: StructBuilder, b: { setCap(s: StructBuilder, i: number, h: unknown): void }) =>
  b.setCap(p, 0, hook.hook.addRef());

describe("membrane", () => {
  test("a call crosses, and the capability it returns is wrapped", async () => {
    const hub = new Hub();
    const policy = new Recorder();
    const outside = membrane(Client.local(hub), policy);
    const reply = await outside.call(IFACE, 0, undefined, 0, 0);
    const counter = new Client(reply.getCap(reply.content.getP(0)));
    expect(policy.inbound).toEqual(["m0"]);

    const out = await counter.call(IFACE, 0, arg(4));
    expect(out.content.getU32(0)).toBe(5);
    // The returned capability went through the policy too.
    expect(policy.inbound).toEqual(["m0", "m0"]);
    expect(hub.made[0]!.seen).toEqual([4]);
  });

  test("a capability passed in is wrapped so calls on it are outbound", async () => {
    const hub = new Hub();
    const policy = new Recorder();
    const outside = membrane(Client.local(hub), policy);
    const mine = new Counter();
    const out = await outside.call(IFACE, 2, (p, b) => {
      p.setU32(0, 8);
      capIn(Client.local(mine))(p, b);
    }, 1, 1);
    expect(out.content.getU32(0)).toBe(9);
    expect(mine.seen).toEqual([8]);
    expect(policy.outbound).toEqual(["m0"]);
  });

  test("a capability that passes through and comes back is the original", async () => {
    const hub = new Hub();
    const policy = new Recorder();
    const outside = membrane(Client.local(hub), policy);
    const mine = Client.local(new Counter());
    const reply = await outside.call(IFACE, 1, capIn(mine), 0, 1);
    const back = reply.getCap(reply.content.getP(0));
    // Not wrapped twice: it is the very object that went in.
    expect(back).toBe(mine.hook);
  });

  test("an inside capability handed out and passed back in is the original", async () => {
    const hub = new Hub();
    const policy = new Recorder();
    const outside = membrane(Client.local(hub), policy);
    const first = await outside.call(IFACE, 0, undefined, 0, 0);
    const wrapper = new Client(first.getCap(first.content.getP(0)));
    // Hand the wrapper back in; the hub gets the Counter, not a proxy.
    const again = await outside.call(IFACE, 1, capIn(wrapper), 0, 1);
    const returned = again.getCap(again.content.getP(0));
    expect(returned).toBe(wrapper.hook);
    await outside.call(IFACE, 3, capIn(wrapper), 0, 1);
    const held = hub.held!.hook as LocalClient;
    expect(held.server).toBe(hub.made[0]!);
  });

  test("the same capability crossing twice gets one wrapper", async () => {
    const hub = new Hub();
    const policy = new Recorder();
    const outside = membrane(Client.local(hub), policy);
    const mine = Client.local(new Counter());
    // Send the outside capability in twice; the hub sees one object.
    await outside.call(IFACE, 3, capIn(mine), 0, 1);
    const first = hub.held!.hook;
    await outside.call(IFACE, 3, capIn(mine), 0, 1);
    expect(hub.held!.hook).toBe(first);
  });

  test("null capabilities cross unwrapped", async () => {
    const policy = new Recorder();
    const hub = new Hub();
    const outside = membrane(Client.local(hub), policy);
    const reply = await outside.call(IFACE, 1, undefined, 0, 1);
    expect(reply.getCap(reply.content.getP(0)).brokenError?.message).toContain("null capability");
    expect(newNullCap().brokenError).toBeDefined();
  });

  test("the policy can redirect a call", async () => {
    const hub = new Hub();
    const policy = new Recorder();
    const stand = new Counter();
    policy.redirects.set(7, Client.local(stand));
    const outside = membrane(Client.local(hub), policy);
    const out = await outside.call(IFACE, 7, arg(1));
    expect(out.content.getU32(0)).toBe(2);
    expect(stand.seen).toEqual([1]);
    expect(hub.made.length).toBe(0);
  });

  test("the policy can fail a call", async () => {
    const policy = new Recorder();
    policy.failMethod = 9;
    const outside = membrane(Client.local(new Hub()), policy);
    await expect(Promise.resolve(outside.call(IFACE, 9))).rejects.toThrow("policy says no");
  });
});

describe("revocation", () => {
  test("after revoke every capability across the membrane fails", async () => {
    const hub = new Hub();
    const policy = new Recorder(true);
    const outside = membrane(Client.local(hub), policy);
    const reply = await outside.call(IFACE, 0, undefined, 0, 0);
    const counter = new Client(reply.getCap(reply.content.getP(0)));
    expect((await counter.call(IFACE, 0, arg(1))).content.getU32(0)).toBe(2);

    policy.revoke(new RpcError("access withdrawn"));
    await sleep(1);
    await expect(Promise.resolve(counter.call(IFACE, 0, arg(1)))).rejects.toThrow("access withdrawn");
    await expect(Promise.resolve(outside.call(IFACE, 0))).rejects.toThrow("access withdrawn");
    expect(counter.isBroken).toBe(true);
    expect(outside.isBroken).toBe(true);
  });

  test("a streaming call in flight is canceled when the membrane is revoked", async () => {
    let canceled = false;
    const slow: RpcServer = {
      isStreaming() {
        return true;
      },
      dispatch(_i, _m, _p, _r, ctx) {
        ctx.allowCancellation();
        ctx.signal.addEventListener("abort", () => {
          canceled = true;
        });
        return new Promise<void>(() => {});
      },
    };
    const policy = new RevocablePolicy();
    const outside = membrane(Client.local(slow), policy);
    const pending = outside.callStreaming(IFACE, 0);
    policy.revoke(new RpcError("pulled"));
    await expect(pending).rejects.toThrow("pulled");
    expect(canceled).toBe(true);
  });

  test("releasing the membrane releases the capability inside", () => {
    const inside = new Counter();
    const policy = new RevocablePolicy();
    const outside = membrane(Client.local(inside), policy);
    expect(inside.disposed).toBe(0);
    expect(policy.wrappers.size).toBe(1);
    outside.release();
    expect(inside.disposed).toBe(1);
    expect(policy.wrappers.size).toBe(0);
  });

  test("a call in flight is canceled with the revocation error", async () => {
    let canceled = false;
    const slow: RpcServer = {
      dispatch(_i, _m, _p, _r, ctx) {
        ctx.allowCancellation();
        ctx.signal.addEventListener("abort", () => (canceled = true));
        return new Promise<void>(() => {});
      },
    };
    const policy = new Recorder(true);
    const outside = membrane(Client.local(slow), policy);
    const pending = outside.call(IFACE, 0);
    policy.revoke(new RpcError("pulled"));
    await expect(Promise.resolve(pending)).rejects.toThrow("pulled");
    expect(canceled).toBe(true);
  });

  test("revoking drops the capability inside", async () => {
    const inside = new Counter();
    const policy = new RevocablePolicy();
    const outside = membrane(Client.local(inside), policy);
    await outside.call(IFACE, 0, arg(1));
    expect(inside.disposed).toBe(0);
    policy.revoke("done");
    await sleep(1);
    expect(inside.disposed).toBe(1);
    await expect(Promise.resolve(outside.call(IFACE, 0, arg(1)))).rejects.toThrow("done");
  });

  test("a capability returned through the membrane is revoked with it", async () => {
    const hub = new Hub();
    const policy = new RevocablePolicy();
    const outside = membrane(Client.local(hub), policy);
    const reply = await outside.call(IFACE, 0, undefined, 0, 0);
    const counter = new Client(reply.getCap(reply.content.getP(0)));
    policy.revoke("closed");
    await sleep(1);
    await expect(Promise.resolve(counter.call(IFACE, 0, arg(1)))).rejects.toThrow("closed");
  });
});

describe("membranes and promises", () => {
  test("a promise inside the membrane resolves to a wrapped capability", async () => {
    const target = new Counter();
    let resolve!: (c: Client) => void;
    const promise = Client.fromPromise(new Promise<Client>((r) => (resolve = r)));
    const policy = new Recorder();
    const outside = membrane(promise, policy);
    const early = outside.call(IFACE, 0, arg(1));
    resolve(Client.local(target));
    expect((await early).content.getU32(0)).toBe(2);
    await outside.whenResolved();
    expect(policy.inbound.length).toBeGreaterThanOrEqual(1);
    expect((await outside.call(IFACE, 0, arg(2))).content.getU32(0)).toBe(3);
  });

  test("shouldResolveBeforeRedirecting waits for the promise before redirecting", async () => {
    const stand = new Counter();
    const target = new Counter();
    let resolve!: (c: Client) => void;
    const promise = Client.fromPromise(new Promise<Client>((r) => (resolve = r)));
    class Waiting extends Recorder {
      override shouldResolveBeforeRedirecting(): boolean {
        return true;
      }
    }
    const policy = new Waiting();
    policy.redirects.set(0, Client.local(stand));
    const outside = membrane(promise, policy);
    const call = outside.call(IFACE, 0, arg(1));
    await sleep(1);
    // Not redirected yet: the promise might resolve outside the membrane.
    expect(stand.seen).toEqual([]);
    resolve(Client.local(target));
    expect((await call).content.getU32(0)).toBe(2);
    expect(stand.seen).toEqual([1]);
  });
});

describe("reverse membranes and copying", () => {
  test("a reverse membrane sends calls through outboundCall", async () => {
    const policy = new Recorder();
    const target = new Counter();
    const inside = reverseMembrane(Client.local(target), policy);
    await inside.call(IFACE, 0, arg(3));
    expect(policy.outbound).toEqual(["m0"]);
    expect(policy.inbound).toEqual([]);
  });

  test("copyIntoMembrane and copyOutOfMembrane wrap what they carry", async () => {
    const policy = new Recorder();
    const hub = new Hub();
    const reply = await Client.local(hub).call(IFACE, 0, undefined, 0, 0);
    const plain = reply.getCap(reply.content.getP(0));

    const out = copyOutOfMembrane(reply, policy);
    expect(out.caps[0]).not.toBe(reply.caps[0]);
    const wrapped = new Client(out.getCap(out.content.getP(0)));
    await wrapped.call(IFACE, 0, arg(1));
    expect(policy.inbound).toEqual(["m0"]);

    const inn = copyIntoMembrane(new Payload(reply.content, [reply.caps[0]!.addRef()]), policy);
    const imported = new Client(inn.getCap(inn.content.getP(0)));
    await imported.call(IFACE, 0, arg(2));
    expect(policy.outbound).toEqual(["m0"]);
    plain.release();
  });
});

describe("membranes over a connection", () => {
  test("a membrane around an import revokes calls in flight across the wire", async () => {
    let canceled = false;
    const slow: RpcServer = {
      dispatch(_i, _m, _p, _r, ctx) {
        ctx.allowCancellation();
        ctx.signal.addEventListener("abort", () => (canceled = true));
        return new Promise<void>(() => {});
      },
    };
    const { a, settle, ta } = link(undefined, slow);
    const policy = new RevocablePolicy();
    const outside = membrane(a.bootstrap(), policy);
    const pending = outside.call(IFACE, 0);
    await settle();
    policy.revoke("remote access withdrawn");
    await settle();
    await expect(Promise.resolve(pending)).rejects.toThrow("remote access withdrawn");
    expect(ta.sent).toContain("finish");
    expect(canceled).toBe(true);
  });

  test("a local capability sent across a membraned import comes back as itself", async () => {
    const echo: RpcServer = {
      dispatch(_i, _m, params, _r, ctx) {
        ctx.setResultCap(ctx.initResults(0, 1), 0, ctx.getCap(params.getP(0)));
      },
    };
    const { a, settle } = link(undefined, echo);
    const policy = new Recorder();
    const outside = membrane(a.bootstrap(), policy);
    const mine = Client.local(new Counter());
    const reply = outside.call(IFACE, 0, capIn(mine), 0, 1);
    await settle();
    const results = await reply;
    expect(results.getCap(results.content.getP(0))).toBe(mine.hook);
  });
});

describe("membrane C++ semantics", () => {
  test("a resolved promise pointing outside bypasses inboundCall", async () => {
    const hub = new Hub();
    const stand = new Counter();
    class Intercepting extends Recorder {
      override shouldResolveBeforeRedirecting(): boolean {
        return true;
      }
    }
    const policy = new Intercepting();
    policy.redirects.set(0, Client.local(stand));
    const outside = membrane(Client.local(hub), policy);
    const mine = new Counter();
    // Loop an outside capability through the membrane via a pipelined promise.
    const looped = outside.call(IFACE, 1, capIn(Client.local(mine)), 0, 1).pipeline(0);
    await looped.whenResolved();
    const out = await looped.call(IFACE, 0, arg(10));
    expect(out.content.getU32(0)).toBe(11);
    expect(mine.seen).toEqual([10]);
    expect(stand.seen).toEqual([]);
  });

  test("child policies sharing one rootPolicy keep distinct wrappers", async () => {
    const root = new Recorder();
    class ChildPolicy extends Recorder {
      override rootPolicy(): MembranePolicy {
        return root;
      }
    }
    const childA = new ChildPolicy();
    const childB = new ChildPolicy();
    const target = Client.local(new Counter());
    const wrapA = membrane(target.dup(), childA);
    const wrapB = membrane(target.dup(), childB);
    expect(wrapA.hook).not.toBe(wrapB.hook);
    await wrapA.call(IFACE, 0, arg(1));
    await wrapB.call(IFACE, 0, arg(2));
    expect(childA.inbound).toEqual(["m0"]);
    expect(childB.inbound).toEqual(["m0"]);
    // Crossing back through childB unwraps what childA exported.
    const unwrapped = reverseMembrane(wrapA, childB);
    expect(unwrapped.hook).toBe(target.hook);
    unwrapped.release();
    wrapB.release();
    target.release();
  });

  test("whenMoreResolved rejects if the membrane is revoked first", async () => {
    const never = Client.fromPromise(new Promise<Client>(() => {}));
    const policy = new RevocablePolicy();
    const outside = membrane(never, policy);
    const waiting = outside.whenResolved();
    policy.revoke("cut");
    await expect(waiting).rejects.toThrow("cut");
    await expect(outside.flush()).rejects.toThrow("cut");
  });

  test("inboundCall still runs after revocation with a broken target", async () => {
    const seenBroken: boolean[] = [];
    class SpyRevocable extends RevocablePolicy {
      override inboundCall(_i: bigint, _m: number, target: Client): Client | undefined {
        seenBroken.push(target.isBroken);
        return undefined;
      }
    }
    const policy = new SpyRevocable();
    const outside = membrane(Client.local(new Counter()), policy);
    policy.revoke("revoked now");
    await sleep(1);
    await expect(Promise.resolve(outside.call(IFACE, 0, arg(1)))).rejects.toThrow("revoked now");
    expect(seenBroken).toEqual([true]);
  });

  test("wrapping after revocation rejects synchronously without calling inside", async () => {
    const inside = new Counter();
    const policy = new RevocablePolicy();
    const first = membrane(Client.local(new Counter()), policy);
    policy.revoke("already revoked");
    await sleep(1);
    const second = membrane(Client.local(inside), policy);
    await expect(Promise.resolve(second.call(IFACE, 0, arg(1)))).rejects.toThrow("already revoked");
    expect(inside.seen).toEqual([]);
    first.release();
    second.release();
  });

  test("disposing a wrapper unregisters its revocation watcher", async () => {
    const policy = new RevocablePolicy();
    const outside = membrane(Client.local(new Counter()), policy);
    expect(policy.revocationWatcherCount()).toBe(1);
    outside.release();
    expect(policy.revocationWatcherCount()).toBe(0);

    const still = membrane(Client.local(new Counter()), policy);
    expect(policy.revocationWatcherCount()).toBe(1);
    policy.revoke("done");
    await sleep(1);
    expect(still.isBroken).toBe(true);
    expect(policy.revocationWatcherCount()).toBe(0);
    still.release();
  });

  test("revoking the outer membrane cancels a stream inside a nested one", async () => {
    let aborted = false;
    const slow: RpcServer = {
      isStreaming() {
        return true;
      },
      dispatch(_i, _m, _p, _r, ctx) {
        ctx.allowCancellation();
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<void>(() => {});
      },
    };
    const outer = new RevocablePolicy();
    const inner = new RevocablePolicy();
    const wrapped = membrane(membrane(Client.local(slow), inner), outer);
    const pending = wrapped.callStreaming(IFACE, 0);
    outer.revoke(new RpcError("outer"));
    await expect(pending).rejects.toThrow("outer");
    expect(aborted).toBe(true);
  });

  test("canceling a membrane stream cancels the call inside", async () => {
    let aborted = false;
    const slow: RpcServer = {
      isStreaming() {
        return true;
      },
      dispatch(_i, _m, _p, _r, ctx) {
        ctx.allowCancellation();
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<void>(() => {});
      },
    };
    const policy = new RevocablePolicy();
    const wrapped = membrane(Client.local(slow), policy);
    const pending = wrapped.callStreaming(IFACE, 0) as Promise<void> & { cancel(): void };
    pending.cancel();
    await expect(pending).rejects.toThrow("canceled");
    expect(aborted).toBe(true);
  });
});
