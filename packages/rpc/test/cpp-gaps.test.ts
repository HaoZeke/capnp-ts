/**
 * Behavior checked against capnp-C++ 1.4.0, one block per difference.
 * Most tests drive a vat with hand-built frames and read back exactly
 * what it sends, which is what interop/raw_frames.ts compares live.
 */
import { describe, expect, test } from "bun:test";
import {
  Message as CapnpMessage,
  MessageBuilder,
  Orphan,
  type Ptr,
  PtrKind,
  type StructBuilder,
} from "@haozeke/capnp";

import { newNullCap } from "../src/capability.ts";
import { Client, RpcError, type RpcServer } from "../src/index.ts";
import {
  CapDescriptor,
  CapDescriptor_which,
  Exception_getReason,
  Message,
  Message_which,
  Payload_getCapTable,
  Payload_getContent,
  Resolve,
  Resolve_getCap,
  Resolve_getException,
  Resolve_getPromiseId,
  Resolve_which,
  Return,
  Return_getAnswerId,
  Return_getException,
  Return_getNoFinishNeeded,
  Return_getReleaseParamCaps,
  Return_getResults,
  Return_which,
} from "../src/rpc.capnp.ts";
import { MemoryTransportPair } from "../src/transport.ts";
import { RpcConnection } from "../src/vat.ts";

const IFACE = 0x1234n;
const nextTurn = (): Promise<void> => new Promise((res) => setImmediate(res));

function frame(tag: number, fill?: (m: StructBuilder) => void): Uint8Array {
  const b = new MessageBuilder();
  const root = b.initRoot(1, 1);
  root.setU16(0, tag);
  fill?.(root);
  return b.toFlat();
}

function bootstrap(q: number): Uint8Array {
  return frame(Message.bootstrap, (m) => m.initStruct(0, 1, 1).setU32(0, q));
}

function toAnswer(t: StructBuilder, q: number, ops: number[] = []): void {
  t.setU16(4, 1);
  const pa = t.initStruct(0, 1, 1);
  pa.setU32(0, q);
  if (ops.length === 0) return;
  let op = pa.initCompositeList(0, ops.length, 1, 0);
  ops.forEach((f, i) => {
    if (i > 0) op = op.nextElement();
    op.setU16(0, 1);
    op.setU16(2, f);
  });
}

function call(
  q: number,
  target: (t: StructBuilder) => void,
  fill?: (c: StructBuilder) => void,
  params?: (p: StructBuilder) => void,
): Uint8Array {
  return frame(Message.call, (m) => {
    const c = m.initStruct(0, 3, 3);
    c.setU32(0, q >>> 0);
    c.setU64(8, IFACE);
    target(c.initStruct(0, 1, 1));
    params?.(c.initStruct(1, 0, 2).initStruct(0, 1, 0));
    fill?.(c);
  });
}

interface Raw {
  vat: RpcConnection;
  send(f: Uint8Array): void;
  /** Every frame the vat has sent since the last call, decoded to its body. */
  take(): Array<{ which: number; body: Ptr }>;
}

function raw(server?: RpcServer | Client): Raw {
  const pair = new MemoryTransportPair();
  const vat = new RpcConnection(pair.a, server);
  return {
    vat,
    send(f) {
      pair.b.send(f);
      vat.pump();
    },
    take() {
      const out: Array<{ which: number; body: Ptr }> = [];
      for (let f = pair.b.receive(); f !== null; f = pair.b.receive()) {
        const root = CapnpMessage.fromFlat(f).root();
        out.push({ which: Message_which(root), body: root.getP(0) });
      }
      return out;
    },
  };
}

function capKinds(ret: Ptr): number[] {
  const payload = Return_getResults(ret);
  if (payload.kind !== PtrKind.Struct) return [];
  const table = Payload_getCapTable(payload);
  if (table.kind !== PtrKind.List) return [];
  const kinds: number[] = [];
  for (let i = 0; i < table.listLen(); i++) kinds.push(CapDescriptor_which(table.listGetP(i)));
  return kinds;
}

/** A bootstrap whose every call returns `make()` in result pointer 0. */
function returning(make: () => Client): RpcServer {
  return {
    dispatch(_i, _m, _p, _r, ctx) {
      ctx.setResultCap(ctx.initResults(0, 1), 0, make().hook);
    },
  };
}

/** A Call whose params hold one capability, described by `kind` and `id`. */
function callWithCap(
  q: number,
  target: (t: StructBuilder) => void,
  kind: number,
  id: number,
): Uint8Array {
  const b = new MessageBuilder();
  const root = b.initRoot(1, 1);
  root.setU16(0, Message.call);
  const c = root.initStruct(0, 3, 3);
  c.setU32(0, q);
  c.setU64(8, IFACE);
  target(c.initStruct(0, 1, 1));
  const payload = c.initStruct(1, 0, 2);
  payload.initStruct(0, 0, 1).adopt(0, Orphan.cap(b, 0));
  const table = payload.initCompositeList(1, 1, 1, 1);
  table.setU16(0, kind);
  table.setU32(4, id);
  return b.toFlat();
}

function resolveTo(promiseId: number, kind: number, id: number): Uint8Array {
  return frame(Message.resolve, (m) => {
    const r = m.initStruct(0, 1, 1);
    r.setU32(0, promiseId);
    r.setU16(4, Resolve.cap);
    const d = r.initStruct(0, 1, 1);
    d.setU16(0, kind);
    d.setU32(4, id);
  });
}

function loopback(target: (t: StructBuilder) => void, id: number): Uint8Array {
  return frame(Message.disembargo, (m) => {
    const d = m.initStruct(0, 1, 1);
    target(d.initStruct(0, 1, 1));
    d.setU16(4, 0);
    d.setU32(0, id);
  });
}

/** Echoes the capability in params pointer 0 back in results pointer 0. */
const echoCap: RpcServer = {
  dispatch(_i, _m, params, _r, ctx) {
    ctx.setResultCap(ctx.initResults(0, 1), 0, ctx.getCap(params.getP(0)));
  },
};

describe("pipelines freeze at Return time (rpc.c++ PostReturnRpcPipeline)", () => {
  test("a pipelined call after the Return goes to the import the Return named", async () => {
    const r = raw(echoCap);
    r.send(bootstrap(0));
    r.send(callWithCap(1, (t) => toAnswer(t, 0), CapDescriptor.senderPromise, 5));
    await nextTurn();
    r.take();
    // The promise the peer passed in resolves to another of its exports.
    r.send(resolveTo(5, CapDescriptor.senderHosted, 6));
    r.send(call(2, (t) => toAnswer(t, 1, [0])));
    const out = r.take().filter((m) => m.which === Message.call);
    expect(out.length).toBe(1);
    const target = out[0]!.body.getP(0);
    expect(target.getU16(4)).toBe(0);
    expect(target.getU32(0)).toBe(5);
  });

  test("a Disembargo after the Return reflects on the import the Return named", async () => {
    const r = raw(echoCap);
    r.send(bootstrap(0));
    r.send(callWithCap(1, (t) => toAnswer(t, 0), CapDescriptor.senderPromise, 5));
    await nextTurn();
    r.take();
    r.send(resolveTo(5, CapDescriptor.senderHosted, 6));
    r.send(loopback((t) => toAnswer(t, 1, [0]), 9));
    await nextTurn();
    await nextTurn();
    const out = r.take().filter((m) => m.which === Message.disembargo);
    expect(out.length).toBe(1);
    const target = out[0]!.body.getP(0);
    expect(target.getU16(4)).toBe(0);
    expect(target.getU32(0)).toBe(5);
    expect(r.vat.disconnected).toBeUndefined();
  });
});

describe("broken capabilities are failed promises (capability.c++ BrokenClient)", () => {
  test("whenResolved rejects on a broken capability and resolves on a null one", async () => {
    await expect(Client.broken(new RpcError("gone")).whenResolved()).rejects.toThrow("gone");
    await new Client(newNullCap()).whenResolved();
  });

  test("a broken capability in results is a senderPromise resolved by an exception", async () => {
    const r = raw(returning(() => Client.broken(new RpcError("broken on purpose"))));
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    await nextTurn();
    const out = r.take();
    expect(out.map((m) => m.which)).toEqual([Message.return, Message.return, Message.resolve]);
    expect(Return_getAnswerId(out[1]!.body)).toBe(1);
    expect(capKinds(out[1]!.body)).toEqual([CapDescriptor.senderPromise]);
    const resolve = out[2]!.body;
    expect(Resolve_which(resolve)).toBe(Resolve.exception);
    expect(Exception_getReason(Resolve_getException(resolve))).toBe("broken on purpose");
  });

  test("an exported promise that resolves to a broken capability sends Resolve.exception", async () => {
    let settle!: (c: Client) => void;
    const r = raw(returning(() => Client.fromPromise(new Promise<Client>((res) => (settle = res)))));
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    expect(capKinds(r.take()[1]!.body)).toEqual([CapDescriptor.senderPromise]);
    settle(Client.broken(new RpcError("went bad")));
    await nextTurn();
    await nextTurn();
    const out = r.take();
    expect(out.map((m) => m.which)).toEqual([Message.resolve]);
    expect(Resolve_which(out[0]!.body)).toBe(Resolve.exception);
    expect(Exception_getReason(Resolve_getException(out[0]!.body))).toBe("went bad");
  });

  test("an exported promise that resolves to null exports the null capability", async () => {
    let settle!: (c: Client) => void;
    const r = raw(returning(() => Client.fromPromise(new Promise<Client>((res) => (settle = res)))));
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    r.take();
    settle(new Client(newNullCap()));
    await nextTurn();
    await nextTurn();
    const out = r.take();
    expect(out.map((m) => m.which)).toEqual([Message.resolve]);
    expect(Resolve_which(out[0]!.body)).toBe(Resolve.cap);
    expect(Resolve_getPromiseId(out[0]!.body)).toBe(1);
    expect(CapDescriptor_which(Resolve_getCap(out[0]!.body))).toBe(CapDescriptor.senderHosted);
  });
});

const ping: RpcServer = {
  dispatch(_i, _m, params, results) {
    results.setU32(0, params.getU32(0) + 1);
  },
};

describe("capability-free returns need no Finish (rpc.c++ sendReturn)", () => {
  test("a Return without capabilities sets noFinishNeeded and drops the answer", () => {
    const r = raw(ping);
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0), undefined, (p) => p.setU32(0, 41)));
    const out = r.take();
    const ret = out[1]!.body;
    expect(Return_getAnswerId(ret)).toBe(1);
    expect(Return_getNoFinishNeeded(ret)).toBe(true);
    // The answer is gone: a pipelined call on it fails, and the id is free.
    r.send(call(2, (t) => toAnswer(t, 1, [0])));
    const failed = r.take()[0]!.body;
    expect(Return_which(failed)).toBe(Return.exception);
    expect(Exception_getReason(Return_getException(failed))).toBe(
      "Pipeline call on a request that returned no capabilities or was already closed.",
    );
    r.send(call(1, (t) => toAnswer(t, 0), undefined, (p) => p.setU32(0, 1)));
    expect(Return_getNoFinishNeeded(r.take()[0]!.body)).toBe(true);
    expect(r.vat.disconnected).toBeUndefined();
  });

  test("a Return with capabilities still needs its Finish", () => {
    const r = raw(returning(() => Client.local(ping)));
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    const ret = r.take()[1]!.body;
    expect(capKinds(ret)).toEqual([CapDescriptor.senderHosted]);
    expect(Return_getNoFinishNeeded(ret)).toBe(false);
  });

  test("an exception keeps the answer for pipelined calls", () => {
    const r = raw({
      dispatch() {
        throw new RpcError("nope");
      },
    });
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    expect(Return_getNoFinishNeeded(r.take()[1]!.body)).toBe(false);
    r.send(call(2, (t) => toAnswer(t, 1, [0])));
    const piped = r.take()[0]!.body;
    expect(Exception_getReason(Return_getException(piped))).toBe("nope");
  });

  test("a null capability is a null pointer with no cap table entry", () => {
    const r = raw(returning(() => new Client(newNullCap())));
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    const ret = r.take()[1]!.body;
    expect(capKinds(ret)).toEqual([]);
    expect(Payload_getContent(Return_getResults(ret)).getP(0).kind).toBe(PtrKind.Null);
    expect(Return_getNoFinishNeeded(ret)).toBe(true);
  });
});

describe("null message bodies read as defaults (rpc.c++ handleMessage)", () => {
  const seen: Array<[bigint, number]> = [];
  const recorder: RpcServer = {
    dispatch(iface, method) {
      seen.push([iface, method]);
    },
  };

  test("a null Call body is a call to export 0", () => {
    seen.length = 0;
    const r = raw(recorder);
    r.send(bootstrap(5));
    r.send(frame(Message.call));
    const out = r.take();
    expect(out.map((m) => m.which)).toEqual([Message.return, Message.return]);
    expect(Return_getAnswerId(out[1]!.body)).toBe(0);
    expect(seen).toEqual([[0n, 0]]);
  });

  test("a null Call body with nothing exported aborts as a bad target", () => {
    const r = raw(recorder);
    r.send(frame(Message.call));
    const out = r.take();
    expect(out.map((m) => m.which)).toEqual([Message.abort]);
    expect(Exception_getReason(out[0]!.body)).toBe("Message target is not a current export ID.");
  });

  test("a null Bootstrap body is a bootstrap for question 0", () => {
    const r = raw(recorder);
    r.send(frame(Message.bootstrap));
    const out = r.take();
    expect(out.map((m) => m.which)).toEqual([Message.return]);
    expect(Return_getAnswerId(out[0]!.body)).toBe(0);
    expect(capKinds(out[0]!.body)).toEqual([CapDescriptor.senderHosted]);
  });

  test("a null Abort body is an empty remote exception", () => {
    const r = raw(recorder);
    r.send(frame(Message.abort));
    const out = r.take();
    expect(out.map((m) => m.which)).toEqual([Message.abort]);
    expect(Exception_getReason(out[0]!.body)).toBe("remote exception: ");
  });
});

describe("bootstrap answers (rpc.c++ handleBootstrap)", () => {
  test("the Return leaves releaseParamCaps at its default", () => {
    const r = raw(ping);
    r.send(bootstrap(0));
    expect(Return_getReleaseParamCaps(r.take()[0]!.body)).toBe(true);
  });

  test("a vat without a bootstrap capability returns a broken one", async () => {
    const r = raw();
    r.send(bootstrap(0));
    const out = r.take();
    expect(capKinds(out[0]!.body)).toEqual([CapDescriptor.senderPromise]);
    await nextTurn();
    const resolve = r.take()[0]!.body;
    expect(Resolve_which(resolve)).toBe(Resolve.exception);
    expect(Exception_getReason(Resolve_getException(resolve))).toBe(
      "This vat does not expose any public/bootstrap interfaces.",
    );
  });

  test("a pipelined call with a nonempty transform is invalid", () => {
    const r = raw(ping);
    r.send(bootstrap(0));
    r.take();
    r.send(call(1, (t) => toAnswer(t, 0, [0])));
    const ret = r.take()[0]!.body;
    expect(Return_which(ret)).toBe(Return.exception);
    expect(Exception_getReason(Return_getException(ret))).toBe("Invalid pipeline transform.");
  });
});
