/**
 * The client half of level 1: asking questions rather than only
 * answering them, and the `-> stream` flow-control window.
 *
 * Two vats share a transport pair, so every message is a real frame and
 * the two are pumped in lockstep.
 */
import { describe, expect, test } from "bun:test";
import { Message as CapnpMessage, MessageBuilder, Ptr, type StructBuilder } from "../../runtime/src/index.ts";

import {
  MESSAGE_DWORDS,
  MESSAGE_PWORDS,
  Message,
  Message_which,
  PAYLOAD_DWORDS,
  PAYLOAD_PWORDS,
  RETURN_DWORDS,
  RETURN_PWORDS,
} from "../src/rpc.capnp.ts";

import { MemoryTransportPair } from "../src/transport.ts";
import { RpcConnection, type RpcServer } from "../src/vat.ts";

class Doubler implements RpcServer {
  calls = 0;
  failFrom = Number.POSITIVE_INFINITY;
  dispatch(
    _interfaceId: bigint,
    _methodId: number,
    params: Ptr,
    results: StructBuilder,
  ): void {
    this.calls++;
    if (this.calls >= this.failFrom) throw new Error("server refused");
    results.setU32(0, params.getU32(0) * 2);
  }
}

/** A caller and a callee over one transport pair. */
function connectedPair(server: RpcServer) {
  const pair = new MemoryTransportPair();
  return {
    client: new RpcConnection(pair.a),
    vat: new RpcConnection(pair.b, server),
  };
}

describe("client questions", () => {
  test("bootstrap resolves to the peer's capability", () => {
    const { client, vat } = connectedPair(new Doubler());

    const q = client.sendBootstrap();
    expect(client.isAnswered(q)).toBe(false);

    vat.pump();
    client.pump();

    expect(client.isAnswered(q)).toBe(true);
    expect(client.isFailed(q)).toBe(false);
    // The bootstrap answer's content is the capability itself.
    expect(client.answerContent(q)?.kind).toBe(3); // PtrKind.Cap
  });

  test("a call returns the server's results to the caller", () => {
    const server = new Doubler();
    const { client, vat } = connectedPair(server);

    client.sendBootstrap();
    vat.pump();
    client.pump();

    const q = client.sendCall(0, 0x1234n, 1, (p) => p.setU32(0, 21));
    vat.pump();
    client.pump();

    expect(client.isAnswered(q)).toBe(true);
    expect(client.isFailed(q)).toBe(false);
    expect(client.answerContent(q)?.getU32(0)).toBe(42);
    expect(server.calls).toBe(1);
  });

  test("a call the vat cannot route comes back failed, not silent", () => {
    const { client, vat } = connectedPair(new Doubler());

    const q = client.sendCall(99, 0n, 0);
    vat.pump();
    client.pump();

    expect(client.isAnswered(q)).toBe(true);
    expect(client.isFailed(q)).toBe(true);
    expect(client.answerContent(q)).toBeUndefined();
  });

  test("a Return for a question we never asked aborts the connection", () => {
    const pair = new MemoryTransportPair();
    const client = new RpcConnection(pair.a);

    // A Return naming question 77, which this client never sent.
    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(0, Message.return);
    const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
    ret.setU32(0, 77);
    ret.setU16(6, 0); // results
    ret.initStruct(0, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
    pair.b.send(b.toFlat());

    expect(client.pump()).toBe(1);
    expect(client.disconnected?.message).toContain("Invalid question ID");
    expect(client.isAnswered(77)).toBe(false);
    expect(Message_which(CapnpMessage.fromFlat(pair.b.receive()!).root())).toBe(Message.abort);
  });
});
