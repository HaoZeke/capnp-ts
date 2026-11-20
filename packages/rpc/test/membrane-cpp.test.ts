/**
 * Port of capnp-C++'s `c++/src/capnp/membrane-test.c++` (v1.4.0).
 *
 * Exercises every local, copyOutOfMembrane, concurrent-resolution, remote
 * RPC, tail-call and revocation case from the reference membrane test suite.
 */
import { describe, expect, test } from "bun:test";
import type { Ptr, StructBuilder } from "@haozeke/capnp";

import {
  CallBuilder,
  type CallContext,
  Client,
  copyOutOfMembrane,
  MembranePolicy,
  membrane,
  RpcError,
  type RpcServer,
} from "../src/index.ts";
import { link } from "./support.ts";

const THING_IFACE = 0x9001n;
const THING_PASS_THROUGH = 0;
const THING_INTERCEPT = 1;

const MEMBRANE_IFACE = 0x9002n;
const M_MAKE_THING = 0;
const M_CALL_PASS_THROUGH = 1;
const M_CALL_INTERCEPT = 2;
const M_LOOPBACK = 3;
const M_WAIT_FOREVER = 4;

class ThingImpl implements RpcServer {
  constructor(private readonly text: string) {}
  dispatch(_i: bigint, m: number, _p: Ptr, _r: StructBuilder, ctx: CallContext): void {
    if (m === THING_PASS_THROUGH || m === THING_INTERCEPT) {
      ctx.initResults(0, 1).setText(0, this.text);
      return;
    }
    throw new RpcError(`Thing: unknown method ${m}`, "unimplemented");
  }
}

class TestMembraneImpl implements RpcServer {
  dispatch(
    _i: bigint,
    m: number,
    params: Ptr,
    _r: StructBuilder,
    ctx: CallContext,
  ): void | Promise<void> {
    switch (m) {
      case M_MAKE_THING:
        ctx.setResultCap(ctx.initResults(0, 1), 0, Client.local(new ThingImpl("inside")).hook);
        return;
      case M_CALL_PASS_THROUGH: {
        const thing = new Client(ctx.getCap(params.getP(0)));
        const tailCall = params.getBool(0);
        if (tailCall) {
          return ctx.tailCall(thing, THING_IFACE, THING_PASS_THROUGH, undefined, 0, 0).finally(() =>
            thing.release(),
          );
        }
        return thing.call(THING_IFACE, THING_PASS_THROUGH, undefined, 0, 0).then((res) => {
          ctx.initResults(0, 1).setText(0, res.content.getText(0));
          thing.release();
        });
      }
      case M_CALL_INTERCEPT: {
        const thing = new Client(ctx.getCap(params.getP(0)));
        const tailCall = params.getBool(0);
        if (tailCall) {
          return ctx.tailCall(thing, THING_IFACE, THING_INTERCEPT, undefined, 0, 0).finally(() =>
            thing.release(),
          );
        }
        return thing.call(THING_IFACE, THING_INTERCEPT, undefined, 0, 0).then((res) => {
          ctx.initResults(0, 1).setText(0, res.content.getText(0));
          thing.release();
        });
      }
      case M_LOOPBACK:
        ctx.setResultCap(ctx.initResults(0, 1), 0, ctx.getCap(params.getP(0)));
        return;
      case M_WAIT_FOREVER:
        ctx.allowCancellation();
        return new Promise<void>(() => {});
      default:
        throw new RpcError(`TestMembrane: unknown method ${m}`, "unimplemented");
    }
  }
}

class MembranePolicyImpl extends MembranePolicy {
  constructor(private readonly revokePromise?: Promise<unknown>) {
    super();
    this.revokePromise?.catch(() => {});
  }

  inboundCall(interfaceId: bigint, methodId: number, _target: Client): Client | undefined {
    if (interfaceId === THING_IFACE && methodId === THING_INTERCEPT) {
      return Client.local(new ThingImpl("inbound"));
    }
    return undefined;
  }

  outboundCall(interfaceId: bigint, methodId: number, _target: Client): Client | undefined {
    if (interfaceId === THING_IFACE && methodId === THING_INTERCEPT) {
      return Client.local(new ThingImpl("outbound"));
    }
    return undefined;
  }

  override onRevoked(): Promise<unknown> | undefined {
    return this.revokePromise;
  }

  override shouldResolveBeforeRedirecting(): boolean {
    return true;
  }
}

async function runText(
  promise: PromiseLike<{ content: Ptr }>,
  pump: () => Promise<void>,
): Promise<string> {
  const [res] = await Promise.all([Promise.resolve(promise), pump()]);
  return res.content.getText(0);
}

async function testThingImpl(
  membraned: Client,
  makeThing: () => Promise<Client>,
  expected: {
    localPassThrough: string;
    localIntercept: string;
    remotePassThrough: string;
    remoteIntercept: string;
  },
  pump: () => Promise<void>,
): Promise<void> {
  const t1 = await makeThing();
  expect(await runText(t1.call(THING_IFACE, THING_PASS_THROUGH, undefined, 0, 0), pump)).toBe(
    expected.localPassThrough,
  );
  t1.release();

  const t2 = await makeThing();
  expect(await runText(t2.call(THING_IFACE, THING_INTERCEPT, undefined, 0, 0), pump)).toBe(
    expected.localIntercept,
  );
  t2.release();

  for (const tailCall of [false, true]) {
    const t3 = await makeThing();
    const p3 = membraned.call(
      MEMBRANE_IFACE,
      M_CALL_PASS_THROUGH,
      (p, b) => {
        p.setBool(0, tailCall);
        b.setCap(p, 0, t3.hook);
      },
      1,
      1,
    );
    expect(await runText(p3, pump)).toBe(expected.remotePassThrough);

    const t4 = await makeThing();
    const p4 = membraned.call(
      MEMBRANE_IFACE,
      M_CALL_INTERCEPT,
      (p, b) => {
        p.setBool(0, tailCall);
        b.setCap(p, 0, t4.hook);
      },
      1,
      1,
    );
    expect(await runText(p4, pump)).toBe(expected.remoteIntercept);
  }
}

function makeLocalEnv() {
  const policy = new MembranePolicyImpl();
  const membraned = membrane(Client.local(new TestMembraneImpl()), policy);
  const pump = async () => {};
  return { policy, membraned, pump };
}

function makeRpcEnv(revokePromise?: Promise<unknown>) {
  const policy = new MembranePolicyImpl(revokePromise);
  const server = membrane(Client.local(new TestMembraneImpl()), policy);
  const { a, b, settle } = link(undefined, server);
  const membraned = a.bootstrap();
  const pump = async () => {
    await settle();
  };
  return { a, b, policy, membraned, pump };
}

describe("capnp-C++ membrane-test.c++ (local)", () => {
  test("call local object inside membrane", async () => {
    const { membraned, pump } = makeLocalEnv();
    await testThingImpl(
      membraned,
      async () => {
        const res = await membraned.call(MEMBRANE_IFACE, M_MAKE_THING, undefined, 0, 0);
        return new Client(res.getCap(res.content.getP(0)));
      },
      {
        localPassThrough: "inside",
        localIntercept: "inbound",
        remotePassThrough: "inside",
        remoteIntercept: "inside",
      },
      pump,
    );
  });

  test("call local promise inside membrane", async () => {
    const { membraned, pump } = makeLocalEnv();
    await testThingImpl(
      membraned,
      async () => membraned.call(MEMBRANE_IFACE, M_MAKE_THING, undefined, 0, 0).pipeline(0),
      {
        localPassThrough: "inside",
        localIntercept: "inbound",
        remotePassThrough: "inside",
        remoteIntercept: "inside",
      },
      pump,
    );
  });

  test("call local resolved promise inside membrane", async () => {
    const { membraned, pump } = makeLocalEnv();
    await testThingImpl(
      membraned,
      async () => {
        const thing = membraned.call(MEMBRANE_IFACE, M_MAKE_THING, undefined, 0, 0).pipeline(0);
        await thing.whenResolved();
        return thing;
      },
      {
        localPassThrough: "inside",
        localIntercept: "inbound",
        remotePassThrough: "inside",
        remoteIntercept: "inside",
      },
      pump,
    );
  });

  test("call local object outside membrane", async () => {
    const { membraned, pump } = makeLocalEnv();
    await testThingImpl(
      membraned,
      async () => Client.local(new ThingImpl("outside")),
      {
        localPassThrough: "outside",
        localIntercept: "outside",
        remotePassThrough: "outside",
        remoteIntercept: "outbound",
      },
      pump,
    );
  });

  test("call local capability that has passed into and back out of membrane", async () => {
    const { membraned, pump } = makeLocalEnv();
    await testThingImpl(
      membraned,
      async () => {
        const res = await membraned.call(
          MEMBRANE_IFACE,
          M_LOOPBACK,
          (p, b) => b.setCap(p, 0, Client.local(new ThingImpl("outside")).hook),
          0,
          1,
        );
        return new Client(res.getCap(res.content.getP(0)));
      },
      {
        localPassThrough: "outside",
        localIntercept: "outside",
        remotePassThrough: "outside",
        remoteIntercept: "outbound",
      },
      pump,
    );
  });

  test("call local promise pointing into membrane that eventually resolves to outside", async () => {
    const { membraned, pump } = makeLocalEnv();
    await testThingImpl(
      membraned,
      async () =>
        membraned
          .call(
            MEMBRANE_IFACE,
            M_LOOPBACK,
            (p, b) => b.setCap(p, 0, Client.local(new ThingImpl("outside")).hook),
            0,
            1,
          )
          .pipeline(0),
      {
        localPassThrough: "outside",
        localIntercept: "outside",
        remotePassThrough: "outside",
        remoteIntercept: "outbound",
      },
      pump,
    );
  });

  test("apply membrane using copyOutOfMembrane() on struct", async () => {
    const { policy, membraned, pump } = makeLocalEnv();
    await testThingImpl(
      membraned,
      async () => {
        const b = new CallBuilder(0, 1);
        b.setCap(b.root, 0, Client.local(new ThingImpl("inside")).hook);
        const src = b.toPayload();
        const copied = copyOutOfMembrane(src, policy);
        src.release();
        const cap = new Client(copied.getCap(copied.content.getP(0)));
        copied.release();
        return cap;
      },
      {
        localPassThrough: "inside",
        localIntercept: "inbound",
        remotePassThrough: "inside",
        remoteIntercept: "inside",
      },
      pump,
    );
  });

  test("apply membrane using copyOutOfMembrane() on list", async () => {
    const { policy, membraned, pump } = makeLocalEnv();
    await testThingImpl(
      membraned,
      async () => {
        const b = new CallBuilder(0, 1);
        const list = b.root.initPointerList(0, 1);
        b.message.adopt(list, b.addCap(Client.local(new ThingImpl("inside")).hook));
        const src = b.toPayload();
        const copied = copyOutOfMembrane(src, policy);
        src.release();
        const cap = new Client(copied.getCap(copied.content.getP(0).listGetP(0)));
        copied.release();
        return cap;
      },
      {
        localPassThrough: "inside",
        localIntercept: "inbound",
        remotePassThrough: "inside",
        remoteIntercept: "inside",
      },
      pump,
    );
  });

  test("apply membrane using copyOutOfMembrane() on AnyPointer", async () => {
    const { policy, membraned, pump } = makeLocalEnv();
    await testThingImpl(
      membraned,
      async () => {
        const b = new CallBuilder(0, 1);
        b.root.adopt(0, b.addCap(Client.local(new ThingImpl("inside")).hook));
        const src = b.toPayload();
        const copied = copyOutOfMembrane(src, policy);
        src.release();
        const cap = new Client(copied.getCap(copied.content.getP(0)));
        copied.release();
        return cap;
      },
      {
        localPassThrough: "inside",
        localIntercept: "inbound",
        remotePassThrough: "inside",
        remoteIntercept: "inside",
      },
      pump,
    );
  });

  test("MembraneHook.whenMoreResolved returns same value even when called concurrently", async () => {
    const { policy } = makeLocalEnv();
    let fulfill!: (c: Client) => void;
    const promCap = Client.fromPromise(new Promise<Client>((r) => (fulfill = r)));
    const membraned = membrane(promCap, policy);
    const first = membraned.hook.whenMoreResolved()!;
    const second = membraned.hook.whenMoreResolved()!;
    fulfill(Client.local(new TestMembraneImpl()));
    const [h1, h2] = await Promise.all([first, second]);
    expect(h1).toBe(h2);
    membraned.release();
  });
});

describe("capnp-C++ membrane-test.c++ (RPC)", () => {
  test("call remote object inside membrane", async () => {
    const { membraned, pump } = makeRpcEnv();
    await testThingImpl(
      membraned,
      async () => {
        const call = membraned.call(MEMBRANE_IFACE, M_MAKE_THING, undefined, 0, 0);
        await pump();
        const res = await call;
        return new Client(res.getCap(res.content.getP(0)));
      },
      {
        localPassThrough: "inside",
        localIntercept: "inbound",
        remotePassThrough: "inside",
        remoteIntercept: "inside",
      },
      pump,
    );
  });

  test("call remote promise inside membrane", async () => {
    const { membraned, pump } = makeRpcEnv();
    await testThingImpl(
      membraned,
      async () => membraned.call(MEMBRANE_IFACE, M_MAKE_THING, undefined, 0, 0).pipeline(0),
      {
        localPassThrough: "inside",
        localIntercept: "inbound",
        remotePassThrough: "inside",
        remoteIntercept: "inside",
      },
      pump,
    );
  });

  test("call remote resolved promise inside membrane", async () => {
    const { membraned, pump } = makeRpcEnv();
    await testThingImpl(
      membraned,
      async () => {
        const thing = membraned.call(MEMBRANE_IFACE, M_MAKE_THING, undefined, 0, 0).pipeline(0);
        await pump();
        await thing.whenResolved();
        return thing;
      },
      {
        localPassThrough: "inside",
        localIntercept: "inbound",
        remotePassThrough: "inside",
        remoteIntercept: "inside",
      },
      pump,
    );
  });

  test("call remote object outside membrane", async () => {
    const { membraned, pump } = makeRpcEnv();
    await testThingImpl(
      membraned,
      async () => Client.local(new ThingImpl("outside")),
      {
        localPassThrough: "outside",
        localIntercept: "outside",
        remotePassThrough: "outside",
        remoteIntercept: "outbound",
      },
      pump,
    );
  });

  test("call remote capability that has passed into and back out of membrane", async () => {
    const { membraned, pump } = makeRpcEnv();
    await testThingImpl(
      membraned,
      async () => {
        const call = membraned.call(
          MEMBRANE_IFACE,
          M_LOOPBACK,
          (p, b) => b.setCap(p, 0, Client.local(new ThingImpl("outside")).hook),
          0,
          1,
        );
        await pump();
        const res = await call;
        return new Client(res.getCap(res.content.getP(0)));
      },
      {
        localPassThrough: "outside",
        localIntercept: "outside",
        remotePassThrough: "outside",
        remoteIntercept: "outbound",
      },
      pump,
    );
  });

  test("call remote promise pointing into membrane that eventually resolves to outside", async () => {
    const { membraned, pump } = makeRpcEnv();
    await testThingImpl(
      membraned,
      async () =>
        membraned
          .call(
            MEMBRANE_IFACE,
            M_LOOPBACK,
            (p, b) => b.setCap(p, 0, Client.local(new ThingImpl("outside")).hook),
            0,
            1,
          )
          .pipeline(0),
      {
        localPassThrough: "outside",
        localIntercept: "outside",
        remotePassThrough: "outside",
        remoteIntercept: "outbound",
      },
      pump,
    );
  });

  test("revoke membrane", async () => {
    let revoke!: (e: Error) => void;
    const revokePromise = new Promise<never>((_, reject) => (revoke = reject));
    const { membraned, pump } = makeRpcEnv(revokePromise);

    const made = membraned.call(MEMBRANE_IFACE, M_MAKE_THING, undefined, 0, 0);
    await pump();
    const res = await made;
    const thing = new Client(res.getCap(res.content.getP(0)));

    const waiting = membraned.call(MEMBRANE_IFACE, M_WAIT_FOREVER, undefined, 0, 0);
    await pump();
    expect(waiting.result.state).toBe("pending");

    revoke(new RpcError("foobar", "disconnected"));
    await pump();

    await expect(Promise.resolve(waiting)).rejects.toMatchObject({
      message: "foobar",
      type: "disconnected",
    });

    const after1 = membraned.call(MEMBRANE_IFACE, M_MAKE_THING, undefined, 0, 0);
    await pump();
    await expect(Promise.resolve(after1)).rejects.toMatchObject({
      message: "foobar",
      type: "disconnected",
    });

    const after2 = thing.call(THING_IFACE, THING_PASS_THROUGH, undefined, 0, 0);
    await pump();
    await expect(Promise.resolve(after2)).rejects.toMatchObject({
      message: "foobar",
      type: "disconnected",
    });
    thing.release();
  });
});
