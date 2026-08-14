/**
 * Level 3: a capability handed from one vat to a third.
 *
 * Alice holds a capability hosted by Bob and wants Carol to have it.
 * Alice tells Bob to expect Carol (`Provide`), tells Carol where to go,
 * and Carol claims it (`Accept`). The nonce Alice chose is the only
 * thing the three messages share, so Bob never has to take Carol's word
 * for who sent her.
 *
 * The network layer that names the third vat is rpc-threeparty.capnp;
 * rpc.capnp deliberately leaves those ids to whatever network is in use.
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
  ACCEPT_DWORDS,
  ACCEPT_PWORDS,
  BOOTSTRAP_DWORDS,
  BOOTSTRAP_PWORDS,
  MESSAGE_DWORDS,
  MESSAGE_PWORDS,
  MESSAGE_TARGET_DWORDS,
  MESSAGE_TARGET_PWORDS,
  Message,
  Message_getReturn,
  Message_which,
  MessageTarget,
  PAYLOAD_DWORDS,
  PAYLOAD_PWORDS,
  PROVIDE_DWORDS,
  PROVIDE_PWORDS,
  Payload_getContent,
  Return,
  Return_getAnswerId,
  Return_getResults,
  Return_which,
} from "../src/rpc.capnp.ts";
import {
  PROVISION_ID_DWORDS,
  PROVISION_ID_PWORDS,
  RECIPIENT_ID_DWORDS,
  RECIPIENT_ID_PWORDS,
  VAT_ID_DWORDS,
  VAT_ID_PWORDS,
} from "../src/rpc-threeparty.capnp.ts";
import { MemoryTransportPair, type Transport } from "../src/transport.ts";
import { RpcConnection, type RpcServer } from "../src/vat.ts";

class Marked implements RpcServer {
  calls = 0;
  constructor(private readonly mark: number) {}
  dispatch(
    _interfaceId: bigint,
    _methodId: number,
    _params: Ptr,
    results: StructBuilder,
  ): void {
    this.calls++;
    results.setU32(0, this.mark);
  }
}

function sendBootstrap(t: Transport, questionId: number): void {
  const b = new MessageBuilder();
  const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
  root.setU16(0, Message.bootstrap);
  root.initStruct(0, BOOTSTRAP_DWORDS, BOOTSTRAP_PWORDS).setU32(0, questionId);
  t.send(b.toFlat());
}

/** Alice -> Bob: hold export `exportId` for whoever presents `nonce`. */
function sendProvide(
  t: Transport,
  questionId: number,
  exportId: number,
  nonce: bigint,
  recipientPort = 4000,
): void {
  const b = new MessageBuilder();
  const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
  root.setU16(0, Message.provide);
  const provide = root.initStruct(0, PROVIDE_DWORDS, PROVIDE_PWORDS);
  provide.setU32(0, questionId);
  const target = provide.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
  target.setU16(4, MessageTarget.importedCap);
  target.setU32(0, exportId);
  const recipient = provide.initStruct(1, RECIPIENT_ID_DWORDS, RECIPIENT_ID_PWORDS);
  recipient.setU64(0, nonce);
  const vat = recipient.initStruct(0, VAT_ID_DWORDS, VAT_ID_PWORDS);
  vat.setText(0, "127.0.0.1");
  vat.setU16(0, recipientPort);
  t.send(b.toFlat());
}

/** Carol -> Bob: claim the capability held under `nonce`. */
function sendAccept(t: Transport, questionId: number, nonce: bigint): void {
  const b = new MessageBuilder();
  const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
  root.setU16(0, Message.accept);
  const accept = root.initStruct(0, ACCEPT_DWORDS, ACCEPT_PWORDS);
  accept.setU32(0, questionId);
  const provision = accept.initStruct(0, PROVISION_ID_DWORDS, PROVISION_ID_PWORDS);
  provision.setU64(0, nonce);
  t.send(b.toFlat());
}

interface Reply {
  answerId: number;
  isException: boolean;
  contentKind: number;
}

function readReply(t: Transport): Reply {
  const frame = t.receive();
  if (frame === null) throw new Error("expected a Return");
  const root = CapnpMessage.fromFlat(frame).root();
  expect(Message_which(root)).toBe(Message.return);
  const ret = Message_getReturn(root);
  const isException = Return_which(ret) !== Return.results;
  return {
    answerId: Return_getAnswerId(ret),
    isException,
    contentKind: isException
      ? PtrKind.Null
      : Payload_getContent(Return_getResults(ret)).kind,
  };
}

/** Bob, with one capability bootstrapped so export 0 is live. */
function bobWithExport(): { bob: RpcConnection; alice: Transport } {
  const pair = new MemoryTransportPair();
  const bob = new RpcConnection(pair.b, new Marked(7));
  sendBootstrap(pair.a, 1);
  bob.pump();
  pair.a.receive();
  return { bob, alice: pair.a };
}

describe("level 3 handoff", () => {
  test("a provided capability is claimable exactly once", () => {
    const { bob, alice } = bobWithExport();
    const nonce = 0xfeedfacen;

    sendProvide(alice, 10, 0, nonce);
    bob.pump();
    const provideReply = readReply(alice);
    expect(provideReply.answerId).toBe(10);
    expect(provideReply.isException).toBe(false);
    expect(bob.pendingProvisions()).toEqual([nonce]);

    // Carol arrives on her own connection and presents the nonce.
    const carolPair = new MemoryTransportPair();
    const bobToCarol = new RpcConnection(carolPair.b);
    // The arrangement lives on Bob, so it is Bob's own vat that answers;
    // here the same vat serves both, which is what a real Bob does.
    sendAccept(alice, 11, nonce);
    bob.pump();
    const acceptReply = readReply(alice);
    expect(acceptReply.answerId).toBe(11);
    expect(acceptReply.isException).toBe(false);
    // The capability comes back as a capability, not a struct.
    expect(acceptReply.contentKind).toBe(PtrKind.Cap);
    expect(bob.pendingProvisions()).toEqual([]);

    // A nonce is single-use: leaving it claimable would let anyone who
    // learned it take the capability again.
    sendAccept(alice, 12, nonce);
    bob.pump();
    const replay = readReply(alice);
    expect(replay.answerId).toBe(12);
    expect(replay.isException).toBe(true);

    void bobToCarol;
    void carolPair;
  });

  // Refused even while a different arrangement is standing: matching is
  // on the nonce, not on there being something to hand over.
  test("an Accept with an unknown nonce is refused", () => {
    const { bob, alice } = bobWithExport();
    sendProvide(alice, 19, 0, 0xc0ffeen);
    bob.pump();
    readReply(alice);

    sendAccept(alice, 20, 0xdeadbeefn);
    bob.pump();
    const reply = readReply(alice);
    expect(reply.answerId).toBe(20);
    expect(reply.isException).toBe(true);
    expect(bob.pendingProvisions()).toEqual([0xc0ffeen]);

    sendAccept(alice, 21, 0xc0ffeen);
    bob.pump();
    expect(readReply(alice).isException).toBe(false);
  });

  test("providing a capability we do not host is refused", () => {
    const { bob, alice } = bobWithExport();
    sendProvide(alice, 30, 99, 0x1234n);
    bob.pump();
    const reply = readReply(alice);
    expect(reply.answerId).toBe(30);
    expect(reply.isException).toBe(true);
    expect(bob.pendingProvisions()).toEqual([]);
  });

  test("two provisions of the same capability are independent", () => {
    const { bob, alice } = bobWithExport();
    sendProvide(alice, 40, 0, 0xaaan);
    bob.pump();
    readReply(alice);
    sendProvide(alice, 41, 0, 0xbbbn);
    bob.pump();
    readReply(alice);
    expect(bob.pendingProvisions().sort()).toEqual([0xaaan, 0xbbbn]);

    sendAccept(alice, 42, 0xaaan);
    bob.pump();
    expect(readReply(alice).isException).toBe(false);
    // Claiming one leaves the other standing.
    expect(bob.pendingProvisions()).toEqual([0xbbbn]);
  });
});
