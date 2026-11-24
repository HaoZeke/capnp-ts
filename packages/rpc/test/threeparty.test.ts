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
  DISEMBARGO_DWORDS,
  DISEMBARGO_PWORDS,
  Disembargo_context,
  BOOTSTRAP_DWORDS,
  BOOTSTRAP_PWORDS,
  CALL_DWORDS,
  CALL_PWORDS,
  FINISH_DWORDS,
  FINISH_PWORDS,
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
  PROMISED_ANSWER_DWORDS,
  PROMISED_ANSWER_PWORDS,
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
import { RpcError } from "../src/capability.ts";
import { MemoryTransportPair, type Transport } from "../src/transport.ts";
import { RpcConnection, type RpcServer, Vat } from "../src/vat.ts";

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

/** Carol -> Bob: claim the capability, but hold the answer. */
function sendAcceptEmbargoed(t: Transport, questionId: number, nonce: bigint): void {
  const b = new MessageBuilder();
  const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
  root.setU16(0, Message.accept);
  const accept = root.initStruct(0, ACCEPT_DWORDS, ACCEPT_PWORDS);
  accept.setU32(0, questionId);
  accept.setBool(32, true);
  accept.initStruct(0, PROVISION_ID_DWORDS, PROVISION_ID_PWORDS).setU64(0, nonce);
  t.send(b.toFlat());
}

/** Alice -> Bob: lift the embargo, naming her own Provide question. */
function sendDisembargoProvide(t: Transport, provideQuestionId: number): void {
  const b = new MessageBuilder();
  const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
  root.setU16(0, Message.disembargo);
  const dis = root.initStruct(0, DISEMBARGO_DWORDS, DISEMBARGO_PWORDS);
  dis.setU16(4, Disembargo_context.provide);
  dis.setU32(0, provideQuestionId);
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
  const bob = new RpcConnection(pair.b, new Marked(7), new Vat());
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
    const bobToCarol = new RpcConnection(carolPair.b, undefined, new Vat());
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

  // An embargoed Accept claims the capability but is not answered until
  // the introducer says the recipient's earlier calls have all arrived.
  // Answering sooner would let a call sent straight to Bob overtake one
  // still in flight through Alice.
  test("an embargoed Accept waits for the disembargo", () => {
    const { bob, alice } = bobWithExport();
    const nonce = 0x5150n;

    sendProvide(alice, 70, 0, nonce);
    bob.pump();
    expect(readReply(alice).isException).toBe(false);

    sendAcceptEmbargoed(alice, 71, nonce);
    bob.pump();
    expect(alice.receive()).toBeNull();
    expect(bob.embargoedAccepts()).toEqual([70]);
    // The arrangement is claimed, so a second Accept finds nothing.
    expect(bob.pendingProvisions()).toEqual([]);

    // A Disembargo naming a Provide Bob never received changes nothing.
    sendDisembargoProvide(alice, 999);
    bob.pump();
    expect(alice.receive()).toBeNull();
    expect(bob.embargoedAccepts()).toEqual([70]);

    sendDisembargoProvide(alice, 70);
    bob.pump();
    const reply = readReply(alice);
    expect(reply.answerId).toBe(71);
    expect(reply.isException).toBe(false);
    expect(reply.contentKind).toBe(PtrKind.Cap);
    expect(bob.embargoedAccepts()).toEqual([]);
  });

  test("an embargoed Accept from another connection waits for the provider's disembargo", () => {
    const vat = new Vat();
    const alicePair = new MemoryTransportPair();
    const bobToAlice = new RpcConnection(alicePair.b, new Marked(7), vat);
    const carolPair = new MemoryTransportPair();
    const bobToCarol = new RpcConnection(carolPair.b, undefined, vat);
    const alice = alicePair.a;
    const carol = carolPair.a;
    sendBootstrap(alice, 1);
    bobToAlice.pump();
    alice.receive();
    const nonce = 0x7ea5n;

    sendProvide(alice, 70, 0, nonce);
    bobToAlice.pump();
    expect(readReply(alice).isException).toBe(false);

    sendAcceptEmbargoed(carol, 5, nonce);
    bobToCarol.pump();
    expect(carol.receive()).toBeNull();
    expect(bobToAlice.embargoedAccepts()).toEqual([70]);
    expect(bobToCarol.embargoedAccepts()).toEqual([]);

    sendDisembargoProvide(alice, 70);
    bobToAlice.pump();
    expect(alice.receive()).toBeNull();
    const reply = readReply(carol);
    expect(reply.answerId).toBe(5);
    expect(reply.isException).toBe(false);
    expect(reply.contentKind).toBe(PtrKind.Cap);
    expect(bobToAlice.embargoedAccepts()).toEqual([]);
  });

  test("an embargoed Accept fails when the provider's connection ends", () => {
    const vat = new Vat();
    const alicePair = new MemoryTransportPair();
    const bobToAlice = new RpcConnection(alicePair.b, new Marked(7), vat);
    const carolPair = new MemoryTransportPair();
    const bobToCarol = new RpcConnection(carolPair.b, undefined, vat);
    sendBootstrap(alicePair.a, 1);
    bobToAlice.pump();
    alicePair.a.receive();
    sendProvide(alicePair.a, 70, 0, 0x7ea6n);
    bobToAlice.pump();
    alicePair.a.receive();
    sendAcceptEmbargoed(carolPair.a, 5, 0x7ea6n);
    bobToCarol.pump();

    bobToAlice.disconnect(new RpcError("alice went away", "disconnected"));
    const reply = readReply(carolPair.a);
    expect(reply.answerId).toBe(5);
    expect(reply.isException).toBe(true);
    expect(bobToCarol.disconnected).toBeUndefined();
  });
});

class Disposable extends Marked {
  disposed = 0;
  dispose(): void {
    this.disposed++;
  }
}

/** Bob serving Alice (the introducer) and Carol (the recipient) from one vat. */
function bobBetween() {
  const vat = new Vat();
  const server = new Disposable(7);
  const alicePair = new MemoryTransportPair();
  const bobToAlice = new RpcConnection(alicePair.b, server, vat);
  const carolPair = new MemoryTransportPair();
  const bobToCarol = new RpcConnection(carolPair.b, undefined, vat);
  sendBootstrap(alicePair.a, 1);
  bobToAlice.pump();
  alicePair.a.receive();
  return { server, bobToAlice, bobToCarol, alice: alicePair.a, carol: carolPair.a };
}

function sendCallOnAnswer(t: Transport, questionId: number, answerId: number): void {
  const b = new MessageBuilder();
  const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
  root.setU16(0, Message.call);
  const call = root.initStruct(0, CALL_DWORDS, CALL_PWORDS);
  call.setU32(0, questionId);
  const target = call.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
  target.setU16(4, MessageTarget.promisedAnswer);
  target.initStruct(0, PROMISED_ANSWER_DWORDS, PROMISED_ANSWER_PWORDS).setU32(0, answerId);
  call.initStruct(1, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
  t.send(b.toFlat());
}

function sendFinish(t: Transport, questionId: number): void {
  const b = new MessageBuilder();
  const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
  root.setU16(0, Message.finish);
  root.initStruct(0, FINISH_DWORDS, FINISH_PWORDS).setU32(0, questionId);
  t.send(b.toFlat());
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("embargoed Accept answers (rpc.capnp Accept.embargo)", () => {
  test("pipelined calls on an embargoed Accept wait for the disembargo", async () => {
    const { server, bobToAlice, bobToCarol, alice, carol } = bobBetween();
    sendProvide(alice, 70, 0, 0x51n);
    bobToAlice.pump();
    readReply(alice);
    sendAcceptEmbargoed(carol, 5, 0x51n);
    sendCallOnAnswer(carol, 6, 5);
    bobToCarol.pump();
    await tick();
    expect(carol.receive()).toBeNull();
    expect(server.calls).toBe(0);

    sendDisembargoProvide(alice, 70);
    bobToAlice.pump();
    await tick();
    const accepted = readReply(carol);
    expect(accepted.answerId).toBe(5);
    expect(accepted.contentKind).toBe(PtrKind.Cap);
    const called = readReply(carol);
    expect(called.answerId).toBe(6);
    expect(called.isException).toBe(false);
    expect(server.calls).toBe(1);
    expect(bobToCarol.disconnected).toBeUndefined();
  });

  test("Finish on an embargoed Accept cancels it and exports nothing", async () => {
    const { bobToAlice, bobToCarol, alice, carol } = bobBetween();
    sendProvide(alice, 70, 0, 0x52n);
    bobToAlice.pump();
    readReply(alice);
    sendAcceptEmbargoed(carol, 5, 0x52n);
    bobToCarol.pump();
    sendFinish(carol, 5);
    bobToCarol.pump();
    await tick();
    const reply = CapnpMessage.fromFlat(carol.receive()!).root();
    expect(Return_which(Message_getReturn(reply))).toBe(Return.canceled);
    expect(bobToAlice.embargoedAccepts()).toEqual([]);
    sendDisembargoProvide(alice, 70);
    bobToAlice.pump();
    expect(carol.receive()).toBeNull();
    expect(bobToCarol.liveExports()).toEqual([]);
  });

  test("a Disembargo that overtakes its embargoed Accept still lifts it", () => {
    const { bobToAlice, bobToCarol, alice, carol } = bobBetween();
    sendProvide(alice, 70, 0, 0x53n);
    bobToAlice.pump();
    readReply(alice);
    sendDisembargoProvide(alice, 70);
    bobToAlice.pump();
    sendAcceptEmbargoed(carol, 5, 0x53n);
    bobToCarol.pump();
    const reply = readReply(carol);
    expect(reply.answerId).toBe(5);
    expect(reply.contentKind).toBe(PtrKind.Cap);
  });

  test("a reused Provide question id keeps each embargoed Accept", () => {
    const { server, bobToAlice, bobToCarol, alice, carol } = bobBetween();
    sendProvide(alice, 70, 0, 0x54n);
    bobToAlice.pump();
    readReply(alice);
    sendFinish(alice, 70);
    sendProvide(alice, 70, 0, 0x55n);
    bobToAlice.pump();
    readReply(alice);
    sendAcceptEmbargoed(carol, 5, 0x54n);
    sendAcceptEmbargoed(carol, 6, 0x55n);
    bobToCarol.pump();
    expect(bobToAlice.embargoedAccepts()).toEqual([70, 70]);
    sendDisembargoProvide(alice, 70);
    bobToAlice.pump();
    expect(readReply(carol).answerId).toBe(5);
    sendDisembargoProvide(alice, 70);
    bobToAlice.pump();
    expect(readReply(carol).answerId).toBe(6);
    bobToCarol.disconnect(new RpcError("carol went away", "disconnected"));
    bobToAlice.disconnect(new RpcError("alice went away", "disconnected"));
    expect(server.disposed).toBe(1);
  });

  test("an embargoed Accept is released when its own connection ends", () => {
    const { server, bobToAlice, bobToCarol, alice, carol } = bobBetween();
    sendProvide(alice, 70, 0, 0x56n);
    bobToAlice.pump();
    readReply(alice);
    sendAcceptEmbargoed(carol, 5, 0x56n);
    bobToCarol.pump();
    bobToCarol.disconnect(new RpcError("carol went away", "disconnected"));
    expect(bobToAlice.embargoedAccepts()).toEqual([]);
    sendDisembargoProvide(alice, 70);
    bobToAlice.pump();
    expect(bobToAlice.disconnected).toBeUndefined();
    bobToAlice.disconnect(new RpcError("alice went away", "disconnected"));
    expect(server.disposed).toBe(1);
  });
});
