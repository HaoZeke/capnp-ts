/**
 * Level 1 beyond the message set: promise pipelining and Disembargo.
 *
 * A caller may address a capability inside an answer before it has seen
 * that answer. The vat has to keep the answer around and walk the
 * transform ops into it, and it has to reflect an embargo so the caller
 * can tell when its earlier calls have drained.
 */
import { describe, expect, test } from "bun:test";
import {
  Message as CapnpMessage,
  MessageBuilder,
  Ptr,
  type StructBuilder,
} from "../../runtime/src/index.ts";

import {
  BOOTSTRAP_DWORDS,
  BOOTSTRAP_PWORDS,
  CALL_DWORDS,
  CALL_PWORDS,
  DISEMBARGO_DWORDS,
  DISEMBARGO_PWORDS,
  Disembargo_context,
  Disembargo_context_getReceiverLoopback,
  Disembargo_context_which,
  Disembargo_getContext,
  FINISH_DWORDS,
  FINISH_PWORDS,
  MESSAGE_DWORDS,
  MESSAGE_PWORDS,
  MESSAGE_TARGET_DWORDS,
  MESSAGE_TARGET_PWORDS,
  Message,
  Message_getDisembargo,
  Message_getReturn,
  Message_which,
  MessageTarget,
  PAYLOAD_DWORDS,
  PAYLOAD_PWORDS,
  PROMISED_ANSWER_DWORDS,
  PROMISED_ANSWER_PWORDS,
  Payload_getContent,
  Return,
  Return_getAnswerId,
  Return_getResults,
  Return_which,
  PROMISED_ANSWER_OP_DWORDS,
  PROMISED_ANSWER_OP_PWORDS,
  PromisedAnswer_Op,
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

function sendBootstrap(t: Transport, questionId: number): void {
  const b = new MessageBuilder();
  const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
  root.setU16(0, Message.bootstrap);
  root.initStruct(0, BOOTSTRAP_DWORDS, BOOTSTRAP_PWORDS).setU32(0, questionId);
  t.send(b.toFlat());
}

/**
 * A call whose target is `promisedAnswer`: pointer field 0 of the answer
 * to `answerQuestionId`, which is where bootstrap puts its capability.
 */
function sendPipelinedCall(
  t: Transport,
  questionId: number,
  answerQuestionId: number,
  pointerFieldOps: number[] = [],
): void {
  const b = new MessageBuilder();
  const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
  root.setU16(0, Message.call);
  const call = root.initStruct(0, CALL_DWORDS, CALL_PWORDS);
  call.setU32(0, questionId);
  const target = call.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
  target.setU16(4, MessageTarget.promisedAnswer);
  const promised = target.initStruct(0, PROMISED_ANSWER_DWORDS, PROMISED_ANSWER_PWORDS);
  promised.setU32(0, answerQuestionId);
  // An empty transform means "the content pointer itself", which is the
  // capability bootstrap returned; each op walks one pointer field in.
  const ops = promised.initCompositeList(
    0,
    pointerFieldOps.length,
    PROMISED_ANSWER_OP_DWORDS,
    PROMISED_ANSWER_OP_PWORDS,
  );
  let op = ops;
  for (let i = 0; i < pointerFieldOps.length; i++) {
    if (i > 0) op = op.nextElement();
    op.setU16(0, PromisedAnswer_Op.getPointerField);
    op.setU16(2, pointerFieldOps[i]!);
  }
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

function readReturn(t: Transport): { answerId: number; value: number } {
  const frame = t.receive();
  if (frame === null) throw new Error("expected a Return");
  const root = CapnpMessage.fromFlat(frame).root();
  expect(Message_which(root)).toBe(Message.return);
  const ret = Message_getReturn(root);
  return {
    answerId: Return_getAnswerId(ret),
    value: Payload_getContent(Return_getResults(ret)).getU32(0),
  };
}

describe("promise pipelining", () => {
  test("a call addressed to an answer reaches the capability inside it", () => {
    const pair = new MemoryTransportPair();
    const server = new CountingServer();
    const vat = new RpcConnection(pair.b, server);

    sendBootstrap(pair.a, 1);
    vat.pump();
    // The caller need not read the bootstrap Return before pipelining.
    sendPipelinedCall(pair.a, 2, 1);
    vat.pump();

    readReturn(pair.a); // the bootstrap answer
    const call = readReturn(pair.a);
    expect(call.answerId).toBe(2);
    expect(call.value).toBe(1);
    expect(server.calls).toBe(1);
  });

  test("the answer is dropped on Finish, so later pipelining fails", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new CountingServer());

    sendBootstrap(pair.a, 1);
    vat.pump();
    readReturn(pair.a);

    sendFinish(pair.a, 1);
    vat.pump();

    sendPipelinedCall(pair.a, 2, 1);
    vat.pump();
    const frame = pair.a.receive();
    expect(frame).not.toBeNull();
    const ret = Message_getReturn(CapnpMessage.fromFlat(frame!).root());
    expect(Return_getAnswerId(ret)).toBe(2);
    // An exception, not results: the answer it named is gone.
    expect(Return_which(ret)).toBe(Return.exception);
  });

  test("a transform op that walks past the capability does not resolve", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new CountingServer());

    sendBootstrap(pair.a, 1);
    vat.pump();
    pair.a.receive();

    // The bootstrap answer's content is the capability itself, so asking
    // for its pointer field 0 walks off the end of it.
    sendPipelinedCall(pair.a, 2, 1, [0]);
    vat.pump();

    const frame = pair.a.receive();
    expect(frame).not.toBeNull();
    const ret = Message_getReturn(CapnpMessage.fromFlat(frame!).root());
    expect(Return_which(ret)).toBe(Return.exception);
  });
});

describe("disembargo", () => {
  test("senderLoopback is echoed back as receiverLoopback with the same id", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new CountingServer());
    sendBootstrap(pair.a, 1);
    vat.pump();
    pair.a.receive();

    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(0, Message.disembargo);
    const dis = root.initStruct(0, DISEMBARGO_DWORDS, DISEMBARGO_PWORDS);
    const target = dis.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
    target.setU16(4, MessageTarget.importedCap);
    target.setU32(0, 0);
    // `context` is a group: it shares Disembargo's data section.
    dis.setU16(4, Disembargo_context.senderLoopback);
    dis.setU32(0, 12345);
    pair.a.send(b.toFlat());
    vat.pump();

    const frame = pair.a.receive();
    expect(frame).not.toBeNull();
    const reply = CapnpMessage.fromFlat(frame!).root();
    expect(Message_which(reply)).toBe(Message.disembargo);
    const replyCtx = Disembargo_getContext(Message_getDisembargo(reply));
    expect(Disembargo_context_which(replyCtx)).toBe(
      Disembargo_context.receiverLoopback,
    );
    expect(Disembargo_context_getReceiverLoopback(replyCtx)).toBe(12345);
  });

  test("receiverLoopback is absorbed rather than echoed", () => {
    const pair = new MemoryTransportPair();
    const vat = new RpcConnection(pair.b, new CountingServer());

    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(0, Message.disembargo);
    const dis = root.initStruct(0, DISEMBARGO_DWORDS, DISEMBARGO_PWORDS);
    dis.setU16(4, Disembargo_context.receiverLoopback);
    dis.setU32(0, 999);
    pair.a.send(b.toFlat());
    vat.pump();

    // Echoing it would bounce forever between the two vats.
    expect(pair.a.pending).toBe(0);
  });
});
