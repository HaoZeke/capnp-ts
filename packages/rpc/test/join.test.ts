/**
 * Level 4 `Join`: does a set of capabilities name one object?
 *
 * The vat is driven with raw messages rather than through a client
 * façade, so each assertion is about the wire behaviour the spec
 * prescribes and not about a convenience layer on top of it.
 */
import { describe, expect, test } from "bun:test";
import {
  Message as CapnpMessage,
  MessageBuilder,
  Ptr,
  PtrKind,
  type StructBuilder,
} from "../../runtime/src/index.ts";

import {
  JOIN_KEY_PART_DWORDS,
  JOIN_KEY_PART_PWORDS,
  JoinResult_getCap,
  JoinResult_getJoinId,
  JoinResult_getSucceeded,
} from "../src/rpc-twoparty.capnp.ts";
import {
  BOOTSTRAP_DWORDS,
  BOOTSTRAP_PWORDS,
  JOIN_DWORDS,
  JOIN_PWORDS,
  MESSAGE_DWORDS,
  MESSAGE_PWORDS,
  MESSAGE_TARGET_DWORDS,
  MESSAGE_TARGET_PWORDS,
  Message,
  Message_getReturn,
  Message_which,
  MessageTarget,
  Payload_getContent,
  Return_getAnswerId,
  Return_getResults,
} from "../src/rpc.capnp.ts";
import { MemoryTransportPair, type Transport } from "../src/transport.ts";
import { RpcConnection, type RpcServer } from "../src/vat.ts";

class CountingServer implements RpcServer {
  calls = 0;
  dispatch(
    _interfaceId: bigint,
    _methodId: number,
    _params: Ptr,
    results: StructBuilder,
  ): void {
    this.calls++;
    results.setU32(0, this.calls);
  }
}

/** Send one Join part naming `exportId`. */
function sendJoinPart(
  t: Transport,
  questionId: number,
  exportId: number,
  joinId: number,
  partCount: number,
  partNum: number,
): void {
  const b = new MessageBuilder();
  const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
  root.setU16(0, Message.join);
  const join = root.initStruct(0, JOIN_DWORDS, JOIN_PWORDS);
  join.setU32(0, questionId);
  const target = join.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
  target.setU16(4, MessageTarget.importedCap);
  target.setU32(0, exportId);
  const key = join.initStruct(1, JOIN_KEY_PART_DWORDS, JOIN_KEY_PART_PWORDS);
  key.setU32(0, joinId);
  key.setU16(4, partCount);
  key.setU16(6, partNum);
  t.send(b.toFlat());
}

interface JoinReply {
  answerId: number;
  joinId: number;
  succeeded: boolean;
  hasCap: boolean;
}

function readJoinReply(t: Transport): JoinReply {
  const frame = t.receive();
  if (frame === null) throw new Error("expected a reply");
  const root = CapnpMessage.fromFlat(frame).root();
  expect(Message_which(root)).toBe(Message.return);
  const ret = Message_getReturn(root);
  const jr = Payload_getContent(Return_getResults(ret));
  return {
    answerId: Return_getAnswerId(ret),
    joinId: JoinResult_getJoinId(jr),
    succeeded: JoinResult_getSucceeded(jr),
    hasCap: JoinResult_getCap(jr).kind === PtrKind.Cap,
  };
}

function bootstrapExport(t: Transport, vat: RpcConnection, questionId: number): void {
  const b = new MessageBuilder();
  const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
  root.setU16(0, Message.bootstrap);
  const boot = root.initStruct(0, BOOTSTRAP_DWORDS, BOOTSTRAP_PWORDS);
  boot.setU32(0, questionId);
  t.send(b.toFlat());
  vat.pump();
  t.receive(); // discard the Return; the export is what matters here
}

describe("RPC level 4: Join", () => {
  test("two parts naming one capability join, and one result carries the cap", () => {
    const pair = new MemoryTransportPair();
    const server = new CountingServer();
    const vat = new RpcConnection(pair.b, server);
    bootstrapExport(pair.a, vat, 1);

    const [only] = vat.liveExports();
    expect(only).toBeDefined();

    sendJoinPart(pair.a, 700, only!, 9, 2, 0);
    vat.pump();
    // An incomplete set is not answerable, so nothing comes back yet.
    expect(pair.a.pending).toBe(0);

    sendJoinPart(pair.a, 701, only!, 9, 2, 1);
    vat.pump();
    expect(pair.a.pending).toBe(2);

    const first = readJoinReply(pair.a);
    const second = readJoinReply(pair.a);
    expect(first.joinId).toBe(9);
    expect(second.joinId).toBe(9);
    expect(first.succeeded).toBe(true);
    expect(second.succeeded).toBe(true);
    expect([first.answerId, second.answerId].sort()).toEqual([700, 701]);
    // JoinResult: exactly one of the set carries the joined capability.
    expect([first.hasCap, second.hasCap].filter(Boolean).length).toBe(1);
  });

  test("a part naming nothing we host fails the whole set", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new CountingServer());
    bootstrapExport(pair.a, vat, 1);
    const [live] = vat.liveExports();
    const dead = live! + 999;

    sendJoinPart(pair.a, 710, live!, 11, 2, 0);
    vat.pump();
    sendJoinPart(pair.a, 711, dead, 11, 2, 1);
    vat.pump();

    const first = readJoinReply(pair.a);
    const second = readJoinReply(pair.a);
    expect(first.succeeded).toBe(false);
    expect(second.succeeded).toBe(false);
    // A failed join carries no capability.
    expect(first.hasCap).toBe(false);
    expect(second.hasCap).toBe(false);
  });

  test("every part unresolvable still fails", () => {
    // The parts agree, but they agree on naming nothing: equality has to
    // be proven against a capability we host, not against absence.
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new CountingServer());
    bootstrapExport(pair.a, vat, 1);
    const [live] = vat.liveExports();
    const dead = live! + 999;

    sendJoinPart(pair.a, 740, dead, 17, 2, 0);
    vat.pump();
    sendJoinPart(pair.a, 741, dead, 17, 2, 1);
    vat.pump();

    const first = readJoinReply(pair.a);
    const second = readJoinReply(pair.a);
    expect(first.succeeded).toBe(false);
    expect(second.succeeded).toBe(false);
    expect(first.hasCap).toBe(false);
    expect(second.hasCap).toBe(false);
  });

  test("an incomplete set is never answered", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new CountingServer());
    bootstrapExport(pair.a, vat, 1);
    const [live] = vat.liveExports();

    sendJoinPart(pair.a, 720, live!, 13, 3, 0);
    vat.pump();
    sendJoinPart(pair.a, 721, live!, 13, 3, 1);
    vat.pump();
    // Two of three parts: the receiver still cannot compare the set.
    expect(pair.a.pending).toBe(0);
  });

  test("a partNum outside the set is rejected on its own", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new CountingServer());
    bootstrapExport(pair.a, vat, 1);
    const [live] = vat.liveExports();

    sendJoinPart(pair.a, 730, live!, 15, 2, 7);
    vat.pump();
    const reply = readJoinReply(pair.a);
    expect(reply.answerId).toBe(730);
    expect(reply.succeeded).toBe(false);
  });
});

describe("RPC level 3 is refused rather than mishandled", () => {
  test("Provide draws an unimplemented reply", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new CountingServer());
    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(0, Message.provide);
    pair.a.send(b.toFlat());
    vat.pump();

    const frame = pair.a.receive();
    expect(frame).not.toBeNull();
    const reply = CapnpMessage.fromFlat(frame!).root();
    expect(Message_which(reply)).toBe(Message.unimplemented);
  });
});
