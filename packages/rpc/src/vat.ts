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
  CapDescriptor_getThirdPartyHosted,
  CapDescriptor_which,
  THIRD_PARTY_CAP_DESCRIPTOR_DWORDS,
  THIRD_PARTY_CAP_DESCRIPTOR_PWORDS,
  ThirdPartyCapDescriptor_getId,
  ThirdPartyCapDescriptor_getVineId,
  BOOTSTRAP_DWORDS,
  BOOTSTRAP_PWORDS,
  ACCEPT_DWORDS,
  ACCEPT_PWORDS,
  Accept_getEmbargo,
  Accept_getProvision,
  Accept_getQuestionId,
  Bootstrap_getQuestionId,
  PROVIDE_DWORDS,
  PROVIDE_PWORDS,
  Provide_getQuestionId,
  Provide_getRecipient,
  Provide_getTarget,
  FINISH_DWORDS,
  FINISH_PWORDS,
  RELEASE_DWORDS,
  RELEASE_PWORDS,
  DISEMBARGO_DWORDS,
  DISEMBARGO_PWORDS,
  Disembargo_context,
  Disembargo_context_getProvide,
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
  MESSAGE_TARGET_DWORDS,
  MESSAGE_TARGET_PWORDS,
  Message,
  Message_getBootstrap,
  Message_getCall,
  Message_getAccept,
  Message_getDisembargo,
  Message_getProvide,
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
  Return_getAnswerId,
  Return_getResults,
  Return_which,
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

import {
  PROVISION_ID_DWORDS,
  PROVISION_ID_PWORDS,
  ProvisionId_getNonce,
  RECIPIENT_ID_DWORDS,
  RECIPIENT_ID_PWORDS,
  RecipientId_getNonce,
  THIRD_PARTY_CAP_ID_DWORDS,
  THIRD_PARTY_CAP_ID_PWORDS,
  ThirdPartyCapId_getNonce,
  ThirdPartyCapId_getVat,
  VAT_ID_DWORDS,
  VAT_ID_PWORDS,
  VatId_getHost,
  VatId_getPort,
} from "./rpc-threeparty.capnp.ts";

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
/**
 * Where a capability handed to us by an introducer really lives, and the
 * vine that reaches it through the introducer in the meantime.
 */
/** A capability held for a third vat, and the Provide that arranged it. */
interface Provision {
  server: RpcServer;
  questionId: number;
}

/**
 * What a vat knows across all its connections.
 *
 * A level 3 handoff is arranged on one connection and claimed on
 * another: the introducer sends `Provide` over its own connection, and
 * the recipient arrives on hers. Export ids are per-connection, so what
 * the arrangement holds is the capability itself, and the claiming
 * connection exports it under an id of its own.
 *
 * Connections given no vat get one to themselves, which is what a
 * two-party deployment wants.
 */
export class Vat {
  /** Capabilities held for a third vat, by the nonce that claims them. */
  readonly provisions = new Map<bigint, Provision>();
}

/** An embargoed Accept: claimed, answer withheld until the disembargo. */
interface HeldAccept {
  exportId: number;
  answerId: number;
}

export interface Introduction {
  vineId: number;
  host: string;
  port: number;
}

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
/** A question this vat asked, from send until its Return arrives. */
interface QuestionState {
  /** The Return frame, once it lands. */
  reply?: Uint8Array;
  /** True when the Return carried an exception rather than results. */
  failed: boolean;
}

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
  /** Questions this vat has asked, by questionId, until their Return. */
  private readonly questions = new Map<number, QuestionState>();
  /**
   * Capabilities promised to a third vat, by nonce, awaiting its Accept.
   *
   * Level 3: the introducer told us to expect someone, and the nonce is
   * the whole of the arrangement. Matching on it alone is what lets the
   * recipient claim the capability without us having to trust her
   * account of who sent her.
   */
  private readonly vat: Vat;
  /** Embargoed Accepts, keyed by the introducer's Provide question. */
  private readonly heldAccepts = new Map<number, HeldAccept>();
  private readonly introductions = new Map<bigint, Introduction>();
  private nextExportId = 0;
  private nextQuestionId = 0;

  constructor(
    private readonly transport: Transport,
    private readonly bootstrap?: RpcServer,
    vat?: Vat,
  ) {
    this.vat = vat ?? new Vat();
  }

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
      case Message.return:
        this.handleReturn(Message_getReturn(root), frame);
        break;
      case Message.provide:
        this.handleProvide(Message_getProvide(root));
        break;
      case Message.accept:
        this.handleAccept(Message_getAccept(root));
        break;
      case Message.resolve:
        // Promise resolution. Replying unimplemented is the spec-defined
        // signal that this vat does not adopt resolutions: the sender
        // keeps forwarding calls addressed to the promise, which it does
        // until Release.
        this.sendUnimplemented(frame);
        break;
      default:
        // The obsolete save/delete messages.
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

  // --- client side -------------------------------------------------
  //
  // Asking questions rather than only answering them. A question is
  // outstanding from the moment it is sent until its Return arrives, so
  // the caller can pipeline against it in the meantime.

  /** Ask for the peer's bootstrap capability. Returns the questionId. */
  sendBootstrap(): number {
    const questionId = this.nextQuestionId++;
    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(OFF.messageUnion, Message.bootstrap);
    root
      .initStruct(0, BOOTSTRAP_DWORDS, BOOTSTRAP_PWORDS)
      .setU32(OFF.bootstrapQuestionId, questionId);
    this.questions.set(questionId, { failed: false });
    this.transport.send(b.toFlat());
    return questionId;
  }

  /**
   * Call a method on an imported capability. `fillParams` writes the
   * parameter struct; returns the questionId.
   *
   * The caller gives the parameter struct's dimensions because only it
   * knows the method signature. A size guessed here silently drops any
   * field past the end: two Int64 arguments need two data words, and one
   * word would lose the second without saying so.
   */
  sendCall(
    importedCapId: number,
    interfaceId: bigint,
    methodId: number,
    fillParams?: (params: StructBuilder) => void,
    paramsDwords = 1,
    paramsPwords = 1,
  ): number {
    const questionId = this.nextQuestionId++;
    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(OFF.messageUnion, Message.call);
    const call = root.initStruct(0, CALL_DWORDS, CALL_PWORDS);
    call.setU32(OFF.callQuestionId, questionId);
    call.setU64(OFF.callInterfaceId, interfaceId);
    call.setU16(OFF.callMethodId, methodId);
    const target = call.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
    target.setU16(OFF.targetUnion, MessageTarget.importedCap);
    target.setU32(OFF.targetImportedCap, importedCapId);
    const payload = call.initStruct(1, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
    if (fillParams) fillParams(payload.initStruct(0, paramsDwords, paramsPwords));
    this.questions.set(questionId, { failed: false });
    this.transport.send(b.toFlat());
    return questionId;
  }

  /** True once the Return for `questionId` has arrived. */
  isAnswered(questionId: number): boolean {
    return this.questions.get(questionId)?.reply !== undefined;
  }

  /** True when that Return carried an exception. */
  isFailed(questionId: number): boolean {
    return this.questions.get(questionId)?.failed === true;
  }

  /**
   * Results of an answered question, or undefined while it is still
   * outstanding or if it failed.
   */
  answerContent(questionId: number): Ptr | undefined {
    const q = this.questions.get(questionId);
    if (q?.reply === undefined || q.failed) return undefined;
    const ret = Message_getReturn(CapnpMessage.fromFlat(q.reply).root());
    return Payload_getContent(Return_getResults(ret));
  }

  /**
   * The import id of a capability an answer returned, or -1 when the
   * answer carries no capability.
   *
   * A returned capability arrives as a pointer into the answer's
   * capTable; calling it needs the id the descriptor beside it names,
   * which is what this reads.
   */
  answerCapId(questionId: number): number {
    const q = this.questions.get(questionId);
    if (q?.reply === undefined || q.failed) return -1;
    const ret = Message_getReturn(CapnpMessage.fromFlat(q.reply).root());
    const payload = Return_getResults(ret);
    const content = Payload_getContent(payload);
    if (content.kind !== PtrKind.Cap) return -1;
    const table = Payload_getCapTable(payload);
    if (content.count < 0 || content.count >= table.listLen()) return -1;
    const descriptor = table.listGetP(content.count);
    if (CapDescriptor_which(descriptor) !== CapDescriptor.senderHosted) return -1;
    return CapDescriptor_getSenderHosted(descriptor);
  }

  /**
   * `Provide`: ask the peer to hold `importedCapId` for a third vat.
   *
   * This is the introducer's half of a handoff. The nonce is the whole
   * of the arrangement: the recipient presents it in an `Accept`, and
   * the host matches on it alone, so it never has to take the
   * recipient's word for who sent her. Returns the question id, which
   * is also what a later `Disembargo.provide` names.
   */
  sendProvide(importedCapId: number, recipient: Introduction, nonce: bigint): number {
    const questionId = this.nextQuestionId++;
    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(OFF.messageUnion, Message.provide);
    const provide = root.initStruct(0, PROVIDE_DWORDS, PROVIDE_PWORDS);
    provide.setU32(0, questionId);
    const target = provide.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
    target.setU16(OFF.targetUnion, MessageTarget.importedCap);
    target.setU32(0, importedCapId);
    const rid = provide.initStruct(1, RECIPIENT_ID_DWORDS, RECIPIENT_ID_PWORDS);
    rid.setU64(0, nonce);
    const vat = rid.initStruct(0, VAT_ID_DWORDS, VAT_ID_PWORDS);
    vat.setText(0, recipient.host);
    vat.setU16(0, recipient.port);
    this.questions.set(questionId, { failed: false });
    this.transport.send(b.toFlat());
    return questionId;
  }

  /**
   * `Accept`: claim a capability a third vat provided for us. Returns
   * the question id; the answer carries the capability.
   */
  sendAccept(nonce: bigint, embargo = false): number {
    const questionId = this.nextQuestionId++;
    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(OFF.messageUnion, Message.accept);
    const accept = root.initStruct(0, ACCEPT_DWORDS, ACCEPT_PWORDS);
    accept.setU32(0, questionId);
    if (embargo) accept.setBool(32, true);
    accept.initStruct(0, PROVISION_ID_DWORDS, PROVISION_ID_PWORDS).setU64(0, nonce);
    this.questions.set(questionId, { failed: false });
    this.transport.send(b.toFlat());
    return questionId;
  }

  /**
   * `Disembargo` with `context.provide`: lift the embargo on the Accept
   * this vat arranged with `Provide`, naming that question.
   */
  sendDisembargoProvide(provideQuestionId: number): void {
    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(OFF.messageUnion, Message.disembargo);
    const dis = root.initStruct(0, DISEMBARGO_DWORDS, DISEMBARGO_PWORDS);
    dis.setU16(OFF.disembargoContextUnion, Disembargo_context.provide);
    dis.setU32(0, provideQuestionId);
    this.transport.send(b.toFlat());
  }

  sendFinish(questionId: number): void {
    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(OFF.messageUnion, Message.finish);
    root.initStruct(0, FINISH_DWORDS, FINISH_PWORDS).setU32(0, questionId);
    this.questions.delete(questionId);
    this.transport.send(b.toFlat());
  }

  /** Drop `count` references to an import. */
  sendRelease(importId: number, count = 1): void {
    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(OFF.messageUnion, Message.release);
    const rel = root.initStruct(0, RELEASE_DWORDS, RELEASE_PWORDS);
    rel.setU32(0, importId);
    rel.setU32(4, count);
    this.transport.send(b.toFlat());
  }

  private handleReturn(ret: Ptr, frame: Uint8Array): void {
    const answerId = Return_getAnswerId(ret);
    const q = this.questions.get(answerId);
    // A Return for a question we never asked is the peer's problem, not
    // a reason to disturb our own tables.
    if (q === undefined) return;
    q.reply = frame;
    q.failed = Return_which(ret) !== RETURN_RESULTS;
    if (!q.failed) this.noteIntroductions(Return_getResults(ret));
  }


  // --- level 3: introductions handed to us --------------------------
  //
  // The other half of the handoff. A payload can name a capability that
  // lives in a third vat, as a `thirdPartyHosted` descriptor carrying
  // where to go and a vine: an ordinary import through the introducer,
  // so calls work before we ever reach the third party. That is the
  // fallback the spec gives receivers that cannot reach one, and it is
  // why the vine must outlive the pickup. Dialling belongs to the
  // network layer, so the arrangement is recorded and handed over.

  private noteIntroductions(payload: Ptr): void {
    if (payload.kind !== PtrKind.Struct) return;
    const table = Payload_getCapTable(payload);
    for (let i = 0; i < table.listLen(); i++) {
      const descriptor = table.listGetP(i);
      if (descriptor.kind !== PtrKind.Struct) continue;
      if (CapDescriptor_which(descriptor) !== CapDescriptor.thirdPartyHosted) continue;
      const tp = CapDescriptor_getThirdPartyHosted(descriptor);
      if (tp.kind !== PtrKind.Struct) continue;
      const id = ThirdPartyCapDescriptor_getId(tp);
      if (id.kind !== PtrKind.Struct) continue;
      const vat = ThirdPartyCapId_getVat(id);
      if (vat.kind !== PtrKind.Struct) continue;
      this.introductions.set(ThirdPartyCapId_getNonce(id), {
        vineId: ThirdPartyCapDescriptor_getVineId(tp),
        host: VatId_getHost(vat),
        port: VatId_getPort(vat),
      });
    }
  }

  /** Introductions handed to us and not yet picked up. */
  pendingIntroductions(): Map<bigint, Introduction> {
    return new Map(this.introductions);
  }

  /**
   * Finish the pickup for `nonce`: releases the vine, which the sender
   * treats as the signal to close its `Provide`. Call this only once the
   * third party has actually handed the capability over; releasing early
   * drops the fallback path with nothing in its place.
   */
  introductionDone(nonce: bigint): boolean {
    const held = this.introductions.get(nonce);
    if (held === undefined) return false;
    this.introductions.delete(nonce);
    this.sendRelease(held.vineId, 1);
    return true;
  }

  /** Export ids currently live, lowest first. Exposed for tests. */
  liveExports(): number[] {
    return [...this.exports.keys()].sort((x, y) => x - y);
  }


  // --- level 3: three-party handoff ---------------------------------
  //
  // The introducer asks us to hold a capability for a third vat, and
  // that vat later claims it. Both halves key on the nonce the
  // introducer chose, which is the only thing the three messages share.

  /**
   * `Provide`: hold `target` for whoever presents this nonce.
   *
   * The answer is an empty Return: the introducer is not waiting for a
   * value, only for confirmation that the arrangement is recorded, and
   * it sends `Finish` once the recipient has been told where to go.
   */
  private handleProvide(provide: Ptr): void {
    // The peer chooses the message shape, so a truncated one is a
    // protocol error to answer rather than a reason to throw out of the
    // message loop.
    if (provide.kind !== PtrKind.Struct) return;
    const questionId = Provide_getQuestionId(provide);
    const exportId = this.resolveTarget(Provide_getTarget(provide));
    if (exportId < 0) {
      this.sendException(questionId, "provide: no such capability");
      return;
    }
    const nonce = RecipientId_getNonce(Provide_getRecipient(provide));
    // The recipient will hold a reference of its own once it accepts.
    const slot = this.exports.get(exportId)!;
    slot.refcount++;
    // The arrangement holds the capability, not this connection's id for
    // it: the recipient may well arrive on another connection. The
    // question id is how a later Disembargo names this arrangement.
    this.vat.provisions.set(nonce, { server: slot.server, questionId });
    this.sendEmptyReturn(questionId);
  }

  /**
   * `Accept`: claim a capability a third vat provided for us.
   *
   * A nonce is single-use. Leaving it claimable would let anyone who
   * learns it take the capability again later.
   */
  private handleAccept(accept: Ptr): void {
    if (accept.kind !== PtrKind.Struct) return;
    const questionId = Accept_getQuestionId(accept);
    const nonce = ProvisionId_getNonce(Accept_getProvision(accept));
    const held = this.vat.provisions.get(nonce);
    if (held === undefined) {
      this.sendException(questionId, "accept: no such provision");
      return;
    }
    this.vat.provisions.delete(nonce);
    // Export it here: the id the introducer used belongs to its own
    // connection and means nothing on this one.
    const exportId = this.exportCap(held.server);

    if (Accept_getEmbargo(accept)) {
      // Claimed, but the Return waits: the recipient has calls in flight
      // through the introducer, and answering now would let one sent
      // straight to us overtake them. The introducer lifts it with
      // Disembargo.provide.
      this.heldAccepts.set(held.questionId, { exportId, answerId: questionId });
      return;
    }
    this.sendAcceptedCap(questionId, exportId);
  }

  private sendAcceptedCap(questionId: number, exportId: number): void {
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

  /** Accepts claimed but still embargoed, awaiting Disembargo.provide. */
  embargoedAccepts(): number[] {
    return [...this.heldAccepts.keys()];
  }

  /** Pending handoffs, for tests and for shutdown accounting. */
  pendingProvisions(): bigint[] {
    return [...this.vat.provisions.keys()];
  }

  private sendEmptyReturn(questionId: number): void {
    const b = new MessageBuilder();
    const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
    root.setU16(OFF.messageUnion, Message.return);
    const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
    ret.setU32(OFF.returnAnswerId, questionId);
    ret.setU16(OFF.returnUnion, RETURN_RESULTS);
    ret.initStruct(0, PAYLOAD_DWORDS, PAYLOAD_PWORDS);
    this.sendAnswer(questionId, b.toFlat());
  }

  private handleBootstrap(bootstrap: Ptr): void {
    if (bootstrap.kind !== PtrKind.Struct) return;
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
    if (call.kind !== PtrKind.Struct) return;
    const questionId = Call_getQuestionId(call);
    // The cap table describes the message, not the dispatch: a call this
    // vat cannot route still told us where a third party's capability
    // lives.
    this.noteIntroductions(Call_getParams(call));
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
    if (join.kind !== PtrKind.Struct) return;
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

  /** `b` is needed for the cap orphan, which names a slot in its table. */
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
   * Write a one-entry capTable naming a capability hosted by a third
   * vat: where the recipient should go, which pending `Provide` to claim
   * once there, and the vine we export so calls work in the meantime.
   */
  writeThirdPartyCapTable(
    payload: StructBuilder,
    where: Introduction,
    nonce: bigint,
  ): void {
    const cd = payload.initCompositeList(
      1,
      1,
      CAP_DESCRIPTOR_DWORDS,
      CAP_DESCRIPTOR_PWORDS,
    );
    cd.setU16(OFF.capDescriptorUnion, CapDescriptor.thirdPartyHosted);
    const tp = cd.initStruct(
      0,
      THIRD_PARTY_CAP_DESCRIPTOR_DWORDS,
      THIRD_PARTY_CAP_DESCRIPTOR_PWORDS,
    );
    tp.setU32(0, where.vineId);
    const id = tp.initStruct(0, THIRD_PARTY_CAP_ID_DWORDS, THIRD_PARTY_CAP_ID_PWORDS);
    id.setU64(0, nonce);
    const vat = id.initStruct(0, VAT_ID_DWORDS, VAT_ID_PWORDS);
    vat.setText(0, where.host);
    vat.setU16(0, where.port);
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
    if (Disembargo_context_which(context) === Disembargo_context.provide) {
      // The introducer lifts the embargo on the Accept it arranged,
      // naming its own Provide question. One naming nothing we hold is
      // the sender's problem, not a reason to disturb this connection.
      const provideQuestion = Disembargo_context_getProvide(context);
      const held = this.heldAccepts.get(provideQuestion);
      if (held === undefined) return;
      this.heldAccepts.delete(provideQuestion);
      this.sendAcceptedCap(held.answerId, held.exportId);
      return;
    }
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
