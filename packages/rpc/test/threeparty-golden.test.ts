/**
 * Level 3 frames from the reference encoder.
 *
 * Every test around this one drives the vat with frames this package
 * built itself, which proves the vat agrees with its own builder and
 * nothing more. These two frames come from the Cap'n Proto CLI
 * (`scripts/gen-rpc-frames.sh`), so decoding them is the claim that a
 * peer speaking `rpc-threeparty.capnp` can hand this vat a capability.
 *
 * The frames say: hold export 0 for whoever presents 0xfeedface
 * (question 42), then claim it (question 43).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  MessageTarget,
  PROVIDE_DWORDS,
  PROVIDE_PWORDS,
  Message_getReturn,
  Message_which,
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

const here = dirname(fileURLToPath(import.meta.url));
const golden = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(here, "golden", name)));

const NONCE = 0xfeedfacen;

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

/** Bob, with one capability bootstrapped so export 0 is live. */
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

function readReturn(t: Transport): { answerId: number; isException: boolean; contentKind: number } {
  const frame = t.receive();
  if (frame === null) throw new Error("expected a Return");
  const root = CapnpMessage.fromFlat(frame).root();
  expect(Message_which(root)).toBe(Message.return);
  const ret = Message_getReturn(root);
  const isException = Return_which(ret) !== Return.results;
  return {
    answerId: Return_getAnswerId(ret),
    isException,
    contentKind: isException ? PtrKind.Null : Payload_getContent(Return_getResults(ret)).kind,
  };
}

describe("level 3 frames from the reference encoder", () => {
  test("the vat completes a handoff driven entirely by CLI-built frames", () => {
    const { bob, peer } = bobWithExport();

    peer.send(golden("rpc-provide.bin"));
    bob.pump();
    const provided = readReturn(peer);
    expect(provided.answerId).toBe(42);
    expect(provided.isException).toBe(false);
    // The nonce the vat recorded is the one the CLI wrote into the frame,
    // which is the whole point: both sides read the same field.
    expect(bob.pendingProvisions()).toEqual([NONCE]);

    peer.send(golden("rpc-accept.bin"));
    bob.pump();
    const accepted = readReturn(peer);
    expect(accepted.answerId).toBe(43);
    expect(accepted.isException).toBe(false);
    expect(accepted.contentKind).toBe(PtrKind.Cap);
    expect(bob.pendingProvisions()).toEqual([]);
  });

  test("the Accept frame alone is refused, with nothing arranged", () => {
    const { bob, peer } = bobWithExport();
    peer.send(golden("rpc-accept.bin"));
    bob.pump();
    const reply = readReturn(peer);
    expect(reply.answerId).toBe(43);
    expect(reply.isException).toBe(true);
  });

  // The other direction. Allocation order is not dictated by the format,
  // so this holds because both encoders lay a message out in schema
  // order; it is what makes the frames above comparable at all.
  test("this encoder writes the reference bytes", () => {
    const provide = new MessageBuilder();
    const proot = provide.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    proot.setU16(0, Message.provide);
    const pv = proot.initStruct(0, PROVIDE_DWORDS, PROVIDE_PWORDS);
    pv.setU32(0, 42);
    const target = pv.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
    target.setU16(4, MessageTarget.importedCap);
    target.setU32(0, 0);
    const recipient = pv.initStruct(1, RECIPIENT_ID_DWORDS, RECIPIENT_ID_PWORDS);
    recipient.setU64(0, NONCE);
    const vat = recipient.initStruct(0, VAT_ID_DWORDS, VAT_ID_PWORDS);
    vat.setText(0, "127.0.0.1");
    vat.setU16(0, 4000);
    expect(provide.toFlat()).toEqual(golden("rpc-provide.bin"));

    const accept = new MessageBuilder();
    const aroot = accept.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    aroot.setU16(0, Message.accept);
    const ac = aroot.initStruct(0, ACCEPT_DWORDS, ACCEPT_PWORDS);
    ac.setU32(0, 43);
    ac.initStruct(0, PROVISION_ID_DWORDS, PROVISION_ID_PWORDS).setU64(0, NONCE);
    expect(accept.toFlat()).toEqual(golden("rpc-accept.bin"));
  });
});
