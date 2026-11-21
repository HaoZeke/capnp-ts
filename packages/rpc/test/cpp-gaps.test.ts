/**
 * Behavior checked against capnp-C++ 1.4.0, one block per difference.
 * Most tests drive a vat with hand-built frames and read back exactly
 * what it sends, which is what interop/raw_frames.ts compares live.
 */
import { describe, expect, test } from "bun:test";
import {
  Message as CapnpMessage,
  MessageBuilder,
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
  Resolve,
  Resolve_getCap,
  Resolve_getException,
  Resolve_getPromiseId,
  Resolve_which,
  Return_getAnswerId,
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
