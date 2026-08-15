/**
 * A whole level 3 handoff, with three vats.
 *
 * Alice holds a capability that Bob hosts and wants Carol to have it.
 * The other level 3 tests each drive one side with hand-built frames;
 * this one runs all three vats and lets them speak to each other, which
 * is the only way to see that the halves agree:
 *
 *   Alice -> Bob    Provide{target, recipient = RecipientId{carol, nonce}}
 *   Alice -> Carol  a payload carrying ThirdPartyCapId{bob, nonce}
 *   Carol -> Bob    Accept{ProvisionId{nonce}}
 *   Bob   -> Carol  Return carrying the capability
 *
 * The nonce is the only thing the three messages share, which is what
 * lets Bob hand the capability over without taking Carol's word for who
 * sent her.
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
  CALL_DWORDS,
  CALL_PWORDS,
  MESSAGE_DWORDS,
  MESSAGE_PWORDS,
  MESSAGE_TARGET_DWORDS,
  MESSAGE_TARGET_PWORDS,
  Message,
  MessageTarget,
  Message_getReturn,
  Message_which,
  PAYLOAD_DWORDS,
  PAYLOAD_PWORDS,
  Payload_getContent,
  Return,
  Return_getAnswerId,
  Return_getResults,
  Return_which,
} from "../src/rpc.capnp.ts";
import { MemoryTransportPair, type Transport } from "../src/transport.ts";
import {
  type Introduction,
  RpcConnection,
  type RpcServer,
  Vat,
} from "../src/vat.ts";

const NONCE = 0x5eedn;
/** Where Bob can be reached, as Alice tells Carol. */
const BOB: Introduction = { vineId: 0, host: "10.0.0.1", port: 5000 };
/** Where Carol can be reached, as Alice tells Bob. */
const CAROL: Introduction = { vineId: 0, host: "10.0.0.2", port: 5001 };

/** The capability being handed over: it answers with `mark`. */
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

/**
 * Alice -> Carol: a call whose params name the capability Bob hosts.
 * Alice is the introducer, so she writes the descriptor.
 */
function tellCarolWhereToGo(
  alice: RpcConnection,
  toCarol: Transport,
  questionId: number,
  where: Introduction,
  nonce: bigint,
): void {
  const b = new MessageBuilder();
  const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
  root.setU16(0, Message.call);
  const call = root.initStruct(0, CALL_DWORDS, CALL_PWORDS);
  call.setU32(0, questionId);
  const target = call.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
  target.setU16(4, MessageTarget.importedCap);
  target.setU32(0, 0);
  const payload = call.initStruct(1, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
  payload.initStruct(0, 1, 0);
  alice.writeThirdPartyCapTable(payload, where, nonce);
  toCarol.send(b.toFlat());
}

describe("a level 3 handoff between three vats", () => {
  test("Carol ends up holding the capability Bob hosts", () => {
    const hosted = new Marked(42);

    // Bob is one vat with two connections, so the arrangement Alice
    // makes on hers is claimable on Carol's.
    const bobVat = new Vat();

    // Alice <-> Bob. Alice bootstraps, so Bob hosts export 0 and Alice
    // holds it as an import.
    const ab = new MemoryTransportPair();
    const aliceToBob = new RpcConnection(ab.a);
    const bob = new RpcConnection(ab.b, hosted, bobVat);
    const bootstrap = aliceToBob.sendBootstrap();
    bob.pump();
    aliceToBob.pump();
    expect(aliceToBob.answerContent(bootstrap)?.kind).toBe(PtrKind.Cap);

    // Alice <-> Carol, and Carol <-> Bob, each their own connection.
    const ac = new MemoryTransportPair();
    const aliceToCarol = new RpcConnection(ac.a);
    const carolToAlice = new RpcConnection(ac.b, new Marked(1));
    // Bob answers Carol's connection with a different object, so the two
    // connections do not agree on export ids by accident: the capability
    // Alice hands over must arrive under an id of Carol's connection,
    // not the one Alice used.
    const sidecar = new Marked(1000);
    const cb = new MemoryTransportPair();
    const carolToBob = new RpcConnection(cb.a);
    const bobToCarol = new RpcConnection(cb.b, sidecar, bobVat);

    // 1. Alice tells Bob to expect Carol.
    const provide = aliceToBob.sendProvide(0, CAROL, NONCE);
    bob.pump();
    aliceToBob.pump();
    expect(bob.pendingProvisions()).toEqual([NONCE]);

    // 2. Alice tells Carol where to go. Carol records the introduction
    //    rather than dialling: reaching Bob is the network's job, and
    //    here the connection already exists.
    tellCarolWhereToGo(aliceToCarol, ac.a, 90, BOB, NONCE);
    carolToAlice.pump();
    ac.a.receive();
    const learned = carolToAlice.pendingIntroductions().get(NONCE);
    expect(learned).toEqual(BOB);

    // Carol bootstraps Bob first, so her connection's export 0 is the
    // sidecar and the handed-over capability cannot land on 0 too.
    const side = carolToBob.sendBootstrap();
    bobToCarol.pump();
    carolToBob.pump();
    expect(carolToBob.answerContent(side)?.kind).toBe(PtrKind.Cap);

    // 3. Carol presents the nonce to Bob, over her own connection. She
    //    was never told which export id Alice used, and it would mean
    //    nothing here: the arrangement is keyed by the nonce alone.
    const claim = carolToBob.sendAccept(NONCE);
    bobToCarol.pump();
    carolToBob.pump();
    expect(carolToBob.answerContent(claim)?.kind).toBe(PtrKind.Cap);
    expect(bobToCarol.pendingProvisions()).toEqual([]);
    // And it is claimable exactly once, on any connection.
    const replay = carolToBob.sendAccept(NONCE);
    bobToCarol.pump();
    carolToBob.pump();
    expect(carolToBob.isFailed(replay)).toBe(true);

    // 4. Carol drops the vine now that the pickup is done.
    expect(carolToAlice.introductionDone(NONCE)).toBe(true);
    expect(carolToAlice.pendingIntroductions().size).toBe(0);

    // Carol now holds the capability Bob hosts. Calling it reaches the
    // object Alice was talking to, not whatever else sits at that id on
    // Carol's connection: this one answers 42, the sidecar 1000.
    const before = hosted.calls;
    const claimedId = carolToBob.answerCapId(claim);
    expect(claimedId).toBeGreaterThan(0);
    const q = carolToBob.sendCall(claimedId, 0x1234n, 0);
    bobToCarol.pump();
    carolToBob.pump();
    expect(hosted.calls).toBe(before + 1);
    expect(sidecar.calls).toBe(0);
    expect(carolToBob.answerContent(q)?.getU32(0)).toBe(42);
    void provide;
    void readReply;
  });
});
