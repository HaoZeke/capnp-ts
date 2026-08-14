/**
 * Two-party RPC vat.
 *
 * Answers the level 1 messages a peer sends to a capability this vat
 * hosts, plus level 4 `Join`. Level 3 is absent by construction rather
 * than by omission: `Provide` and `Accept` introduce a capability to a
 * third vat, and a two-party connection has no way to name one --
 * rpc-twoparty.capnp declares `ThirdPartyCapId` and `RecipientId` empty,
 * "never used, because there is no third party".
 */
import {
  Message as CapnpMessage,
  MessageBuilder,
  Orphan,
  Ptr,
  PtrKind,
  type StructBuilder,
} from "@haozeke/capnp";

import {
  CALL_DWORDS,
  CALL_PWORDS,
  Call_getInterfaceId,
  Call_getMethodId,
  Call_getParams,
  Call_getQuestionId,
  Call_getTarget,
  CAP_DESCRIPTOR_DWORDS,
  CAP_DESCRIPTOR_PWORDS,
  CapDescriptor,
  CapDescriptor_getSenderHosted,
  CapDescriptor_which,
  Bootstrap_getQuestionId,
  DISEMBARGO_DWORDS,
  DISEMBARGO_PWORDS,
  Disembargo_context,
  Disembargo_context_getSenderLoopback,
  Disembargo_context_which,
  Disembargo_getContext,
  Disembargo_getTarget,
  Finish_getQuestionId,
  Join_getKeyPart,
  Join_getQuestionId,
  Join_getTarget,
  MESSAGE_DWORDS,
  MESSAGE_PWORDS,
  Message,
  Message_getBootstrap,
  Message_getCall,
  Message_getDisembargo,
  Message_getFinish,
  Message_getReturn,
  Message_getJoin,
  Message_getRelease,
  Message_which,
  MessageTarget,
  MessageTarget_getImportedCap,
  MessageTarget_getPromisedAnswer,
  MessageTarget_which,
  PromisedAnswer_Op,
  PromisedAnswer_Op_getGetPointerField,
  PromisedAnswer_Op_which,
  PromisedAnswer_getQuestionId,
  PromisedAnswer_getTransform,
  PAYLOAD_DWORDS,
  PAYLOAD_PWORDS,
  Payload_getCapTable,
  Payload_getContent,
  RETURN_DWORDS,
  RETURN_PWORDS,
  Return_getResults,
  Release_getId,
  Release_getReferenceCount,
} from "./rpc.capnp.ts";

import {
  JOIN_RESULT_DWORDS,
  JOIN_RESULT_PWORDS,
  JoinKeyPart_getJoinId,
  JoinKeyPart_getPartCount,
  JoinKeyPart_getPartNum,
} from "./rpc-twoparty.capnp.ts";

import type { Transport } from "./transport.ts";

/** Field offsets the builder writes by hand; the generated code reads. */
const OFF = {
  messageUnion: 0,
  callQuestionId: 0,
  callInterfaceId: 8,
  callMethodId: 4,
  returnAnswerId: 0,
  returnUnion: 6,
  bootstrapQuestionId: 0,
  targetUnion: 4,
  targetImportedCap: 0,
  capDescriptorUnion: 0,
  capDescriptorSenderHosted: 4,
  disembargoContextUnion: 4,
  disembargoContextValue: 0,
  joinResultJoinId: 0,
  joinResultSucceeded: 32, // bit offset
} as const;

/** `Return` union tags, from rpc.capnp. */
const RETURN_RESULTS = 0;
const RETURN_EXCEPTION = 1;

/** A capability this vat hosts. */
export interface RpcServer {
  /**
   * Handle one call. Write the reply into `results` and return; throw to
   * answer with an exception.
   */
  dispatch(interfaceId: bigint, methodId: number, params: Ptr, results: StructBuilder): void;
}

interface ExportSlot {
  server: RpcServer;
  refcount: number;
}

/**
 * One in-flight Join, keyed by the sender's joinId.
 *
 * A Join asks whether several capabilities are the same object. Each part
 * is its own question, so no part is answerable when it arrives: the
 * answer depends on the whole set. Parts accumulate here and every
 * question is answered once the last one lands, which is the order
 * rpc-twoparty.capnp's JoinResult describes.
 */
interface JoinState {
  partCount: number;
  /** questionId and resolved export per partNum; undefined until seen. */
  parts: Array<{ questionId: number; exportId: number } | undefined>;
  seen: number;
}

export class RpcConnection {
  private readonly exports = new Map<number, ExportSlot>();
  private readonly exportIdByServer = new Map<RpcServer, number>();
  private readonly joins = new Map<number, JoinState>();
  /**
   * Results already returned, kept until the peer sends `Finish`.
   *
   * Promise pipelining is the reason: a caller may address a capability
   * inside an answer before it has seen the answer, so the answer has to
   * still be here when the pipelined call arrives.
   */
  private readonly answers = new Map<number, Uint8Array>();
  private nextExportId = 0;

  constructor(
    private readonly transport: Transport,
    private readonly bootstrap?: RpcServer,
  ) {}

  /** Handle one pending message. Returns false when none was waiting. */
  pumpOnce(): boolean {
    const frame = this.transport.receive();
    if (frame === null) return false;

    const msg = CapnpMessage.fromFlat(frame);
    const root = msg.root();
    const which = Message_which(root);

    switch (which) {
      case Message.bootstrap:
        this.handleBootstrap(Message_getBootstrap(root));
        break;
      case Message.call:
        this.handleCall(Message_getCall(root));
        break;
      case Message.finish:
        // The caller is done with the answer, so the results it might
        // have pipelined against can go.
        this.answers.delete(Finish_getQuestionId(Message_getFinish(root)));
        break;
      case Message.release:
        this.handleRelease(Message_getRelease(root));
        break;
      case Message.join:
        this.handleJoin(Message_getJoin(root));
        break;
      case Message.disembargo:
        this.handleDisembargo(Message_getDisembargo(root));
        break;
      default:
        // Provide, Accept, Resolve and the obsolete save/delete messages.
        this.sendUnimplemented(frame);
        break;
    }
    return true;
  }

  /** Handle every pending message. */
  pump(): number {
    let n = 0;
    while (this.pumpOnce()) n++;
    return n;
  }

  /** Export a capability, or return the id it already has. */
  exportCap(server: RpcServer): number {
    const existing = this.exportIdByServer.get(server);
    if (existing !== undefined) {
      this.exports.get(existing)!.refcount++;
      return existing;
    }
    const id = this.nextExportId++;
    this.exports.set(id, { server, refcount: 1 });
    this.exportIdByServer.set(server, id);
    return id;
  }

  /** Export ids currently live, lowest first. Exposed for tests. */
  liveExports(): number[] {
    return [...this.exports.keys()].sort((x, y) => x - y);
  }

  private handleBootstrap(bootstrap: Ptr): void {
    const questionId = Bootstrap_getQuestionId(bootstrap);
    if (this.bootstrap === undefined) {
      this.sendException(questionId, "no bootstrap capability");
      return;
    }
    const exportId = this.exportCap(this.bootstrap);
    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(OFF.messageUnion, Message.return);
    const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
    ret.setU32(OFF.returnAnswerId, questionId);
    ret.setU16(OFF.returnUnion, RETURN_RESULTS);
    const payload = ret.initStruct(0, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
    this.writeSingleCapPayload(b, payload, exportId);
    this.sendAnswer(questionId, b.toFlat());
  }

  private handleCall(call: Ptr): void {
    const questionId = Call_getQuestionId(call);
    const exportId = this.resolveTarget(Call_getTarget(call));
    const slot = exportId >= 0 ? this.exports.get(exportId) : undefined;
    if (slot === undefined) {
      this.sendException(questionId, `no such export: ${exportId}`);
      return;
    }

    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(OFF.messageUnion, Message.return);
    const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
    ret.setU32(OFF.returnAnswerId, questionId);

    const params = Payload_getContent(Call_getParams(call));
    try {
      ret.setU16(OFF.returnUnion, RETURN_RESULTS);
      const payload = ret.initStruct(0, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
      // The server writes into the payload's content struct, not into the
      // Payload, which has no data section of its own. One data word and
      // one pointer word covers the replies the bundled servers make; a
      // richer server allocates inside dispatch.
      const results = payload.initStruct(0, 1, 1);
      slot.server.dispatch(
        Call_getInterfaceId(call),
        Call_getMethodId(call),
        params,
        results,
      );
      this.sendAnswer(questionId, b.toFlat());
    } catch (e) {
      this.sendException(questionId, e instanceof Error ? e.message : String(e));
    }
  }

  private handleRelease(release: Ptr): void {
    const id = Release_getId(release);
    const count = Release_getReferenceCount(release);
    const slot = this.exports.get(id);
    if (slot === undefined) return;
    slot.refcount -= count;
    if (slot.refcount <= 0) {
      this.exportIdByServer.delete(slot.server);
      this.exports.delete(id);
    }
  }

  /**
   * Level 4. On a two-party network the comparison is decidable locally:
   * both ends can only name capabilities this vat exports, so equal
   * export ids mean the same object. A vat bridging to another network
   * would forward the join onward instead, which needs a three-party
   * layer this transport does not have.
   */
  private handleJoin(join: Ptr): void {
    const questionId = Join_getQuestionId(join);
    const keyPart = Join_getKeyPart(join);
    if (keyPart.kind !== PtrKind.Struct) {
      // Without a JoinKeyPart there is no way to tell which set this
      // belongs to, so it can only fail on its own.
      this.sendJoinResult(questionId, 0, false, false, -1);
      return;
    }

    const joinId = JoinKeyPart_getJoinId(keyPart);
    const partCount = JoinKeyPart_getPartCount(keyPart);
    const partNum = JoinKeyPart_getPartNum(keyPart);
    if (partCount <= 0 || partNum < 0 || partNum >= partCount) {
      this.sendJoinResult(questionId, joinId, false, false, -1);
      return;
    }

    let state = this.joins.get(joinId);
    if (state === undefined) {
      state = { partCount, parts: new Array(partCount).fill(undefined), seen: 0 };
      this.joins.set(joinId, state);
    } else if (state.partCount !== partCount || state.parts[partNum] !== undefined) {
      // A disagreeing partCount, or a partNum reused before the set
      // completed, makes the set unanswerable.
      this.sendJoinResult(questionId, joinId, false, false, -1);
      return;
    }

    state.parts[partNum] = {
      questionId,
      exportId: this.resolveTarget(Join_getTarget(join)),
    };
    state.seen++;
    if (state.seen < state.partCount) return;

    this.joins.delete(joinId);
    const parts = state.parts as Array<{ questionId: number; exportId: number }>;
    const first = parts[0]!.exportId;
    // A part naming nothing we host cannot be shown equal to anything.
    const same = first >= 0 && parts.every((p) => p.exportId === first);
    // Exactly one result carries the joined capability, per JoinResult.
    parts.forEach((part, i) => {
      this.sendJoinResult(part.questionId, joinId, same, same && i === 0, first);
    });
  }

  private sendJoinResult(
    questionId: number,
    joinId: number,
    succeeded: boolean,
    withCap: boolean,
    exportId: number,
  ): void {
    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(OFF.messageUnion, Message.return);
    const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
    ret.setU32(OFF.returnAnswerId, questionId);
    ret.setU16(OFF.returnUnion, RETURN_RESULTS);
    const payload = ret.initStruct(0, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
    const jr = payload.initStruct(0, JOIN_RESULT_DWORDS, JOIN_RESULT_PWORDS);
    jr.setU32(OFF.joinResultJoinId, joinId);
    jr.setBool(OFF.joinResultSucceeded, succeeded);
    if (withCap && exportId >= 0) {
      // The receiver gains a reference, so the refcount rises with it.
      this.exports.get(exportId)!.refcount++;
      this.writeCapTable(payload, exportId);
      jr.adopt(0, Orphan.cap(b, 0));
    }
    this.transport.send(b.toFlat());
  }

  /**
   * Send a Return and keep it until `Finish`, so a call pipelined against
   * this answer can still find the capability it names.
   */
  private sendAnswer(questionId: number, frame: Uint8Array): void {
    this.answers.set(questionId, frame);
    this.transport.send(frame);
  }

  private writeSingleCapPayload(
    b: MessageBuilder,
    payload: StructBuilder,
    exportId: number,
  ): void {
    this.writeCapTable(payload, exportId);
    payload.adopt(0, Orphan.cap(b, 0));
  }

  /** One-entry capTable naming a senderHosted export. */
  private writeCapTable(
    payload: StructBuilder,
    exportId: number,
  ): void {
    const cd = payload.initCompositeList(
      1,
      1,
      CAP_DESCRIPTOR_DWORDS,
      CAP_DESCRIPTOR_PWORDS,
    );
    cd.setU16(OFF.capDescriptorUnion, CapDescriptor.senderHosted);
    cd.setU32(OFF.capDescriptorSenderHosted, exportId);
  }

  /**
   * Resolve a MessageTarget to a local export id, or -1 when it names
   * nothing this vat hosts.
   *
   * `promisedAnswer` is promise pipelining: the caller addressed a
   * capability inside an answer, identified by walking the transform ops
   * into that answer's results and reading the capTable entry the
   * resulting pointer names.
   */
  private resolveTarget(target: Ptr): number {
    switch (MessageTarget_which(target)) {
      case MessageTarget.importedCap: {
        const id = MessageTarget_getImportedCap(target);
        return this.exports.has(id) ? id : -1;
      }
      case MessageTarget.promisedAnswer:
        return this.resolvePromisedAnswer(MessageTarget_getPromisedAnswer(target));
      default:
        return -1;
    }
  }

  private resolvePromisedAnswer(promised: Ptr): number {
    const frame = this.answers.get(PromisedAnswer_getQuestionId(promised));
    if (frame === undefined) return -1;

    const ret = Message_getReturn(CapnpMessage.fromFlat(frame).root());
    const payload = Return_getResults(ret);
    let cursor = Payload_getContent(payload);

    const ops = PromisedAnswer_getTransform(promised);
    for (let i = 0; i < ops.listLen(); i++) {
      const op = ops.listGetP(i);
      if (PromisedAnswer_Op_which(op) !== PromisedAnswer_Op.getPointerField) continue;
      // The peer chooses the transform, so a step that walks into
      // something with no pointer section is an unresolvable target
      // rather than a reason to throw out of the message loop.
      if (cursor.kind !== PtrKind.Struct) return -1;
      cursor = cursor.getP(PromisedAnswer_Op_getGetPointerField(op));
    }
    if (cursor.kind !== PtrKind.Cap) return -1;

    // The pointer holds a capTable index; the descriptor beside it says
    // which export the caller is actually naming.
    const table = Payload_getCapTable(payload);
    const index = cursor.count;
    if (index < 0 || index >= table.listLen()) return -1;
    const descriptor = table.listGetP(index);
    if (CapDescriptor_which(descriptor) !== CapDescriptor.senderHosted) return -1;
    const id = CapDescriptor_getSenderHosted(descriptor);
    return this.exports.has(id) ? id : -1;
  }

  /**
   * A Disembargo with `senderLoopback` is echoed back as
   * `receiverLoopback` carrying the same id. That reflection is what lets
   * the sender know every call it had already sent through a promise has
   * arrived, so it can stop routing new ones the long way round.
   */
  private handleDisembargo(disembargo: Ptr): void {
    const context = Disembargo_getContext(disembargo);
    if (Disembargo_context_which(context) !== Disembargo_context.senderLoopback) {
      // receiverLoopback is the reply to an embargo we raised, and this
      // vat raises none; accept it without echoing to avoid a loop.
      return;
    }
    const id = Disembargo_context_getSenderLoopback(context);

    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(OFF.messageUnion, Message.disembargo);
    const out = root.initStruct(0, DISEMBARGO_DWORDS, DISEMBARGO_PWORDS);
    // Echo the target back untouched: the sender matches on it.
    out.setP(0, Disembargo_getTarget(disembargo));
    // `context` is a group, so it shares Disembargo's own data section
    // rather than living behind a pointer.
    out.setU16(OFF.disembargoContextUnion, Disembargo_context.receiverLoopback);
    out.setU32(OFF.disembargoContextValue, id);
    this.transport.send(b.toFlat());
  }

  private sendException(questionId: number, reason: string): void {
    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(OFF.messageUnion, Message.return);
    const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
    ret.setU32(OFF.returnAnswerId, questionId);
    ret.setU16(OFF.returnUnion, RETURN_EXCEPTION);
    const exc = ret.initStruct(0, 1, 2);
    exc.setText(0, reason);
    this.transport.send(b.toFlat());
  }

  /** Echo a message we did not understand, per the spec. */
  private sendUnimplemented(frame: Uint8Array): void {
    const incoming = CapnpMessage.fromFlat(frame).root();
    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(OFF.messageUnion, Message.unimplemented);
    root.setP(0, incoming);
    this.transport.send(b.toFlat());
  }
}
