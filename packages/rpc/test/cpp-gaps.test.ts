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
import { Client, membrane, RevocablePolicy, RpcError, type RpcServer } from "../src/index.ts";
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

function raw(server?: RpcServer | Client, multiParty?: Vat): Raw {
  const pair = new MemoryTransportPair();
  const vat = new RpcConnection(pair.a, server, multiParty);
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
});
