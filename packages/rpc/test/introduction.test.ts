/**
 * Level 3, receiving half: introductions and vines.
 *
 * The Provide/Accept tests cover hosting a handoff. This is the other
 * end: a payload names a capability that lives in a third vat, as a
 * `thirdPartyHosted` descriptor carrying where to go and a vine. The
 * vine is an ordinary import through the introducer, so calls work
 * before we ever reach the third party; that is the fallback the spec
 * gives receivers that cannot reach one, and it is why the vine must
 * outlive the pickup.
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
  BOOTSTRAP_DWORDS,
  BOOTSTRAP_PWORDS,
  CALL_DWORDS,
  CALL_PWORDS,
  MESSAGE_DWORDS,
  MESSAGE_PWORDS,
  MESSAGE_TARGET_DWORDS,
  MESSAGE_TARGET_PWORDS,
  Message,
  MessageTarget,
  Message_getRelease,
  Message_which,
  PAYLOAD_DWORDS,
  PAYLOAD_PWORDS,
  RETURN_DWORDS,
  RETURN_PWORDS,
  Release_getId,
  Release_getReferenceCount,
} from "../src/rpc.capnp.ts";
import { MemoryTransportPair, type Transport } from "../src/transport.ts";
import { type Introduction, RpcConnection, type RpcServer } from "../src/vat.ts";

const NONCE = 0xabcdefn;
const WHERE: Introduction = { vineId: 77, host: "10.0.0.7", port: 5000 };

class Marked implements RpcServer {
  dispatch(
    _interfaceId: bigint,
    _methodId: number,
    _params: Ptr,
    results: StructBuilder,
  ): void {
    results.setU32(0, 7);
  }
}

function bobWithExport(): { bob: RpcConnection; peer: Transport } {
  const pair = new MemoryTransportPair();
  const bob = new RpcConnection(pair.b, new Marked());
  const b = new MessageBuilder();
  const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
  root.setU16(0, Message.bootstrap);
  root.initStruct(0, BOOTSTRAP_DWORDS, BOOTSTRAP_PWORDS).setU32(0, 1);
  pair.a.send(b.toFlat());
  bob.pump();
  pair.a.receive();
  return { bob, peer: pair.a };
}

/**
 * Alice -> us: a Call whose params name a capability hosted by a third
 * vat. The vat under test writes the descriptor itself, which is also
 * what an introducer does.
 */
function sendCallWithThirdPartyCap(
  vat: RpcConnection,
  t: Transport,
  questionId: number,
  exportId: number,
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
  target.setU32(0, exportId);
  const payload = call.initStruct(1, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
  payload.initStruct(0, 1, 0);
  vat.writeThirdPartyCapTable(payload, where, nonce);
  t.send(b.toFlat());
}

/** Drain the peer's inbox, reporting whether a Release named `id`. */
function sawReleaseOf(t: Transport, id: number): boolean {
  let seen = false;
  for (;;) {
    const frame = t.receive();
    if (frame === null) return seen;
    const root = CapnpMessage.fromFlat(frame).root();
    if (Message_which(root) !== Message.release) continue;
    const rel = Message_getRelease(root);
    if (Release_getId(rel) === id && Release_getReferenceCount(rel) === 1) seen = true;
  }
}

describe("level 3 introductions", () => {
  test("an introduction is recorded and its vine outlives the pickup", () => {
    const { bob, peer } = bobWithExport();
    expect(bob.pendingIntroductions().size).toBe(0);

    sendCallWithThirdPartyCap(bob, peer, 60, 0, WHERE, NONCE);
    bob.pump();
    expect(bob.pendingIntroductions().get(NONCE)).toEqual(WHERE);

    // Nothing is released while the pickup is outstanding: the vine is
    // the only way to reach the capability until then.
    expect(sawReleaseOf(peer, WHERE.vineId)).toBe(false);

    expect(bob.introductionDone(NONCE)).toBe(true);
    expect(sawReleaseOf(peer, WHERE.vineId)).toBe(true);
    expect(bob.pendingIntroductions().size).toBe(0);
  });

  test("finishing a pickup nobody arranged is refused", () => {
    const { bob, peer } = bobWithExport();
    sendCallWithThirdPartyCap(bob, peer, 61, 0, WHERE, NONCE);
    bob.pump();
    peer.receive();

    // Refused even while another arrangement stands: the nonce picks the
    // arrangement, not the fact that there is one.
    expect(bob.introductionDone(0xdeadn)).toBe(false);
    expect(bob.pendingIntroductions().size).toBe(1);
    expect(bob.introductionDone(NONCE)).toBe(true);
    expect(bob.pendingIntroductions().size).toBe(0);
  });

  test("two introductions on one payload are both recorded", () => {
    const { bob, peer } = bobWithExport();
    sendCallWithThirdPartyCap(bob, peer, 62, 0, WHERE, NONCE);
    bob.pump();
    const second: Introduction = { vineId: 78, host: "10.0.0.8", port: 5001 };
    sendCallWithThirdPartyCap(bob, peer, 63, 0, second, 0x99n);
    bob.pump();

    const held = bob.pendingIntroductions();
    expect(held.size).toBe(2);
    expect(held.get(NONCE)).toEqual(WHERE);
    expect(held.get(0x99n)).toEqual(second);
  });

  // The introducer can also hand us the descriptor in an answer, not
  // only in a call's params.
  test("an introduction in an answer is recorded", () => {
    const pair = new MemoryTransportPair();
    const client = new RpcConnection(pair.b);
    const q = client.sendBootstrap();
    pair.a.receive();

    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(0, Message.return);
    const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
    ret.setU32(0, q);
    ret.setU16(6, 0);
    const payload = ret.initStruct(0, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
    payload.initStruct(0, 1, 0);
    client.writeThirdPartyCapTable(payload, WHERE, NONCE);
    pair.a.send(b.toFlat());
    client.pump();

    expect(client.pendingIntroductions().get(NONCE)).toEqual(WHERE);
  });
});
