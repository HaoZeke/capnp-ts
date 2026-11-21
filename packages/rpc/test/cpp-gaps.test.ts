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

import { LocalClient, newNullCap } from "../src/capability.ts";
import {
  Client,
  ExportMap,
  membrane,
  RevocablePolicy,
  RpcError,
  type RpcServer,
} from "../src/index.ts";
import {
  Call_getNoPromisePipelining,
  Call_getOnlyPromisePipeline,
  Call_getQuestionId,
  Call_getTarget,
  Call_sendResultsTo,
  Call_sendResultsTo_which,
  CapDescriptor,
  CapDescriptor_which,
  Exception_getReason,
  Exception_getTrace,
  Finish_getQuestionId,
  Finish_getReleaseResultCaps,
  Message,
  MessageTarget,
  MessageTarget_getPromisedAnswer,
  MessageTarget_which,
  Message_which,
  Payload_getCapTable,
  Payload_getContent,
  PromisedAnswer_getQuestionId,
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
import { frameLength } from "../src/socket.ts";
import { MemoryTransportPair } from "../src/transport.ts";
import { RpcConnection, Vat } from "../src/vat.ts";

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

function raw(
  server?: RpcServer | Client,
  multiParty?: Vat,
  options?: ConstructorParameters<typeof RpcConnection>[3],
): Raw {
  const pair = new MemoryTransportPair();
  const vat = new RpcConnection(pair.a, server, multiParty, options);
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
  fill?: (c: StructBuilder) => void,
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
  fill?.(c);
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

  /** A promised-answer target whose transform is `ops`, with -1 for `noop`. */
  const withOps = (t: StructBuilder, q: number, ops: number[]): void => {
    t.setU16(4, 1);
    const pa = t.initStruct(0, 1, 1);
    pa.setU32(0, q);
    let op = pa.initCompositeList(0, ops.length, 1, 0);
    ops.forEach((f, i) => {
      if (i > 0) op = op.nextElement();
      if (f >= 0) {
        op.setU16(0, 1);
        op.setU16(2, f);
      }
    });
  };

  test("a transform of one noop is still a nonempty transform", () => {
    const r = raw(ping);
    r.send(bootstrap(0));
    r.take();
    r.send(call(1, (t) => withOps(t, 0, [-1])));
    const ret = r.take()[0]!.body;
    expect(Return_which(ret)).toBe(Return.exception);
    expect(Exception_getReason(Return_getException(ret))).toBe("Invalid pipeline transform.");
  });

  test("a noop in a call answer's transform moves nowhere", () => {
    const r = raw(returning(() => Client.local(ping)));
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    r.take();
    r.send(call(2, (t) => withOps(t, 1, [-1, 0, -1]), undefined, (p) => p.setU32(0, 6)));
    const ret = r.take()[0]!.body;
    expect(Return_which(ret)).toBe(Return.results);
    expect(Payload_getContent(Return_getResults(ret)).getU32(0)).toBe(7);
  });
});

function provide(q: number, nonce: bigint): Uint8Array {
  return frame(Message.provide, (m) => {
    const p = m.initStruct(0, 1, 2);
    p.setU32(0, q);
    p.initStruct(0, 1, 1).setU32(0, 0);
    p.initStruct(1, 1, 1).setU64(0, nonce);
  });
}

function disembargo(which: number, value: number, target: (t: StructBuilder) => void): Uint8Array {
  return frame(Message.disembargo, (m) => {
    const d = m.initStruct(0, 1, 1);
    target(d.initStruct(0, 1, 1));
    d.setU16(4, which);
    d.setU32(0, value);
  });
}

describe("two-party connections refuse level 3 and 4 (rpc.c++ handleMessage)", () => {
  for (const [name, tag, f] of [
    ["Provide", Message.provide, provide(1, 7n)],
    ["Accept", Message.accept, frame(Message.accept, (m) => m.initStruct(0, 1, 2).setU32(0, 1))],
    ["Join", Message.join, frame(Message.join, (m) => m.initStruct(0, 1, 2).setU32(0, 1))],
  ] as const) {
    test(`${name} is echoed as unimplemented`, () => {
      const r = raw(ping);
      r.send(bootstrap(0));
      r.take();
      r.send(f);
      const out = r.take();
      expect(out.map((m) => m.which)).toEqual([Message.unimplemented]);
      expect(Message_which(out[0]!.body)).toBe(tag);
      expect(r.vat.pendingProvisions()).toEqual([]);
      expect(r.vat.disconnected).toBeUndefined();
    });
  }

  test("Disembargo.provide aborts and prints the message", () => {
    const r = raw(ping);
    r.send(bootstrap(0));
    r.take();
    r.send(disembargo(3, 1, (t) => t.setU32(0, 0)));
    const out = r.take();
    expect(out.map((m) => m.which)).toEqual([Message.abort]);
    expect(Exception_getReason(out[0]!.body)).toBe(
      "Unimplemented Disembargo type.; disembargo = (target = (importedCap = 0), context = (provide = 1))",
    );
  });

  test("Disembargo.accept prints a promised answer's transform", () => {
    const r = raw(ping, new Vat());
    r.send(disembargo(2, 0, (t) => toAnswer(t, 4, [0, 2])));
    expect(Exception_getReason(r.take()[0]!.body)).toBe(
      "Unimplemented Disembargo type.; disembargo = (target = (promisedAnswer = (questionId = 4, " +
        "transform = [(getPointerField = 0), (getPointerField = 2)])), context = (accept = void))",
    );
  });

  test("an unknown Disembargo context prints as empty", () => {
    const r = raw(ping);
    r.send(disembargo(9, 0, (t) => toAnswer(t, 0)));
    expect(Exception_getReason(r.take()[0]!.body)).toBe(
      "Unimplemented Disembargo type.; disembargo = (target = (promisedAnswer = (questionId = 0)), context = ())",
    );
  });
});

describe("provisions end with their connection", () => {
  const counted = (): { server: RpcServer; disposed: () => number } => {
    let n = 0;
    return {
      server: { dispatch() {}, dispose: () => void n++ },
      disposed: () => n,
    };
  };

  test("an unclaimed provision is released on disconnect", () => {
    const { server, disposed } = counted();
    const vat = new Vat();
    const r = raw(server, vat);
    r.send(bootstrap(0));
    r.send(provide(1, 7n));
    expect(r.vat.pendingProvisions()).toEqual([7n]);
    r.vat.disconnect(new RpcError("bye"));
    expect(vat.provisions.size).toBe(0);
    expect(disposed()).toBe(1);
  });

  test("a provision replaced under the same nonce is released", () => {
    const { server, disposed } = counted();
    const r = raw(server, new Vat());
    r.send(bootstrap(0));
    r.send(provide(1, 7n));
    r.send(provide(2, 7n));
    r.vat.disconnect(new RpcError("bye"));
    expect(disposed()).toBe(1);
  });
});

describe("tail calls (rpc.c++ directTailCall)", () => {
  test("tailCall() after initResults() fails the call", () => {
    const r = raw({
      dispatch(_i, _m, _p, _r, ctx) {
        ctx.initResults(1, 0);
        return ctx.tailCall(Client.local(ping), IFACE, 0);
      },
    });
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    const ret = r.take()[1]!.body;
    expect(Return_which(ret)).toBe(Return.exception);
    expect(Exception_getReason(Return_getException(ret))).toBe(
      "expected response == nullptr [(can't stringify) == nullptr]; " +
        "Can't call tailCall() after initializing the results struct.",
    );
  });

  const forwarder: RpcServer = {
    dispatch(_i, _m, params, _r, ctx) {
      return ctx.tailCall(new Client(ctx.getCap(params.getP(0))), IFACE, 0);
    },
  };

  const tailFrames = (fill?: (c: StructBuilder) => void): Array<{ which: number; body: Ptr }> => {
    const r = raw(forwarder);
    r.send(bootstrap(0));
    r.take();
    r.send(callWithCap(1, (t) => toAnswer(t, 0), CapDescriptor.senderHosted, 5, fill));
    return r.take();
  };

  test("a tail call back to the caller skips the round trip", () => {
    const out = tailFrames();
    expect(out.map((m) => m.which)).toEqual([Message.call, Message.return]);
    expect(Call_sendResultsTo_which(out[0]!.body)).toBe(Call_sendResultsTo.yourself);
    expect(Return_which(out[1]!.body)).toBe(Return.takeFromOtherQuestion);
  });

  test("noPromisePipelining keeps the tail call's results coming back", () => {
    const out = tailFrames((c) => c.setBool(129, true));
    expect(out.map((m) => m.which)).toEqual([Message.call]);
    expect(Call_sendResultsTo_which(out[0]!.body)).toBe(Call_sendResultsTo.caller);
  });

  test("onlyPromisePipeline is passed on to a tail call made elsewhere", async () => {
    const other = raw();
    const far = other.vat.bootstrap();
    other.send(returnCap(0, 0));
    await far.whenResolved();
    other.take();
    const r = raw({
      dispatch(_i, _m, _p, _r, ctx) {
        return ctx.tailCall(far, IFACE, 0);
      },
    });
    r.send(bootstrap(0));
    r.take();
    r.send(call(0x80000001, (t) => toAnswer(t, 0), (c) => c.setBool(130, true)));
    const [sent] = other.take();
    expect(sent!.which).toBe(Message.call);
    expect(Call_getOnlyPromisePipeline(sent!.body)).toBe(true);
    const tailQ = Call_getQuestionId(sent!.body);
    expect(tailQ).toBeGreaterThanOrEqual(0x80000000);
    expect(r.take()).toEqual([]);
    // A call pipelined on the incoming question reaches the tail call's answer.
    r.send(call(2, (t) => toAnswer(t, 0x80000001, [0])));
    const [piped] = other.take();
    expect(PromisedAnswer_getQuestionId(MessageTarget_getPromisedAnswer(Call_getTarget(piped!.body)))).toBe(
      tailQ,
    );
  });

  test("a tail call made elsewhere without the hint is a plain call", async () => {
    const other = raw();
    const far = other.vat.bootstrap();
    other.send(returnCap(0, 0));
    await far.whenResolved();
    other.take();
    const r = raw({
      dispatch(_i, _m, _p, _r, ctx) {
        return ctx.tailCall(far, IFACE, 0);
      },
    });
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    const [sent] = other.take();
    expect(Call_getOnlyPromisePipeline(sent!.body)).toBe(false);
    expect(Call_getQuestionId(sent!.body)).toBeLessThan(0x80000000);
  });
});

/** A bootstrap Return for question `q`: the content is the peer's export `id`. */
function returnCap(q: number, id: number): Uint8Array {
  const b = new MessageBuilder();
  const root = b.initRoot(1, 1);
  root.setU16(0, Message.return);
  const ret = root.initStruct(0, 2, 1);
  ret.setU32(0, q >>> 0);
  const payload = ret.initStruct(0, 0, 2);
  payload.adopt(0, Orphan.cap(b, 0));
  const table = payload.initCompositeList(1, 1, 1, 1);
  table.setU16(0, CapDescriptor.senderHosted);
  table.setU32(4, id);
  return b.toFlat();
}

describe("outgoing call hints (rpc.c++ RpcRequest::send, sendForPipeline)", () => {
  const connected = async (): Promise<{ r: Raw; cap: Client }> => {
    const r = raw();
    const cap = r.vat.bootstrap();
    r.send(returnCap(0, 0));
    await cap.whenResolved();
    r.take();
    return { r, cap };
  };
  const callBody = (m: { which: number; body: Ptr }): Ptr => {
    expect(m.which).toBe(Message.call);
    return m.body;
  };

  test("noPromisePipelining is sent and disables the pipeline", async () => {
    const { r, cap } = await connected();
    const p = cap.call(IFACE, 0, undefined, 1, 0, { noPromisePipelining: true });
    const sent = callBody(r.take()[0]!);
    expect(Call_getNoPromisePipelining(sent)).toBe(true);
    const piped = p.pipeline(0);
    expect(piped.isBroken).toBe(true);
    await expect(Promise.resolve(piped.call(IFACE, 0))).rejects.toThrow(
      "caller specified noPromisePipelining hint, but then tried to pipeline",
    );
  });

  test("onlyPromisePipeline uses a high question id and expects no Return", async () => {
    const { r, cap } = await connected();
    const p = cap.call(IFACE, 0, undefined, 1, 0, { onlyPromisePipeline: true });
    const sent = callBody(r.take()[0]!);
    expect(Call_getOnlyPromisePipeline(sent)).toBe(true);
    const q = Call_getQuestionId(sent);
    expect(q).toBe(0x80000000);
    const pipelined = p.pipeline(0);
    const inner = pipelined.call(IFACE, 1);
    const piped = callBody(r.take()[0]!);
    expect(MessageTarget_which(Call_getTarget(piped))).toBe(MessageTarget.promisedAnswer);
    expect(PromisedAnswer_getQuestionId(MessageTarget_getPromisedAnswer(Call_getTarget(piped)))).toBe(q);
    inner.release();
    pipelined.release();
    p.release();
    const fin = r
      .take()
      .filter((m) => m.which === Message.finish)
      .map((m) => m.body)
      .find((f) => Finish_getQuestionId(f) === q)!;
    expect(Finish_getQuestionId(fin)).toBe(q);
    expect(Finish_getReleaseResultCaps(fin)).toBe(false);
  });

  test("a Return for a high question id turns the hint off", async () => {
    const { r, cap } = await connected();
    cap.call(IFACE, 0, undefined, 1, 0, { onlyPromisePipeline: true });
    const first = Call_getQuestionId(callBody(r.take()[0]!));
    expect(first).toBe(0x80000000);
    r.send(frame(Message.return, (m) => m.initStruct(0, 2, 1).setU32(0, first)));
    expect(r.vat.disconnected).toBeUndefined();
    cap.call(IFACE, 0, undefined, 1, 0, { onlyPromisePipeline: true });
    const second = callBody(r.take()[0]!);
    expect(Call_getOnlyPromisePipeline(second)).toBe(false);
    expect(Call_getQuestionId(second)).toBeLessThan(0x80000000);
  });
});

describe("Disembargo senderLoopback (rpc.c++ handleDisembargo)", () => {
  test("the echo waits for work already queued", async () => {
    const r = raw(echoCap);
    r.send(bootstrap(0));
    r.send(callWithCap(1, (t) => toAnswer(t, 0), CapDescriptor.senderHosted, 5));
    r.take();
    r.send(loopback((t) => toAnswer(t, 1, [0]), 4));
    expect(r.take()).toEqual([]);
    await nextTurn();
    const out = r.take();
    expect(out.map((m) => m.which)).toEqual([Message.disembargo]);
  });

  test("a null capability does not point back to the sender", async () => {
    const r = raw({
      dispatch(_i, _m, _p, _r, ctx) {
        const results = ctx.initResults(0, 2);
        ctx.setResultCap(results, 0, Client.local(ping).hook);
      },
    });
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    r.take();
    r.send(loopback((t) => toAnswer(t, 1, [1]), 4));
    await nextTurn();
    const out = r.take();
    expect(out.map((m) => m.which)).toEqual([Message.abort]);
    expect(Exception_getReason(out[0]!.body)).toBe(
      "expected target->getBrand() == this [0 == 1]; " +
        "'Disembargo' of type 'senderLoopback' sent to an object that does not point back to the sender.",
    );
  });
});

describe("membranes (membrane.c++)", () => {
  const forwarder: RpcServer = {
    dispatch(_i, _m, params, _r, ctx) {
      return ctx.tailCall(new Client(ctx.getCap(params.getP(0))), IFACE, 0);
    },
  };

  test("a tail call crossing back out keeps the round trip saving", () => {
    const r = raw(membrane(Client.local(forwarder), new RevocablePolicy()));
    r.send(bootstrap(0));
    r.take();
    r.send(callWithCap(1, (t) => toAnswer(t, 0), CapDescriptor.senderHosted, 5));
    const out = r.take();
    expect(out.map((m) => m.which)).toEqual([Message.call, Message.return]);
    expect(Call_sendResultsTo_which(out[0]!.body)).toBe(Call_sendResultsTo.yourself);
    expect(Return_which(out[1]!.body)).toBe(Return.takeFromOtherQuestion);
  });

  test("a tail call to a capability from another membrane stays a plain call", () => {
    const other = new RevocablePolicy();
    const r = raw(
      membrane(
        Client.local({
          dispatch(_i, _m, params, _r, ctx) {
            const cap = membrane(new Client(ctx.getCap(params.getP(0))), other);
            return ctx.tailCall(cap, IFACE, 0);
          },
        }),
        new RevocablePolicy(),
      ),
    );
    r.send(bootstrap(0));
    r.take();
    r.send(callWithCap(1, (t) => toAnswer(t, 0), CapDescriptor.senderHosted, 5));
    const out = r.take();
    expect(out.map((m) => m.which)).toEqual([Message.call]);
    expect(Call_sendResultsTo_which(out[0]!.body)).toBe(Call_sendResultsTo.caller);
  });

  test("flush() ends with the membrane's revocation", async () => {
    const hook = new LocalClient(ping);
    hook.flush = () => new Promise<void>(() => {});
    const policy = new RevocablePolicy();
    const wrapped = membrane(new Client(hook), policy);
    const flushed = wrapped.flush().then(
      () => "flushed",
      (e: Error) => e.message,
    );
    policy.revoke("gone");
    const pending = new Promise((r) => setTimeout(() => r("still pending"), 50));
    expect(await Promise.race([flushed, pending])).toBe("gone");
  });
});

/** `f`, a one-segment frame, re-framed with empty segments to `n` in all. */
function withSegments(f: Uint8Array, n: number): Uint8Array {
  const words = new DataView(f.buffer, f.byteOffset).getUint32(4, true);
  let table = 4 + 4 * n;
  if (table % 8 !== 0) table += 4;
  const out = new Uint8Array(table + words * 8);
  const view = new DataView(out.buffer);
  view.setUint32(0, n - 1, true);
  view.setUint32(4, words, true);
  out.set(f.subarray(8, 8 + words * 8), table);
  return out;
}

describe("RPC frames are flat arrays (serialize-async.c++ BufferedMessageStream)", () => {
  for (const n of [512, 1000]) {
    test(`a ${n}-segment frame is read`, () => {
      const f = withSegments(bootstrap(0), n);
      expect(frameLength(f)).toBe(f.length);
      const r = raw(ping);
      r.send(f);
      const out = r.take();
      expect(out.map((m) => m.which)).toEqual([Message.return]);
      expect(r.vat.disconnected).toBeUndefined();
    });
  }

  test("a segment count that overflows is refused", () => {
    expect(() => frameLength(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]))).toThrow(
      "expected segmentCount != 0 [0 != 0]; Message segment count too large, caused overflow.",
    );
  });

  test("a flat reader accepts 512 segments", () => {
    expect(CapnpMessage.fromFlat(withSegments(bootstrap(0), 512)).segmentCount).toBe(512);
  });
});

describe("incoming frame size (serialize-async.c++ readEntireMessage)", () => {
  const header = (words: number): Uint8Array => {
    const h = new Uint8Array(8);
    new DataView(h.buffer).setUint32(4, words, true);
    return h;
  };

  test("a frame over the traversal limit is refused from its segment table", () => {
    expect(() => frameLength(header(8 * 1024 * 1024 + 1))).toThrow(
      "expected expectedSizeInWords <= options.traversalLimitInWords [8388610 <= 8388608]; " +
        "incoming RPC message exceeds size limit",
    );
  });

  test("a frame at the limit waits for its body", () => {
    expect(frameLength(header(8 * 1024 * 1024 - 1))).toBe(0);
  });

  test("the limit can be set", () => {
    expect(() => frameLength(header(100), 64)).toThrow("[101 <= 64]");
  });
});

describe("incoming flow limit (rpc.c++ messageLoop, setFlowLimit)", () => {
  const gated = (): { server: RpcServer; seen: number[]; open: () => void } => {
    const seen: number[] = [];
    let open!: () => void;
    const gate = new Promise<void>((res) => (open = res));
    return {
      seen,
      open: () => open(),
      server: {
        dispatch(_i, _m, params) {
          seen.push(params.getU32(0));
          return gate;
        },
      },
    };
  };

  const twoCalls = (flowLimit?: number) => {
    const g = gated();
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, g.server, undefined, { flowLimit });
    pair.b.send(bootstrap(0));
    pair.b.send(call(1, (t) => toAnswer(t, 0), undefined, (p) => p.setU32(0, 1)));
    pair.b.send(call(2, (t) => toAnswer(t, 0), undefined, (p) => p.setU32(0, 2)));
    vat.pump();
    return { ...g, vat };
  };

  test("calls past the limit wait until earlier calls complete", async () => {
    const { seen, open } = twoCalls(1);
    expect(seen).toEqual([1]);
    open();
    await nextTurn();
    await nextTurn();
    expect(seen).toEqual([1, 2]);
  });

  test("without a limit every call is read", () => {
    expect(twoCalls().seen).toEqual([1, 2]);
  });

  test("raising the limit reads what was held back", async () => {
    const { seen, vat } = twoCalls(1);
    vat.setFlowLimit(1 << 20);
    await nextTurn();
    expect(seen).toEqual([1, 2]);
  });

  test("a call counts its segment words and leaves out the segment table", () => {
    for (const segments of [1, 3]) {
      const one = call(1, (t) => toAnswer(t, 0), undefined, (p) => p.setU32(0, 1));
      const g = gated();
      const pair = new MemoryTransportPair();
      const vat = new RpcConnection(pair.a, g.server, undefined, { flowLimit: one.length / 8 - 1 });
      pair.b.send(bootstrap(0));
      pair.b.send(withSegments(one, segments));
      pair.b.send(call(2, (t) => toAnswer(t, 0), undefined, (p) => p.setU32(0, 2)));
      vat.pump();
      expect(g.seen).toEqual([1, 2]);
    }
  });
});

describe("a released export of a promise (rpc.c++ handleRelease)", () => {
  test("lets go of the promise and sends no Resolve once it settles", async () => {
    let disposed = 0;
    let settle!: (c: Client) => void;
    const r = raw(
      returning(() => Client.fromPromise(new Promise<Client>((res) => (settle = res)))),
    );
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    expect(capKinds(r.take()[1]!.body)).toEqual([CapDescriptor.senderPromise]);
    r.send(
      frame(Message.finish, (m) => {
        const f = m.initStruct(0, 1, 0);
        f.setU32(0, 1);
        f.setBool(32, false, true);
      }),
    );
    r.send(
      frame(Message.release, (m) => {
        const rel = m.initStruct(0, 1, 0);
        rel.setU32(0, 1);
        rel.setU32(4, 1);
      }),
    );
    expect(r.vat.liveExports()).toEqual([0]);
    settle(Client.local({ dispatch() {}, dispose: () => void disposed++ }));
    await nextTurn();
    await nextTurn();
    expect(disposed).toBe(1);
    expect(r.take()).toEqual([]);
  });
});

describe("received exceptions read as remote (rpc.c++ toException)", () => {
  const returnException = (reason: string): Uint8Array =>
    frame(Message.return, (m) => {
      const ret = m.initStruct(0, 2, 1);
      ret.setU16(6, Return.exception);
      ret.initStruct(0, 1, 2).setText(0, reason);
    });
  const resolveException = (promiseId: number, reason: string): Uint8Array =>
    frame(Message.resolve, (m) => {
      const r = m.initStruct(0, 1, 1);
      r.setU32(0, promiseId);
      r.setU16(4, Resolve.exception);
      r.initStruct(0, 1, 2).setText(0, reason);
    });
  /** Method 0 keeps the capability in params pointer 0; method 1 waits on it. */
  const keeper = (): { server: RpcServer; held: () => Client } => {
    let held: Client | undefined;
    return {
      server: {
        dispatch(_i, m, params, _r, ctx) {
          if (m === 0) held = new Client(ctx.getCap(params.getP(0)).addRef());
          else return held!.whenResolved();
        },
      },
      held: () => held!,
    };
  };

  test("a Return.exception reads with the remote prefix", async () => {
    const r = raw();
    const cap = r.vat.bootstrap();
    r.send(returnException("bad"));
    await expect(Promise.resolve(cap.call(IFACE, 0))).rejects.toMatchObject({
      message: "remote exception: bad",
    });
  });

  test("a reason that already has the prefix is not prefixed twice", async () => {
    const r = raw();
    const cap = r.vat.bootstrap();
    r.send(returnException("remote exception: bad"));
    await expect(Promise.resolve(cap.call(IFACE, 0))).rejects.toMatchObject({
      message: "remote exception: bad",
    });
  });

  test("a Resolve.exception reads with the remote prefix", async () => {
    const k = keeper();
    const r = raw(k.server);
    r.send(bootstrap(0));
    r.send(callWithCap(1, (t) => toAnswer(t, 0), CapDescriptor.senderPromise, 5));
    await nextTurn();
    r.send(resolveException(5, "gone"));
    await expect(k.held().whenResolved()).rejects.toMatchObject({ message: "remote exception: gone" });
  });

  test("an exception passed on to the peer carries the prefix once", async () => {
    const r = raw(keeper().server);
    r.send(bootstrap(0));
    r.send(callWithCap(1, (t) => toAnswer(t, 0), CapDescriptor.senderPromise, 5));
    await nextTurn();
    r.send(resolveException(5, "gone"));
    r.send(
      frame(Message.call, (m) => {
        const c = m.initStruct(0, 3, 3);
        c.setU32(0, 2);
        c.setU64(8, IFACE);
        c.setU16(4, 1);
        toAnswer(c.initStruct(0, 1, 1), 0);
      }),
    );
    await nextTurn();
    await nextTurn();
    const ret = r.take().find((m) => m.which === Message.return && Return_getAnswerId(m.body) === 2);
    expect(Return_which(ret!.body)).toBe(Return.exception);
    expect(Exception_getReason(Return_getException(ret!.body))).toBe("remote exception: gone");
  });
});

describe("Exception.trace (rpc.c++ toException, fromException)", () => {
  const failing: RpcServer = {
    dispatch() {
      throw new RpcError("nope");
    },
  };

  test("a received trace is kept as the remote trace", async () => {
    const r = raw();
    const cap = r.vat.bootstrap();
    r.send(
      frame(Message.return, (m) => {
        const ret = m.initStruct(0, 2, 1);
        ret.setU16(6, Return.exception);
        const e = ret.initStruct(0, 1, 2);
        e.setText(0, "bad");
        e.setText(1, "at the far end");
      }),
    );
    const err = await Promise.resolve(cap.call(IFACE, 0)).catch((e: RpcError) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).remoteTrace).toBe("at the far end");
  });

  test("an Abort's trace is kept", () => {
    const r = raw();
    r.send(
      frame(Message.abort, (m) => {
        const e = m.initStruct(0, 1, 2);
        e.setText(0, "bye");
        e.setText(1, "stack");
      }),
    );
    expect(r.vat.disconnected?.message).toBe("remote exception: bye");
    expect(r.vat.disconnected?.remoteTrace).toBe("stack");
  });

  test("no trace is sent without an encoder", () => {
    const r = raw(failing);
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    const exc = Return_getException(r.take()[1]!.body);
    expect(exc.getP(1).kind).toBe(PtrKind.Null);
  });

  test("a trace encoder fills the trace", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.a, failing, undefined, {
      traceEncoder: (e) => `trace of ${e.message}`,
    });
    pair.b.send(bootstrap(0));
    pair.b.send(call(1, (t) => toAnswer(t, 0)));
    vat.pump();
    pair.b.receive();
    const ret = CapnpMessage.fromFlat(pair.b.receive()!).root().getP(0);
    expect(Exception_getTrace(Return_getException(ret))).toBe("trace of nope");
  });
});

describe("named Bootstrap (ez-rpc.c++ restore, rpc.c++ handleBootstrap)", () => {
  const named = (q: number, name: string): Uint8Array =>
    frame(Message.bootstrap, (m) => {
      const bs = m.initStruct(0, 1, 1);
      bs.setU32(0, q);
      bs.setText(0, name);
    });
  const echo = (): Client => new Client(new LocalClient({ dispatch() {} }));

  test("a restorer answers a named export", () => {
    const exports = new ExportMap();
    exports.exportCap("echo", echo());
    const r = raw(undefined, undefined, { restorer: exports.restore });
    r.send(named(0, "echo"));
    const [ret] = r.take();
    expect(Return_which(ret!.body)).toBe(Return.results);
    expect(capKinds(ret!.body)).toEqual([CapDescriptor.senderHosted]);
  });

  test("an unknown name fails as EzRpcServer does", () => {
    const r = raw(echo(), undefined, { restorer: new ExportMap().restore });
    r.send(named(0, "nope"));
    const [ret] = r.take();
    expect(Return_which(ret!.body)).toBe(Return.exception);
    expect(Exception_getReason(Return_getException(ret!.body))).toBe(
      "Server exports no such capability.; name = nope",
    );
  });

  test("a restorer serves the main interface when no bootstrap is given", () => {
    const r = raw(undefined, undefined, { restorer: new ExportMap(echo()).restore });
    r.send(bootstrap(0));
    const [ret] = r.take();
    expect(capKinds(ret!.body)).toEqual([CapDescriptor.senderHosted]);
  });

  test("releasing the registered client leaves the export answering", () => {
    let calls = 0;
    const cap = new Client(
      new LocalClient({
        dispatch(_i, _m, _p, results) {
          calls++;
          results.setU32(0, 4);
        },
      }),
    );
    const exports = new ExportMap();
    exports.exportCap("echo", cap);
    cap.release();
    const r = raw(undefined, undefined, { restorer: exports.restore });
    r.send(named(0, "echo"));
    const [ret] = r.take();
    expect(Return_which(ret!.body)).toBe(Return.results);
    r.send(call(1, (t) => {
      t.setU16(4, MessageTarget.importedCap);
      t.setU32(0, 0);
    }));
    const [reply] = r.take();
    expect(Return_which(reply!.body)).toBe(Return.results);
    expect(calls).toBe(1);
    expect(r.vat.disconnected).toBeUndefined();
  });

  test("`restore(name)` sends the name as the object id", () => {
    const r = raw();
    r.vat.restore("echo");
    const [bs] = r.take();
    expect(bs!.which).toBe(Message.bootstrap);
    expect(bs!.body.getText(0)).toBe("echo");
  });
});

describe("a Return follows the work its call set off (rpc.c++ handleCall, resolveExportedPromise)", () => {
  /** Call 0 returns a promise; any later call settles it with `settleTo` and returns at once. */
  const promiser = (settleTo: () => Client): RpcServer => {
    let settle: ((c: Client) => void) | undefined;
    return {
      dispatch(_i, method, _p, _r, ctx) {
        if (method === 0) {
          const p = Client.fromPromise(new Promise<Client>((res) => (settle = res)));
          ctx.setResultCap(ctx.initResults(0, 1), 0, p.hook);
          return;
        }
        settle?.(settleTo());
        settle = undefined;
      },
    };
  };
  const callM = (q: number, method: number): Uint8Array =>
    call(q, (t) => toAnswer(t, 0), (c) => c.setU16(4, method));
  const kinds = (out: Array<{ which: number; body: Ptr }>): string[] =>
    out.map((m) =>
      m.which === Message.return ? `return ${Return_getAnswerId(m.body)}` : m.which === Message.resolve ? "resolve" : `${m.which}`,
    );

  test("an exported promise the call resolves is announced before the Return", async () => {
    const r = raw(promiser(() => new Client(newNullCap())));
    r.send(bootstrap(0));
    r.send(callM(1, 0));
    expect(kinds(r.take())).toEqual(["return 0", "return 1"]);
    r.send(callM(2, 1));
    await nextTurn();
    expect(kinds(r.take())).toEqual(["resolve", "return 2"]);
  });

  test("a later Return keeps its place behind one that waits", async () => {
    const r = raw(promiser(() => Client.local(ping)));
    r.send(bootstrap(0));
    r.send(callM(1, 0));
    r.take();
    r.send(callM(2, 1));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    r.send(callM(3, 1));
    await nextTurn();
    expect(kinds(r.take())).toEqual(["resolve", "return 2", "return 3"]);
  });

  test("with no exported promise outstanding the Return is sent at once", () => {
    const r = raw(ping);
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    expect(kinds(r.take())).toEqual(["return 0", "return 1"]);
  });
});

describe("results a method never wrote (rpc.c++ sendReturn, getResults)", () => {
  const content = (ret: Ptr): Ptr => Payload_getContent(Return_getResults(ret));

  test("a method that leaves its results alone returns a null content", () => {
    const r = raw({ dispatch() {} });
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    const ret = r.take()[1]!.body;
    expect(Return_which(ret)).toBe(Return.results);
    expect(content(ret).kind).toBe(PtrKind.Null);
  });

  test("a method that writes a default value returns a struct", () => {
    const r = raw({
      dispatch(_i, _m, _p, results) {
        results.setU32(0, 0);
      },
    });
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    expect(content(r.take()[1]!.body).kind).toBe(PtrKind.Struct);
  });

  test("a null content reads as a struct of defaults", async () => {
    const r = raw();
    const cap = r.vat.bootstrap();
    r.send(returnCap(0, 0));
    await cap.whenResolved();
    const p = cap.call(IFACE, 0);
    r.send(frame(Message.return, (m) => m.initStruct(0, 2, 1).setU32(0, 1)));
    const out = await p;
    expect(out.content.getU32(0)).toBe(0);
    expect(out.content.getP(0).kind).toBe(PtrKind.Null);
    expect(new Client(out.getCap(out.content.getP(0))).isBroken).toBe(true);
  });

  test("a null content is passed on as null", async () => {
    const a = raw({ dispatch() {} });
    const relay = raw({
      dispatch(_i, _m, _p, _r, ctx) {
        return ctx.tailCall(Client.local({ dispatch() {} }), IFACE, 0);
      },
    });
    a.send(bootstrap(0));
    a.send(call(1, (t) => toAnswer(t, 0)));
    expect(content(a.take()[1]!.body).kind).toBe(PtrKind.Null);
    relay.send(bootstrap(0));
    relay.send(call(1, (t) => toAnswer(t, 0)));
    await nextTurn();
    const ret = relay.take()[1]!.body;
    expect(Return_which(ret)).toBe(Return.results);
    expect(content(ret).kind).toBe(PtrKind.Null);
  });
});

/** A Return for question `q` whose results pointer 0 is filled by `fill`. */
function returnWith(
  q: number,
  fill: (b: MessageBuilder, content: StructBuilder, payload: StructBuilder) => void,
): Uint8Array {
  const b = new MessageBuilder();
  const root = b.initRoot(1, 1);
  root.setU16(0, Message.return);
  const ret = root.initStruct(0, 2, 1);
  ret.setU32(0, q);
  const payload = ret.initStruct(0, 0, 2);
  fill(b, payload.initStruct(0, 0, 1), payload);
  return b.toFlat();
}

describe("capability pointers a cap table cannot serve (layout.c++ readCapabilityPointer)", () => {
  const reader: RpcServer = {
    dispatch(_i, _m, params, _r, ctx) {
      ctx.getCap(params.getP(0)).release();
    },
  };
  const reasonOf = (r: Raw, answer: number): string => {
    const ret = r.take().find((m) => m.which === Message.return && Return_getAnswerId(m.body) === answer);
    expect(Return_which(ret!.body)).toBe(Return.exception);
    return Exception_getReason(Return_getException(ret!.body));
  };

  test("a `none` entry read from params fails the call", () => {
    const r = raw(reader);
    r.send(bootstrap(0));
    r.send(callWithCap(1, (t) => toAnswer(t, 0), CapDescriptor.none, 0));
    expect(reasonOf(r, 1)).toBe("Message contains invalid capability pointer.");
    expect(r.vat.disconnected).toBeUndefined();
  });

  test("a `none` entry no pointer reads is harmless", () => {
    const r = raw(ping);
    r.send(bootstrap(0));
    r.send(callWithCap(1, (t) => toAnswer(t, 0), CapDescriptor.none, 0));
    const ret = r.take().find((m) => m.which === Message.return && Return_getAnswerId(m.body) === 1);
    expect(Return_which(ret!.body)).toBe(Return.results);
  });

  test("a struct where params hold a capability is a schema mismatch", () => {
    const r = raw(reader);
    r.send(bootstrap(0));
    r.send(
      frame(Message.call, (m) => {
        const c = m.initStruct(0, 3, 3);
        c.setU32(0, 1);
        c.setU64(8, IFACE);
        toAnswer(c.initStruct(0, 1, 1), 0);
        c.initStruct(1, 0, 2).initStruct(0, 0, 1).initStruct(0, 1, 0);
      }),
    );
    expect(reasonOf(r, 1)).toBe(
      "Schema mismatch: Message contains non-capability pointer where capability pointer was expected.",
    );
  });

  test("results that name a `none` entry fail when read and when pipelined", async () => {
    const r = raw();
    const call = r.vat.bootstrap().call(IFACE, 0);
    r.send(
      returnWith(1, (b, content, payload) => {
        content.adopt(0, Orphan.cap(b, 0));
        payload.initCompositeList(1, 1, 1, 1).setU16(0, CapDescriptor.none);
      }),
    );
    const results = await call;
    expect(() => results.getCap(results.content.getP(0))).toThrow(
      "Message contains invalid capability pointer.",
    );
    await expect(Promise.resolve(call.pipeline(0).call(IFACE, 0))).rejects.toMatchObject({
      message: "Message contains invalid capability pointer.",
    });
  });
});

describe("Resolve messages capnp-C++ refuses (rpc.c++ handleResolve)", () => {
  const resolveWhich = (which: number, desc?: (d: StructBuilder) => void): Uint8Array =>
    frame(Message.resolve, (m) => {
      const r = m.initStruct(0, 1, 1);
      r.setU32(0, 5);
      r.setU16(4, which);
      if (desc !== undefined) desc(r.initStruct(0, 1, 1));
    });
  const abortReason = async (f: Uint8Array): Promise<string> => {
    const r = raw(echoCap);
    r.send(bootstrap(0));
    r.send(callWithCap(1, (t) => toAnswer(t, 0), CapDescriptor.senderPromise, 5));
    await nextTurn();
    r.take();
    r.send(f);
    const abort = r.take().find((m) => m.which === Message.abort);
    return Exception_getReason(abort!.body);
  };

  test("a Resolve to `CapDescriptor.none` aborts", async () => {
    expect(await abortReason(resolveWhich(Resolve.cap, (d) => d.setU16(0, CapDescriptor.none)))).toBe(
      "'Resolve' contained 'CapDescriptor.none'.",
    );
    expect(await abortReason(resolveWhich(Resolve.cap))).toBe("'Resolve' contained 'CapDescriptor.none'.");
  });

  test("a Resolve of an unknown type aborts", async () => {
    expect(await abortReason(resolveWhich(7))).toBe("Unknown 'Resolve' type.");
  });
});

describe("the null capability (capability.c++ newNullCap)", () => {
  test("calls on it fail with the capnp-C++ text", async () => {
    await expect(Promise.resolve(new Client(newNullCap()).call(IFACE, 0))).rejects.toMatchObject({
      message: "Called null capability.",
    });
  });
});

describe("pipeline paths through null pointers (any.c++ getPipelinedCap)", () => {
  test("a null step reads as an empty struct and ends at a null capability", async () => {
    let open!: () => void;
    const gate = new Promise<void>((res) => (open = res));
    const r = raw({
      dispatch(_i, _m, _p, _r, ctx) {
        ctx.initResults(1, 0);
        return gate;
      },
    });
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    r.send(call(2, (t) => toAnswer(t, 1, [0])));
    r.send(call(3, (t) => toAnswer(t, 1, [0, 0])));
    open();
    await nextTurn();
    await nextTurn();
    const reasons = r
      .take()
      .filter((m) => m.which === Message.return && Return_getAnswerId(m.body) >= 2)
      .map((m) => Exception_getReason(Return_getException(m.body)));
    expect(reasons).toEqual(["Called null capability.", "Called null capability."]);
  });
});

describe("a call's param capabilities (rpc.c++ RpcCallContext paramsCapTable)", () => {
  test("are released after the call's Return", async () => {
    for (const server of [ping, { dispatch: () => Promise.reject(new RpcError("no")) }]) {
      const r = raw(server);
      r.send(bootstrap(0));
      r.take();
      r.send(callWithCap(1, (t) => toAnswer(t, 0), CapDescriptor.senderHosted, 5));
      await nextTurn();
      expect(r.take().map((m) => m.which)).toEqual([Message.return, Message.release]);
    }
  });
});

function abortReasonOf(r: Raw): string | undefined {
  const abort = r.take().find((m) => m.which === Message.abort);
  return abort === undefined ? undefined : Exception_getReason(abort.body);
}

describe("protocol abort texts (rpc.c++ releaseExport, handleCall, handleDisembargo)", () => {
  const release = (id: number, count: number): Uint8Array =>
    frame(Message.release, (m) => {
      const r = m.initStruct(0, 1, 0);
      r.setU32(0, id);
      r.setU32(4, count);
    });

  test("a Release of an unknown export", () => {
    const r = raw(ping);
    r.send(bootstrap(0));
    r.send(release(99, 1));
    expect(abortReasonOf(r)).toBe("Tried to release invalid export ID.");
  });

  test("a Release below an export's refcount", () => {
    const r = raw(ping);
    r.send(bootstrap(0));
    r.send(release(0, 5));
    expect(abortReasonOf(r)).toBe(
      "expected refcount <= exp->refcount [5 <= 1]; Tried to drop export's refcount below zero.",
    );
  });

  test("a Call with an unknown `sendResultsTo`", () => {
    const r = raw(ping);
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0), (c) => c.setU16(6, 7)));
    expect(abortReasonOf(r)).toBe("Unsupported `Call.sendResultsTo`.");
  });

  test("a receiver-loopback Disembargo for an unknown embargo", () => {
    const r = raw(ping);
    r.send(bootstrap(0));
    r.send(
      frame(Message.disembargo, (m) => {
        const d = m.initStruct(0, 1, 1);
        d.initStruct(0, 1, 1).setU32(0, 0);
        d.setU16(4, 1);
        d.setU32(0, 99);
      }),
    );
    expect(abortReasonOf(r)).toBe("Invalid embargo ID in 'Disembargo.context.receiverLoopback'.");
  });
});

describe("aborts that print a KJ parameter (rpc.c++ getMessageTarget, toPipelineOps, handleUnimplemented)", () => {
  test("an unknown target type prints the target", () => {
    const r = raw(ping);
    r.send(bootstrap(0));
    r.send(call(1, (t) => t.setU16(4, 5)));
    expect(abortReasonOf(r)).toBe("Unknown message target type.; target = ()");
  });

  test("an unknown pipeline op prints its kind", () => {
    const r = raw(ping);
    r.send(bootstrap(0));
    r.send(
      call(1, (t) => {
        t.setU16(4, 1);
        t.initStruct(0, 1, 1).initCompositeList(0, 1, 1, 0).setU16(0, 2);
      }),
    );
    expect(abortReasonOf(r)).toBe("Unsupported pipeline op.; (uint)opReader.which() = 2");
  });

  test("an Unimplemented echo of a required message prints its kind", () => {
    const echoed = (fill?: (m: StructBuilder) => void): Uint8Array =>
      frame(Message.unimplemented, (m) => fill?.(m.initStruct(0, 1, 1)));
    const r = raw(ping);
    r.send(
      echoed((inner) => {
        inner.setU16(0, Message.call);
        inner.initStruct(0, 3, 3);
      }),
    );
    expect(abortReasonOf(r)).toBe("Peer did not implement required RPC message type.; (uint)message.which() = 2");
    const n = raw(ping);
    n.send(frame(Message.unimplemented));
    expect(abortReasonOf(n)).toBe("Peer did not implement required RPC message type.; (uint)message.which() = 0");
  });
});

describe("descriptors naming what this side lacks (rpc.c++ receiveCap)", () => {
  const callOnResult = async (kind: number, desc: (d: StructBuilder) => void): Promise<string> => {
    const b = new MessageBuilder();
    const root = b.initRoot(1, 1);
    root.setU16(0, Message.call);
    const c = root.initStruct(0, 3, 3);
    c.setU32(0, 1);
    c.setU64(8, IFACE);
    toAnswer(c.initStruct(0, 1, 1), 0);
    const payload = c.initStruct(1, 0, 2);
    payload.initStruct(0, 0, 1).adopt(0, Orphan.cap(b, 0));
    const entry = payload.initCompositeList(1, 1, 1, 1);
    entry.setU16(0, kind);
    desc(entry);
    const r = raw(echoCap);
    r.send(bootstrap(0));
    r.send(b.toFlat());
    r.send(call(2, (t) => toAnswer(t, 1, [0])));
    await nextTurn();
    const ret = r.take().find((m) => m.which === Message.return && Return_getAnswerId(m.body) === 2);
    return Exception_getReason(Return_getException(ret!.body));
  };

  test("an unknown `receiverHosted` export", async () => {
    expect(await callOnResult(CapDescriptor.receiverHosted, (d) => d.setU32(4, 99))).toBe(
      "invalid 'receiverHosted' export ID",
    );
  });

  test("an unknown `receiverAnswer` question", async () => {
    expect(
      await callOnResult(CapDescriptor.receiverAnswer, (d) => d.initStruct(0, 1, 1).setU32(0, 99)),
    ).toBe("invalid 'receiverAnswer'");
  });
});

describe("a null PromisedAnswer reads as question 0 (rpc.c++ getMessageTarget, receiveCap)", () => {
  test("as a call target", () => {
    const r = raw(ping);
    r.send(bootstrap(0));
    r.take();
    r.send(call(1, (t) => t.setU16(4, MessageTarget.promisedAnswer), undefined, (p) => p.setU32(0, 3)));
    const ret = r.take().find((m) => m.which === Message.return);
    expect(Return_which(ret!.body)).toBe(Return.results);
    expect(Payload_getContent(Return_getResults(ret!.body)).getU32(0)).toBe(4);
  });

  test("as a `receiverAnswer` descriptor", async () => {
    const r = raw(echoCap);
    r.send(bootstrap(0));
    r.send(callWithCap(1, (t) => toAnswer(t, 0), CapDescriptor.receiverAnswer, 0));
    await nextTurn();
    r.take();
    r.send(call(2, (t) => toAnswer(t, 1, [0])));
    await nextTurn();
    const ret = r.take().find((m) => m.which === Message.return && Return_getAnswerId(m.body) === 2);
    expect(Return_which(ret!.body)).toBe(Return.results);
  });
});

describe("Call checks in capnp-C++ order (rpc.c++ handleCall)", () => {
  const pending: RpcServer = { dispatch: () => new Promise<void>(() => {}) };
  const withPending = (): Raw => {
    const r = raw(pending);
    r.send(bootstrap(0));
    r.send(call(1, (t) => toAnswer(t, 0)));
    r.take();
    return r;
  };

  test("a reused question is canceled, its params released, then the connection aborts", () => {
    const r = withPending();
    r.send(callWithCap(1, (t) => toAnswer(t, 0), CapDescriptor.senderHosted, 5));
    const out = r.take();
    expect(out.map((m) => m.which)).toEqual([Message.return, Message.release, Message.abort]);
    expect(Return_which(out[0]!.body)).toBe(Return.canceled);
    expect(Return_getAnswerId(out[0]!.body)).toBe(1);
    expect(Return_getReleaseParamCaps(out[0]!.body)).toBe(false);
    expect(Exception_getReason(out[2]!.body)).toBe("expected !answer.active; questionId is already in use");
  });

  test("the target is checked first, then `sendResultsTo`, then the question", () => {
    const badTarget = (t: StructBuilder): void => t.setU32(0, 99);
    let r = withPending();
    r.send(call(1, badTarget));
    expect(abortReasonOf(r)).toBe("Message target is not a current export ID.");
    r = withPending();
    r.send(call(1, (t) => toAnswer(t, 0), (c) => c.setU16(6, 7)));
    expect(abortReasonOf(r)).toBe("Unsupported `Call.sendResultsTo`.");
    r = withPending();
    r.send(call(2, badTarget, (c) => c.setU16(6, 7)));
    expect(abortReasonOf(r)).toBe("Message target is not a current export ID.");
  });

  test("a reused Bootstrap question", () => {
    const r = raw(ping);
    r.send(bootstrap(0));
    r.send(bootstrap(0));
    expect(abortReasonOf(r)).toBe("expected !answer.active; questionId is already in use; answerId = 0");
  });
});
