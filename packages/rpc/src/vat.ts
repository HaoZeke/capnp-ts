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
  Bootstrap_getQuestionId,
  Finish_getQuestionId,
  Join_getKeyPart,
  Join_getQuestionId,
  Join_getTarget,
  MESSAGE_DWORDS,
  MESSAGE_PWORDS,
  Message,
  Message_getBootstrap,
  Message_getCall,
  Message_getFinish,
  Message_getJoin,
  Message_getRelease,
  Message_which,
  MessageTarget,
  MessageTarget_getImportedCap,
  MessageTarget_which,
  PAYLOAD_DWORDS,
  PAYLOAD_PWORDS,
  Payload_getCapTable,
  Payload_getContent,
  RETURN_DWORDS,
  RETURN_PWORDS,
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
        // Nothing is retained per answer yet, so a Finish only needs to
        // be accepted rather than acted on.
        Finish_getQuestionId(Message_getFinish(root));
        break;
      case Message.release:
        this.handleRelease(Message_getRelease(root));
        break;
      case Message.join:
        this.handleJoin(Message_getJoin(root));
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
    this.transport.send(b.toFlat());
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
      slot.server.dispatch(
        Call_getInterfaceId(call),
        Call_getMethodId(call),
        params,
        payload,
      );
      this.transport.send(b.toFlat());
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

  private resolveTarget(target: Ptr): number {
    if (MessageTarget_which(target) !== MessageTarget.importedCap) return -1;
    const id = MessageTarget_getImportedCap(target);
    return this.exports.has(id) ? id : -1;
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
