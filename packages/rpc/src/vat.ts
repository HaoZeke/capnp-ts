/**
 * An RPC connection: one end of a conversation with a peer vat.
 *
 * Both halves of the protocol live here. As a caller it asks questions
 * and imports the capabilities the answers carry; as a callee it answers
 * calls on the capabilities it exports. Everything a capability can be
 * (a local object, an import, a promise, a pipelined answer) is a
 * `ClientHook`, so a call is routed the same way whichever it is.
 *
 * Levels 0 through 2 of rpc.capnp are the first half of this file:
 * bootstrap, calls, returns, finish, release, resolve and disembargo.
 * Level 3 (`Provide`/`Accept`, introductions) and level 4 (`Join`) are
 * the second half; both need a vat that spans connections, which is
 * `Vat`.
 */
import {
  Message as CapnpMessage,
  MessageBuilder,
  Ptr,
  PtrKind,
  type StructBuilder,
} from "@haozeke/capnp";

import {
  BrokenClient,
  CallBuilder,
  callStreaming,
  CallState,
  Client,
  type CallOptions,
  type ClientHook,
  type ExceptionType,
  isNullCap,
  LocalClient,
  newNullCap,
  Payload,
  RefHook,
  RpcError,
  type RpcServer,
  Settle,
  type TailHandler,
  toRpcError,
} from "./capability.ts";
import { DEFAULT_STREAM_WINDOW } from "./flow.ts";
import {
  ImportClient,
  PipelineClient,
  PromiseClient,
  QuestionRef,
  type RemoteHost,
  type RpcClientHook,
  type TargetWriter,
} from "./remote.ts";
import {
  CALL_DWORDS,
  CALL_PWORDS,
  Call_getInterfaceId,
  Call_getMethodId,
  Call_getParams,
  Call_getQuestionId,
  Call_getTarget,
  Call_sendResultsTo,
  Call_sendResultsTo_which,
  CAP_DESCRIPTOR_DWORDS,
  CAP_DESCRIPTOR_PWORDS,
  CapDescriptor,
  CapDescriptor_getReceiverAnswer,
  CapDescriptor_getReceiverHosted,
  CapDescriptor_getSenderHosted,
  CapDescriptor_getSenderPromise,
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
  JOIN_DWORDS,
  JOIN_PWORDS,
  RELEASE_DWORDS,
  RELEASE_PWORDS,
  RESOLVE_DWORDS,
  RESOLVE_PWORDS,
  DISEMBARGO_DWORDS,
  DISEMBARGO_PWORDS,
  EXCEPTION_DWORDS,
  EXCEPTION_PWORDS,
  Exception_Type,
  Exception_getReason,
  Exception_getType,
  Disembargo_context,
  Disembargo_context_getProvide,
  Disembargo_context_getSenderLoopback,
  Disembargo_context_getReceiverLoopback,
  Disembargo_context_which,
  Disembargo_getContext,
  Disembargo_getTarget,
  Finish_getQuestionId,
  Finish_getReleaseResultCaps,
  Join_getKeyPart,
  Join_getQuestionId,
  Join_getTarget,
  MESSAGE_DWORDS,
  MESSAGE_PWORDS,
  MESSAGE_TARGET_DWORDS,
  MESSAGE_TARGET_PWORDS,
  Message,
  Message_getAbort,
  Message_getBootstrap,
  Message_getCall,
  Message_getAccept,
  Message_getDisembargo,
  Message_getProvide,
  Message_getFinish,
  Message_getResolve,
  Message_getReturn,
  Message_getJoin,
  Message_getRelease,
  Message_getUnimplemented,
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
  Return,
  Return_getAnswerId,
  Return_getException,
  Return_getNoFinishNeeded,
  Return_getReleaseParamCaps,
  Return_getTakeFromOtherQuestion,
  Return_getResults,
  Return_which,
  Release_getId,
  Release_getReferenceCount,
  Resolve,
  Resolve_getCap,
  Resolve_getException,
  Resolve_getPromiseId,
  Resolve_which,
} from "./rpc.capnp.ts";
import {
  JOIN_KEY_PART_DWORDS,
  JOIN_KEY_PART_PWORDS,
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

export type { RpcServer } from "./capability.ts";

/** Field offsets the builder writes by hand; the generated code reads. */
const OFF = {
  messageUnion: 0,
  callQuestionId: 0,
  callInterfaceId: 8,
  callMethodId: 4,
  callSendResultsTo: 6,
  returnAnswerId: 0,
  returnUnion: 6,
  returnTakeFromOtherQuestion: 8,
  returnReleaseParamCaps: 32, // bit offset, default true
  finishReleaseResultCaps: 32, // bit offset, default true
  finishRequireEarly: 33, // bit offset, default true
  bootstrapQuestionId: 0,
  targetUnion: 4,
  targetImportedCap: 0,
  capDescriptorUnion: 0,
  capDescriptorId: 4,
  disembargoContextUnion: 4,
  disembargoContextValue: 0,
  resolveUnion: 4,
  exceptionType: 4,
  joinResultJoinId: 0,
  joinResultSucceeded: 32, // bit offset
} as const;

const EXCEPTION_TYPES: Record<ExceptionType, number> = {
  failed: Exception_Type.failed,
  overloaded: Exception_Type.overloaded,
  disconnected: Exception_Type.disconnected,
  unimplemented: Exception_Type.unimplemented,
};

function exceptionTypeFromWire(n: number): ExceptionType {
  switch (n) {
    case Exception_Type.overloaded:
      return "overloaded";
    case Exception_Type.disconnected:
      return "disconnected";
    case Exception_Type.unimplemented:
      return "unimplemented";
    default:
      return "failed";
  }
}

function readException(exc: Ptr): RpcError {
  if (exc.kind !== PtrKind.Struct) return new RpcError("peer sent an empty exception");
  return new RpcError(Exception_getReason(exc), exceptionTypeFromWire(Exception_getType(exc)));
}

/** A capability held for a third vat, and the Provide that arranged it. */
interface Provision {
  hook: ClientHook;
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
  hook: ClientHook;
  answerId: number;
}

export interface Introduction {
  vineId: number;
  host: string;
  port: number;
}

interface ExportSlot {
  hook: ClientHook;
  refcount: number;
  /** True while the export is a promise whose `Resolve` has yet to be sent. */
  pendingResolve: boolean;
}

/** What this vat knows of one of the peer's exports. */
interface ImportState {
  /** The shared reference to the import; its last release sends `Release`. */
  importClient?: ImportClient;
  /** What applications hold: the import itself, or a promise built on it. */
  appClient?: ClientHook;
  /** How many descriptors the peer has sent us for this id. */
  remoteRefs: number;
  /** Settles the promise client when a `Resolve` arrives. */
  resolver?: Settle<ClientHook>;
  /** True once this import has ever been introduced as a `senderPromise`. */
  wasPromise?: boolean;
}

/** A question this vat asked, from send until its Return and Finish. */
interface QuestionState {
  call: CallState;
  /** Finish goes out when this reaches zero. */
  ref: QuestionRef;
  /** Exports made for the call's params, released with the Return. */
  paramExports: number[];
  /** The Return frame, once it lands. */
  reply?: Uint8Array;
  /** True when the Return carried an exception rather than results. */
  failed: boolean;
  returned: boolean;
  finished: boolean;
  /** Peer's Return set noFinishNeeded, so no Finish message need be sent. */
  skipFinish: boolean;
  /** True when the Call used `sendResultsTo.yourself`; expects `resultsSentElsewhere`. */
  isTailCall: boolean;
}

/** A question the peer asked, from its Call until its Finish. */
interface AnswerState {
  call: CallState;
  /** Exports made for the results, released if Finish says to. */
  resultExports: number[];
  /** The call said `sendResultsTo.yourself`: the results stay here for the caller to claim. */
  resultsElsewhere: boolean;
  /** True once this answer was answered via `Return.takeFromOtherQuestion`. */
  tailSent: boolean;
  returned: boolean;
  finished: boolean;
}

interface JoinState {
  partCount: number;
  /** questionId and the capability each part named; undefined until seen. */
  parts: Array<{ questionId: number; hook: ClientHook | undefined } | undefined>;
  seen: number;
}

function newMessage(tag: number): { b: MessageBuilder; root: StructBuilder } {
  const b = new MessageBuilder();
  const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
  root.setU16(OFF.messageUnion, tag);
  return { b, root };
}

function innermost(hook: ClientHook): ClientHook {
  let h = hook;
  for (let r = h.getResolved(); r !== undefined; r = h.getResolved()) h = r;
  return h;
}

/**
 * Prevents `PromiseClient.resolve` from misclassifying a `receiverHosted`
 * export that already resolved back over this same connection as a regular
 * remote capability, which would skip the required Tribble-race Disembargo.
 */
class TribbleRaceBlocker extends RefHook implements ClientHook {
  readonly brand = TribbleRaceBlocker;
  constructor(private readonly inner: ClientHook) {
    super();
  }
  get brokenError(): RpcError | undefined {
    return this.inner.brokenError;
  }
  getResolved(): undefined {
    return undefined;
  }
  whenMoreResolved(): undefined {
    return undefined;
  }
  call(interfaceId: bigint, methodId: number, params: Payload, opts?: CallOptions): CallState {
    return this.inner.call(interfaceId, methodId, params, opts);
  }
  callStreaming(interfaceId: bigint, methodId: number, params: Payload): Promise<void> {
    return callStreaming(this.inner, interfaceId, methodId, params);
  }
  flush(): Promise<void> {
    return this.inner.flush?.() ?? Promise.resolve();
  }
  protected dispose(): void {
    this.inner.release();
  }
}

/** A single capability as a payload whose content is the capability. */
function capPayload(hook: ClientHook): Payload {
  const b = new CallBuilder(0, 1);
  b.setCap(b.root, 0, hook);
  const p = b.toPayload();
  return new Payload(p.content.getP(0), p.caps);
}

/** A payload with no content and no capabilities. */
function emptyPayload(): Payload {
  const b = new CallBuilder(0, 1);
  return new Payload(b.toPayload().content.getP(0));
}

function settledCall(payload: Payload): CallState {
  const call = new CallState();
  call.result.resolve(payload);
  call.pipeline = {
    getPipelinedCap: (ops) => payload.getPipelinedCap(ops),
  };
  return call;
}

export class RpcConnection implements RemoteHost {
  private readonly exports = new Map<number, ExportSlot>();
  private readonly exportIdByHook = new Map<ClientHook, number>();
  private readonly serverHooks = new WeakMap<RpcServer, LocalClient>();
  private readonly imports = new Map<number, ImportState>();
  private readonly joins = new Map<number, JoinState>();
  /**
   * Answers to calls the peer made, kept until it sends `Finish`.
   *
   * Promise pipelining is the reason: a caller may address a capability
   * inside an answer before it has seen the answer, so the answer has to
   * still be here when the pipelined call arrives.
   */
  private readonly answers = new Map<number, AnswerState>();
  /** Questions this vat has asked, by questionId. */
  private readonly questions = new Map<number, QuestionState>();
  private readonly embargoes = new Map<number, Settle<void>>();
  private readonly vat: Vat;
  /** Embargoed Accepts, keyed by the introducer's Provide question. */
  private readonly heldAccepts = new Map<number, HeldAccept>();
  private readonly introductions = new Map<bigint, Introduction>();
  private readonly introductionHooks = new Map<bigint, ClientHook>();
  private readonly bootstrapHook: ClientHook | undefined;
  private nextExportId = 0;
  private nextQuestionId = 0;
  private nextEmbargoId = 0;
  private gone: RpcError | undefined;

  /** Bytes of stream calls in flight per capability before a sender must wait. */
  readonly streamWindow: number;

  constructor(
    private readonly transport: Transport,
    bootstrap?: RpcServer | Client,
    vat?: Vat,
    options: { streamWindow?: number } = {},
  ) {
    this.vat = vat ?? new Vat();
    this.streamWindow = options.streamWindow ?? DEFAULT_STREAM_WINDOW;
    if (bootstrap instanceof Client) this.bootstrapHook = bootstrap.hook;
    else if (bootstrap !== undefined) this.bootstrapHook = this.hookFor(bootstrap);
  }

  get disconnected(): RpcError | undefined {
    return this.gone;
  }

  /** Handle one pending message. Returns false when none was waiting. */
  pumpOnce(): boolean {
    const frame = this.transport.receive();
    if (frame === null) {
      if (this.transport.closed) this.disconnect(new RpcError("transport closed", "disconnected"));
      return false;
    }
    if (this.gone !== undefined) return true;

    // The peer chooses what a frame contains, so one that cannot be read
    // or makes a handler throw is a protocol error: abort, rather than
    // let it escape the message loop and leave the tables half-updated.
    try {
      this.dispatchFrame(frame);
    } catch (e) {
      this.abort(new RpcError(`protocol error: ${e instanceof Error ? e.message : String(e)}`));
    }
    return true;
  }

  private dispatchFrame(frame: Uint8Array): void {
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
        this.handleFinish(Message_getFinish(root));
        break;
      case Message.release:
        this.handleRelease(Message_getRelease(root));
        break;
      case Message.resolve:
        this.handleResolve(Message_getResolve(root));
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
      case Message.abort:
        this.disconnect(readException(Message_getAbort(root)));
        break;
      case Message.unimplemented:
        this.handleUnimplemented(Message_getUnimplemented(root));
        break;
      default:
        // The obsolete save/delete messages.
        this.sendUnimplemented(frame);
        break;
    }
  }

  /** Handle every pending message. */
  pump(): number {
    let n = 0;
    while (this.pumpOnce()) n++;
    return n;
  }

  // --- exports --------------------------------------------------------

  private hookFor(server: RpcServer): LocalClient {
    let hook = this.serverHooks.get(server);
    if (hook === undefined) {
      hook = new LocalClient(server);
      this.serverHooks.set(server, hook);
    }
    return hook;
  }

  /** Export a capability, or return the id it already has. */
  exportCap(server: RpcServer): number {
    const existing = this.serverHooks.get(server);
    if (
      existing !== undefined &&
      (existing === this.bootstrapHook || this.exportIdByHook.has(existing))
    ) {
      return this.exportInner(existing, () => {});
    }
    const hook = new LocalClient(server);
    this.serverHooks.set(server, hook);
    const id = this.exportInner(hook, () => {});
    hook.release();
    return id;
  }

  /**
   * Export `inner`, which is already looked through. `describe` learns
   * the id and whether it is a promise; the export's refcount rises by
   * one either way.
   */
  private exportInner(
    inner: ClientHook,
    describe: (id: number, isPromise: boolean) => void,
  ): number {
    const existing = this.exportIdByHook.get(inner);
    if (existing !== undefined) {
      const slot = this.exports.get(existing)!;
      slot.refcount++;
      describe(existing, slot.pendingResolve);
      return existing;
    }
    const id = this.nextExportId++;
    const eventual = inner.whenMoreResolved();
    this.exports.set(id, {
      hook: inner.addRef(),
      refcount: 1,
      pendingResolve: eventual !== undefined,
    });
    this.exportIdByHook.set(inner, id);
    if (eventual !== undefined) this.resolveExportedPromise(id, inner, eventual);
    describe(id, eventual !== undefined);
    return id;
  }

  /**
   * Write the descriptor for `hook` into `desc`. Returns the export id
   * when this made one, so a payload can release it again.
   */
  private writeDescriptor(hook: ClientHook, desc: StructBuilder): number | undefined {
    const inner = innermost(hook);
    if (isNullCap(inner)) {
      desc.setU16(OFF.capDescriptorUnion, CapDescriptor.none);
      return undefined;
    }
    if (inner.brand === this) {
      (inner as RpcClientHook).writeDescriptor(desc);
      return undefined;
    }
    return this.exportInner(inner, (id, isPromise) => {
      desc.setU16(
        OFF.capDescriptorUnion,
        isPromise ? CapDescriptor.senderPromise : CapDescriptor.senderHosted,
      );
      desc.setU32(OFF.capDescriptorId, id);
    });
  }

  /**
   * Unwrap resolved promises and, for this connection, unresolved
   * `PromiseClient`s to their backing `ImportClient`/`PipelineClient` so
   * a later `Disembargo` reflects on the original wire identity.
   */
  private innermostForExport(hook: ClientHook): ClientHook {
    const inner = innermost(hook);
    if (inner.brand === this && inner instanceof PromiseClient) {
      return inner.getInnermostClient();
    }
    return inner;
  }

  /**
   * An exported promise has resolved: remember the target so calls on
   * the old id still reach it, and tell the peer, who may then call the
   * target directly.
   */
  private resolveExportedPromise(
    exportId: number,
    promiseHook: ClientHook,
    eventual: Promise<ClientHook>,
  ): void {
    const send = (fill: (resolve: StructBuilder) => void): void => {
      if (this.gone !== undefined) return;
      const { b, root } = newMessage(Message.resolve);
      const resolve = root.initStruct(0, RESOLVE_DWORDS, RESOLVE_PWORDS);
      resolve.setU32(0, exportId);
      fill(resolve);
      this.transport.send(b.toFlat());
    };
    eventual.then(
      (resolution) => {
        const slot = this.exports.get(exportId);
        if (slot === undefined || slot.hook !== promiseHook) return;
        const target = this.innermostForExport(resolution);
        if (this.exportIdByHook.get(slot.hook) === exportId) this.exportIdByHook.delete(slot.hook);
        const old = slot.hook;
        slot.hook = target.addRef();
        slot.pendingResolve = false;
        old.release();
        if (isNullCap(target)) {
          send((resolve) => {
            resolve.setU16(OFF.resolveUnion, Resolve.exception);
            this.writeException(
              resolve.initStruct(0, EXCEPTION_DWORDS, EXCEPTION_PWORDS),
              target.brokenError,
            );
          });
          return;
        }
        send((resolve) => {
          resolve.setU16(OFF.resolveUnion, Resolve.cap);
          const desc = resolve.initStruct(0, CAP_DESCRIPTOR_DWORDS, CAP_DESCRIPTOR_PWORDS);
          this.writeDescriptor(target, desc);
        });
      },
      (error) => {
        const slot = this.exports.get(exportId);
        if (slot === undefined || slot.hook !== promiseHook) return;
        slot.pendingResolve = false;
        send((resolve) => {
          resolve.setU16(OFF.resolveUnion, Resolve.exception);
          this.writeException(resolve.initStruct(0, EXCEPTION_DWORDS, EXCEPTION_PWORDS), error);
        });
      },
    );
  }

  private releaseExport(id: number, count: number): void {
    if (this.gone !== undefined) return;
    const slot = this.exports.get(id);
    if (slot === undefined) {
      this.abort(new RpcError(`Tried to release invalid export ID ${id}`));
      return;
    }
    if (count < 0 || count > slot.refcount) {
      this.abort(new RpcError(`Tried to drop export ${id} refcount below zero`));
      return;
    }
    slot.refcount -= count;
    if (slot.refcount > 0) return;
    this.exports.delete(id);
    if (this.exportIdByHook.get(slot.hook) === id) this.exportIdByHook.delete(slot.hook);
    slot.hook.release();
  }

  /** Export ids currently live, lowest first. Exposed for tests. */
  liveExports(): number[] {
    return [...this.exports.keys()].sort((x, y) => x - y);
  }

  /** Import ids currently live, lowest first. Exposed for tests. */
  liveImports(): number[] {
    return [...this.imports.keys()].sort((x, y) => x - y);
  }

  /**
   * Fill `payload` (a `Payload` struct) from `p`: the content is copied
   * in, and the cap table names every capability by the descriptor this
   * connection exports it under. Returns the ids exported.
   */
  private writePayload(payload: StructBuilder, p: Payload, releaseCaps: boolean): number[] {
    payload.setP(0, p.content);
    const exported: number[] = [];
    if (p.caps.length > 0) {
      let desc = payload.initCompositeList(
        1,
        p.caps.length,
        CAP_DESCRIPTOR_DWORDS,
        CAP_DESCRIPTOR_PWORDS,
      );
      p.caps.forEach((hook, i) => {
        if (i > 0) desc = desc.nextElement();
        const id = this.writeDescriptor(hook, desc);
        if (id !== undefined) exported.push(id);
      });
    }
    if (releaseCaps) p.release();
    return exported;
  }

  // --- imports --------------------------------------------------------

  private importCap(importId: number, isPromise: boolean): ClientHook {
    let imp = this.imports.get(importId);
    if (imp === undefined) {
      imp = { remoteRefs: 0 };
      this.imports.set(importId, imp);
    }
    imp.remoteRefs++;
    const importClient =
      imp.importClient === undefined
        ? (imp.importClient = new ImportClient(this, importId))
        : imp.importClient.addRef();

    if (!isPromise) {
      imp.appClient ??= importClient;
      return importClient;
    }
    if (imp.appClient !== undefined && imp.appClient !== imp.importClient) {
      // The descriptor names a promise we already hold a client for.
      importClient.release();
      return imp.appClient.addRef();
    }
    imp.wasPromise = true;
    imp.resolver = new Settle<ClientHook>();
    const promise = new PromiseClient(this, importClient, imp.resolver, importId);
    imp.appClient = promise;
    return promise;
  }

  importDropped(importId: number, client: ClientHook): void {
    const imp = this.imports.get(importId);
    if (imp === undefined || imp.importClient !== client) return;
    this.imports.delete(importId);
    if (this.gone === undefined && imp.remoteRefs > 0) this.sendRelease(importId, imp.remoteRefs);
  }

  promiseDropped(importId: number, client: ClientHook): void {
    const imp = this.imports.get(importId);
    if (imp !== undefined && imp.appClient === client) imp.appClient = undefined;
  }

  /** Make a hook from one entry of a received cap table. */
  private receiveCap(desc: Ptr): ClientHook {
    if (desc.kind !== PtrKind.Struct) {
      return newNullCap();
    }
    switch (CapDescriptor_which(desc)) {
      case CapDescriptor.none:
        return newNullCap();
      case CapDescriptor.senderHosted:
        return this.importCap(CapDescriptor_getSenderHosted(desc), false);
      case CapDescriptor.senderPromise:
        return this.importCap(CapDescriptor_getSenderPromise(desc), true);
      case CapDescriptor.receiverHosted: {
        const slot = this.exports.get(CapDescriptor_getReceiverHosted(desc));
        if (slot === undefined) {
          return new BrokenClient(new RpcError("descriptor names an export that does not exist"));
        }
        const hook = slot.hook.addRef();
        return hook.brand === this ? new TribbleRaceBlocker(hook) : hook;
      }
      case CapDescriptor.receiverAnswer: {
        const hook = this.pipelinedCap(CapDescriptor_getReceiverAnswer(desc));
        return hook ?? new BrokenClient(new RpcError("descriptor names an unknown answer"));
      }
      case CapDescriptor.thirdPartyHosted: {
        const tp = CapDescriptor_getThirdPartyHosted(desc);
        // The vine is an ordinary import through the introducer, which is
        // the fallback the spec gives a receiver that cannot reach the
        // third party; the introduction is recorded for whoever can.
        const vine = this.importCap(ThirdPartyCapDescriptor_getVineId(tp), false);
        const nonce = this.noteIntroduction(tp);
        if (nonce !== undefined) {
          this.introductionHooks.get(nonce)?.release();
          this.introductionHooks.set(nonce, vine.addRef());
        }
        return vine;
      }
      default:
        return new BrokenClient(new RpcError("capability descriptor is empty or unknown"));
    }
  }

  private receiveCaps(payload: Ptr): ClientHook[] {
    if (payload.kind !== PtrKind.Struct) return [];
    const table = Payload_getCapTable(payload);
    if (table.kind !== PtrKind.List) return [];
    const hooks: ClientHook[] = [];
    for (let i = 0; i < table.listLen(); i++) hooks.push(this.receiveCap(table.listGetP(i)));
    return hooks;
  }

  // --- client side -------------------------------------------------
  //
  // Asking questions rather than only answering them. A question is
  // outstanding from the moment it is sent until its Return arrives, so
  // the caller can pipeline against it in the meantime.

  private newQuestion(): { id: number; q: QuestionState } {
    const id = this.nextQuestionId++;
    const call = new CallState();
    const q: QuestionState = {
      call,
      ref: new QuestionRef(() => this.finishQuestion(id)),
      paramExports: [],
      failed: false,
      returned: false,
      finished: false,
      skipFinish: false,
      isTailCall: false,
    };
    call.pipeline = {
      getPipelinedCap: (ops) => this.pipelineOf(id, q, ops),
    };
    call.onRelease = () => q.ref.release();
    this.questions.set(id, q);
    return { id, q };
  }

  private pipelineOf(id: number, q: QuestionState, ops: readonly number[]): ClientHook {
    const r = q.call.result;
    if (r.state === "ok") return r.value.getPipelinedCap(ops);
    if (r.state === "err") return new BrokenClient(r.error);
    const eventual = new Settle<ClientHook>();
    r.onSettled((s) => {
      eventual.resolve(s.state === "ok" ? s.value.getPipelinedCap(ops) : new BrokenClient(s.error));
    });
    return new PromiseClient(
      this,
      new PipelineClient(this, q.ref.addRef(), id, ops),
      eventual,
      undefined,
    );
  }

  /** The last interest in a question is gone: tell the peer. */
  private finishQuestion(id: number): void {
    const q = this.questions.get(id);
    if (q === undefined) return;
    q.finished = true;
    if (q.returned) this.questions.delete(id);
    if (this.gone !== undefined || q.skipFinish) return;
    const { b, root } = newMessage(Message.finish);
    const finish = root.initStruct(0, FINISH_DWORDS, FINISH_PWORDS);
    finish.setU32(0, id);
    // Results already received are held through imports of our own, which
    // send their own Release. Results never received are abandoned here.
    finish.setBool(OFF.finishReleaseResultCaps, !q.returned, true);
    finish.setBool(OFF.finishRequireEarly, false, true);
    this.transport.send(b.toFlat());
  }

  /** Ask for the peer's bootstrap capability. Returns the questionId. */
  sendBootstrap(): number {
    return this.startBootstrap().id;
  }

  /** The peer's bootstrap capability, usable before the answer arrives. */
  bootstrap(): Client {
    const { q } = this.startBootstrap();
    const cap = q.call.pipeline.getPipelinedCap([]);
    q.call.release();
    return new Client(cap);
  }

  private startBootstrap(): { id: number; q: QuestionState } {
    const question = this.newQuestion();
    if (this.gone !== undefined) {
      this.failQuestion(question.q, this.gone);
      return question;
    }
    const { b, root } = newMessage(Message.bootstrap);
    root
      .initStruct(0, BOOTSTRAP_DWORDS, BOOTSTRAP_PWORDS)
      .setU32(OFF.bootstrapQuestionId, question.id);
    this.transport.send(b.toFlat());
    return question;
  }

  private failQuestion(q: QuestionState, error: RpcError): void {
    q.returned = true;
    q.failed = true;
    q.call.result.reject(error);
  }

  sendCallTo(
    write: TargetWriter,
    interfaceId: bigint,
    methodId: number,
    params: Payload,
    opts?: CallOptions,
  ): CallState {
    const { id, q } = this.newQuestion();
    if (this.gone !== undefined) {
      params.release();
      this.failQuestion(q, this.gone);
      return q.call;
    }
    const { b, root } = newMessage(Message.call);
    const call = root.initStruct(0, CALL_DWORDS, CALL_PWORDS);
    call.setU32(OFF.callQuestionId, id);
    call.setU64(OFF.callInterfaceId, interfaceId);
    call.setU16(OFF.callMethodId, methodId);
    if (opts?.sendResultsToYourself) {
      call.setU16(OFF.callSendResultsTo, Call_sendResultsTo.yourself);
      q.isTailCall = true;
    }
    write(call.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS));
    q.paramExports = this.writePayload(
      call.initStruct(1, PAYLOAD_DWORDS, PAYLOAD_PWORDS),
      params,
      true,
    );
    const frame = b.toFlat();
    q.call.wireSize = frame.length;
    this.transport.send(frame);
    return q.call;
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
    const params = new CallBuilder(paramsDwords, paramsPwords);
    fillParams?.(params.root);
    const call = this.sendCallTo(
      (t) => {
        t.setU16(OFF.targetUnion, MessageTarget.importedCap);
        t.setU32(OFF.targetImportedCap, importedCapId);
      },
      interfaceId,
      methodId,
      params.toPayload(),
    );
    return this.questionIdOf(call);
  }

  private questionIdOf(call: CallState): number {
    for (const [id, q] of this.questions) if (q.call === call) return id;
    throw new RpcError("call has no question");
  }

  /** True once the Return for `questionId` has arrived. */
  isAnswered(questionId: number): boolean {
    return this.questions.get(questionId)?.returned === true;
  }

  /** True when that Return carried an exception. */
  isFailed(questionId: number): boolean {
    return this.questions.get(questionId)?.failed === true;
  }

  /** Why a question failed, or undefined while it is outstanding or if it succeeded. */
  answerError(questionId: number): RpcError | undefined {
    const r = this.questions.get(questionId)?.call.result;
    return r?.state === "err" ? r.error : undefined;
  }

  /**
   * Results of an answered question, or undefined while it is still
   * outstanding or if it failed.
   */
  answerContent(questionId: number): Ptr | undefined {
    const r = this.questions.get(questionId)?.call.result;
    return r?.state === "ok" ? r.value.content : undefined;
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
    const r = this.questions.get(questionId)?.call.result;
    if (r?.state !== "ok") return -1;
    const content = r.value.content;
    if (content.kind !== PtrKind.Cap) return -1;
    const hook = r.value.caps[content.count];
    if (hook === undefined) return -1;
    const inner = innermost(hook);
    if (inner instanceof ImportClient) return inner.importId;
    return -1;
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
    const { id, q } = this.newQuestion();
    if (this.gone !== undefined) {
      this.failQuestion(q, this.gone);
      return id;
    }
    const { b, root } = newMessage(Message.provide);
    const provide = root.initStruct(0, PROVIDE_DWORDS, PROVIDE_PWORDS);
    provide.setU32(0, id);
    const target = provide.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
    target.setU16(OFF.targetUnion, MessageTarget.importedCap);
    target.setU32(0, importedCapId);
    const rid = provide.initStruct(1, RECIPIENT_ID_DWORDS, RECIPIENT_ID_PWORDS);
    rid.setU64(0, nonce);
    const vat = rid.initStruct(0, VAT_ID_DWORDS, VAT_ID_PWORDS);
    vat.setText(0, recipient.host);
    vat.setU16(0, recipient.port);
    this.transport.send(b.toFlat());
    return id;
  }

  /**
   * `Accept`: claim a capability a third vat provided for us. Returns
   * the question id; the answer carries the capability.
   */
  sendAccept(nonce: bigint, embargo = false): number {
    const { id, q } = this.newQuestion();
    if (this.gone !== undefined) {
      this.failQuestion(q, this.gone);
      return id;
    }
    const { b, root } = newMessage(Message.accept);
    const accept = root.initStruct(0, ACCEPT_DWORDS, ACCEPT_PWORDS);
    accept.setU32(0, id);
    if (embargo) accept.setBool(32, true);
    accept.initStruct(0, PROVISION_ID_DWORDS, PROVISION_ID_PWORDS).setU64(0, nonce);
    this.transport.send(b.toFlat());
    return id;
  }

  /**
   * `Join` (level 4): ask the peer whether `importedCapId` is the same
   * object as the capabilities the other parts of this join name. Every
   * part of one join sends its own `Join` with the same `joinId`; the
   * peer answers once the last part has arrived. Returns the question id.
   */
  sendJoin(importedCapId: number, joinId: number, partCount: number, partNum: number): number {
    const { id, q } = this.newQuestion();
    if (this.gone !== undefined) {
      this.failQuestion(q, this.gone);
      return id;
    }
    const { b, root } = newMessage(Message.join);
    const join = root.initStruct(0, JOIN_DWORDS, JOIN_PWORDS);
    join.setU32(0, id);
    const target = join.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS);
    target.setU16(OFF.targetUnion, MessageTarget.importedCap);
    target.setU32(0, importedCapId);
    const key = join.initStruct(1, JOIN_KEY_PART_DWORDS, JOIN_KEY_PART_PWORDS);
    key.setU32(0, joinId);
    key.setU16(4, partCount);
    key.setU16(6, partNum);
    this.transport.send(b.toFlat());
    return id;
  }

  /**
   * `Disembargo` with `context.provide`: lift the embargo on the Accept
   * this vat arranged with `Provide`, naming that question.
   */
  sendDisembargoProvide(provideQuestionId: number): void {
    const { b, root } = newMessage(Message.disembargo);
    const dis = root.initStruct(0, DISEMBARGO_DWORDS, DISEMBARGO_PWORDS);
    dis.setU16(OFF.disembargoContextUnion, Disembargo_context.provide);
    dis.setU32(0, provideQuestionId);
    this.transport.send(b.toFlat());
  }

  /** Stop caring about a question: its answer is dropped, a pending call canceled. */
  sendFinish(questionId: number): void {
    this.questions.get(questionId)?.call.release();
  }

  /** Drop `count` references to an import. */
  sendRelease(importId: number, count = 1): void {
    const { b, root } = newMessage(Message.release);
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
    if (q === undefined || q.returned) return;
    q.returned = true;
    q.reply = frame;
    const which = Return_which(ret);
    q.failed = which !== Return.results;

    if (Return_getReleaseParamCaps(ret)) {
      for (const id of q.paramExports) this.releaseExport(id, 1);
    }
    q.paramExports = [];
    if (Return_getNoFinishNeeded(ret)) q.skipFinish = true;

    switch (which) {
      case Return.results: {
        if (q.isTailCall) {
          this.abort(new RpcError("Tail call Return must set resultsSentElsewhere, not results"));
          return;
        }
        const payload = Return_getResults(ret);
        // Our Finish already said to drop the results, so nothing is
        // imported for a question that was abandoned.
        if (q.finished) break;
        q.call.result.resolve(new Payload(Payload_getContent(payload), this.receiveCaps(payload)));
        break;
      }
      case Return.exception:
        if (q.isTailCall) {
          this.abort(new RpcError("Tail call Return must set resultsSentElsewhere, not exception"));
          return;
        }
        if (!q.finished) q.call.result.reject(readException(Return_getException(ret)));
        break;
      case Return.canceled:
        if (!q.finished) q.call.result.reject(new RpcError("call was canceled"));
        break;
      case Return.resultsSentElsewhere:
        if (!q.isTailCall) {
          this.abort(
            new RpcError("Return had resultsSentElsewhere but this was not a tail call"),
          );
          return;
        }
        q.failed = false;
        if (!q.finished) q.call.result.resolve(emptyPayload());
        break;
      case Return.takeFromOtherQuestion:
        this.takeResults(q, Return_getTakeFromOtherQuestion(ret));
        break;
      default:
        if (!q.finished) {
          q.call.result.reject(new RpcError("unsupported Return variant", "unimplemented"));
        }
        break;
    }
    if (q.finished) this.questions.delete(answerId);
  }

  /**
   * The peer forwarded our call back to us with `sendResultsTo.yourself`
   * and answers this question with "take them from that one". The
   * results are the ones this vat computed for the forwarded call, so
   * they never crossed the wire twice.
   */
  private takeResults(q: QuestionState, otherAnswerId: number): void {
    const other = this.answers.get(otherAnswerId);
    if (other === undefined || !other.resultsElsewhere) {
      if (!q.finished) q.call.result.reject(new RpcError("takeFromOtherQuestion names no held answer"));
      return;
    }
    if (q.finished) {
      other.call.release();
      return;
    }
    other.call.result.onSettled((s) => {
      if (q.finished) return;
      if (s.state !== "ok") q.call.result.reject(s.error);
      else {
        q.failed = false;
        q.call.result.resolve(new Payload(s.value.content, s.value.caps.map((c) => c.addRef())));
      }
    });
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

  private noteIntroduction(tp: Ptr): bigint | undefined {
    if (tp.kind !== PtrKind.Struct) return undefined;
    const id = ThirdPartyCapDescriptor_getId(tp);
    if (id.kind !== PtrKind.Struct) return undefined;
    const vat = ThirdPartyCapId_getVat(id);
    if (vat.kind !== PtrKind.Struct) return undefined;
    const nonce = ThirdPartyCapId_getNonce(id);
    this.introductions.set(nonce, {
      vineId: ThirdPartyCapDescriptor_getVineId(tp),
      host: VatId_getHost(vat),
      port: VatId_getPort(vat),
    });
    return nonce;
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
    if (!this.introductions.has(nonce)) return false;
    this.introductions.delete(nonce);
    this.introductionHooks.get(nonce)?.release();
    this.introductionHooks.delete(nonce);
    return true;
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
    if (this.answers.has(questionId)) {
      this.abort(new RpcError(`provide reuses question id ${questionId} still in use`));
      return;
    }
    const hook = this.targetHook(Provide_getTarget(provide));
    if (hook === undefined) {
      this.answerWithError(questionId, new RpcError("provide: no such capability"));
      return;
    }
    const nonce = RecipientId_getNonce(Provide_getRecipient(provide));
    // The arrangement holds the capability, not this connection's id for
    // it: the recipient may well arrive on another connection. The
    // question id is how a later Disembargo names this arrangement.
    this.vat.provisions.set(nonce, { hook, questionId });
    this.answerNow(questionId, emptyPayload());
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
    if (this.answers.has(questionId)) {
      this.abort(new RpcError(`accept reuses question id ${questionId} still in use`));
      return;
    }
    const nonce = ProvisionId_getNonce(Accept_getProvision(accept));
    const held = this.vat.provisions.get(nonce);
    if (held === undefined) {
      this.answerWithError(questionId, new RpcError("accept: no such provision"));
      return;
    }
    this.vat.provisions.delete(nonce);

    if (Accept_getEmbargo(accept)) {
      // Claimed, but the Return waits: the recipient has calls in flight
      // through the introducer, and answering now would let one sent
      // straight to us overtake them. The introducer lifts it with
      // Disembargo.provide.
      this.heldAccepts.set(held.questionId, { hook: held.hook, answerId: questionId });
      return;
    }
    this.answerNow(questionId, capPayload(held.hook));
  }

  /** Accepts claimed but still embargoed, awaiting Disembargo.provide. */
  embargoedAccepts(): number[] {
    return [...this.heldAccepts.keys()];
  }

  /** Pending handoffs, for tests and for shutdown accounting. */
  pendingProvisions(): bigint[] {
    return [...this.vat.provisions.keys()];
  }

  // --- answering ------------------------------------------------------

  private handleBootstrap(bootstrap: Ptr): void {
    if (bootstrap.kind !== PtrKind.Struct) return;
    const questionId = Bootstrap_getQuestionId(bootstrap);
    if (this.answers.has(questionId)) {
      this.abort(new RpcError(`bootstrap reuses question id ${questionId} still in use`));
      return;
    }
    if (this.bootstrapHook === undefined) {
      this.answerWithError(questionId, new RpcError("no bootstrap capability"));
      return;
    }
    this.answerNow(questionId, capPayload(this.bootstrapHook.addRef()));
  }

  private handleCall(call: Ptr): void {
    if (call.kind !== PtrKind.Struct) return;
    const questionId = Call_getQuestionId(call);
    if (this.answers.has(questionId)) {
      this.abort(new RpcError(`call reuses question id ${questionId} still in use`));
      return;
    }
    const sendTo = Call_sendResultsTo_which(call);
    if (sendTo !== Call_sendResultsTo.caller && sendTo !== Call_sendResultsTo.yourself) {
      this.abort(new RpcError("unsupported Call.sendResultsTo"));
      return;
    }
    // The cap table describes the message, not the dispatch: a call this
    // vat cannot route still told us where a third party's capability
    // lives.
    const params = Call_getParams(call);
    const caps = this.receiveCaps(params);
    const target = this.targetHook(Call_getTarget(call));
    if (target === undefined) {
      caps.forEach((c) => c.release());
      this.answerWithError(questionId, new RpcError("no such export"));
      return;
    }
    const answer = this.newAnswer(questionId);
    answer.resultsElsewhere = sendTo === Call_sendResultsTo.yourself;
    const tailHandler: TailHandler | undefined = answer.resultsElsewhere
      ? undefined
      : {
          tryTailCall: (cap, iface, method, callParams) =>
            this.trySendTailCall(questionId, answer, cap, iface, method, callParams),
        };
    const state = target.call(
      Call_getInterfaceId(call),
      Call_getMethodId(call),
      new Payload(Payload_getContent(params), caps),
      tailHandler !== undefined ? { tailHandler } : undefined,
    );
    target.release();
    answer.call = state;
    state.result.onSettled((s) => this.completeAnswer(questionId, answer, s));
  }

  /**
   * Forward an incoming call back across the same connection with
   * `sendResultsTo.yourself`, immediately answering the original call with
   * `Return.takeFromOtherQuestion`.
   */
  private trySendTailCall(
    questionId: number,
    answer: AnswerState,
    target: ClientHook,
    interfaceId: bigint,
    methodId: number,
    params: Payload,
  ): CallState | undefined {
    if (this.gone !== undefined || answer.returned || answer.finished) return undefined;
    const inner = innermost(target);
    if (inner.brand !== this) return undefined;
    const tail = this.sendCallTo(
      (t) => (inner as RpcClientHook).writeTarget(t),
      interfaceId,
      methodId,
      params,
      { sendResultsToYourself: true },
    );
    const tailId = this.questionIdOf(tail);
    answer.returned = true;
    answer.tailSent = true;
    const { b, root } = newMessage(Message.return);
    const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
    ret.setU32(OFF.returnAnswerId, questionId);
    ret.setU16(OFF.returnUnion, Return.takeFromOtherQuestion);
    ret.setU32(OFF.returnTakeFromOtherQuestion, tailId);
    ret.setBool(OFF.returnReleaseParamCaps, false, true);
    this.transport.send(b.toFlat());
    return tail;
  }

  private newAnswer(questionId: number): AnswerState {
    const answer: AnswerState = {
      call: undefined as unknown as CallState,
      resultExports: [],
      resultsElsewhere: false,
      tailSent: false,
      returned: false,
      finished: false,
    };
    this.answers.set(questionId, answer);
    return answer;
  }

  /** Answer with results already in hand. */
  private answerNow(questionId: number, payload: Payload): void {
    const answer = this.newAnswer(questionId);
    answer.call = settledCall(payload);
    this.completeAnswer(questionId, answer, answer.call.result);
  }

  private answerWithError(questionId: number, error: RpcError): void {
    const answer = this.newAnswer(questionId);
    answer.call = new CallState();
    answer.call.pipeline = { getPipelinedCap: () => new BrokenClient(error) };
    answer.call.result.reject(error);
    this.completeAnswer(questionId, answer, answer.call.result);
  }

  private completeAnswer(questionId: number, answer: AnswerState, s: Settle<Payload>): void {
    if (answer.tailSent) {
      if (answer.finished) this.answers.delete(questionId);
      return;
    }
    answer.returned = true;
    const finished = answer.finished;
    if (finished) this.answers.delete(questionId);
    if (this.gone !== undefined) return;
    if (answer.resultsElsewhere) {
      // Even when the call failed or was canceled, a sendResultsTo.yourself
      // Return must be resultsSentElsewhere so the peer does not abort.
      const { b, root } = newMessage(Message.return);
      const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
      ret.setU32(OFF.returnAnswerId, questionId);
      ret.setU16(OFF.returnUnion, Return.resultsSentElsewhere);
      ret.setBool(OFF.returnReleaseParamCaps, false, true);
      this.transport.send(b.toFlat());
      return;
    }
    if (finished) {
      // The caller sent Finish before we returned; reply Return.canceled so
      // it can release the question table entry without waiting forever.
      const { b, root } = newMessage(Message.return);
      const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
      ret.setU32(OFF.returnAnswerId, questionId);
      ret.setU16(OFF.returnUnion, Return.canceled);
      ret.setBool(OFF.returnReleaseParamCaps, false, true);
      this.transport.send(b.toFlat());
      return;
    }
    if (s.state === "ok") {
      const { b, root } = newMessage(Message.return);
      const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
      ret.setU32(OFF.returnAnswerId, questionId);
      ret.setU16(OFF.returnUnion, Return.results);
      // This side releases the params' capabilities itself, with Release.
      ret.setBool(OFF.returnReleaseParamCaps, false, true);
      answer.resultExports = this.writePayload(
        ret.initStruct(0, PAYLOAD_DWORDS, PAYLOAD_PWORDS),
        s.value,
        false,
      );
      this.transport.send(b.toFlat());
    } else {
      this.sendException(questionId, s.error);
    }
  }

  private handleFinish(finish: Ptr): void {
    const questionId = Finish_getQuestionId(finish);
    const answer = this.answers.get(questionId);
    if (answer === undefined || answer.finished) return;
    answer.finished = true;
    if (Finish_getReleaseResultCaps(finish)) {
      for (const id of answer.resultExports) this.releaseExport(id, 1);
      answer.resultExports = [];
    }
    // Releasing the call is what cancels it, if it is still running.
    answer.call.release();
    if (answer.returned) this.answers.delete(questionId);
  }

  private handleRelease(release: Ptr): void {
    this.releaseExport(Release_getId(release), Release_getReferenceCount(release));
  }

  /**
   * Resolve a MessageTarget to a capability, as a reference the caller
   * must release, or undefined when it names nothing this vat hosts.
   *
   * `promisedAnswer` is promise pipelining: the caller addressed a
   * capability inside an answer, identified by walking the transform ops
   * into that answer's results.
   */
  private targetHook(target: Ptr): ClientHook | undefined {
    switch (MessageTarget_which(target)) {
      case MessageTarget.importedCap: {
        const slot = this.exports.get(MessageTarget_getImportedCap(target));
        return slot?.hook.addRef();
      }
      case MessageTarget.promisedAnswer:
        return this.pipelinedCap(MessageTarget_getPromisedAnswer(target));
      default:
        return undefined;
    }
  }

  private pipelinedCap(promised: Ptr): ClientHook | undefined {
    if (promised.kind !== PtrKind.Struct) return undefined;
    const answer = this.answers.get(PromisedAnswer_getQuestionId(promised));
    if (answer === undefined) return undefined;
    const ops: number[] = [];
    const transform = PromisedAnswer_getTransform(promised);
    for (let i = 0; i < transform.listLen(); i++) {
      const op = transform.listGetP(i);
      if (PromisedAnswer_Op_which(op) !== PromisedAnswer_Op.getPointerField) continue;
      ops.push(PromisedAnswer_Op_getGetPointerField(op));
    }
    return answer.call.pipeline.getPipelinedCap(ops);
  }

  // --- resolution and embargo -----------------------------------------

  private handleResolve(resolve: Ptr): void {
    const id = Resolve_getPromiseId(resolve);
    const imp = this.imports.get(id);
    if (imp !== undefined && imp.resolver === undefined && !imp.wasPromise && imp.importClient !== undefined) {
      this.abort(new RpcError("Got Resolve for a non-promise import"));
      return;
    }
    const resolver = imp?.resolver;
    if (imp !== undefined) imp.resolver = undefined;
    if (Resolve_which(resolve) === Resolve.cap) {
      const desc = Resolve_getCap(resolve);
      if (desc.kind !== PtrKind.Struct || CapDescriptor_which(desc) === CapDescriptor.none) {
        this.abort(new RpcError("Resolve contained CapDescriptor.none"));
        return;
      }
      const hook = this.receiveCap(desc);
      // A promise nobody holds any more still sent us a reference.
      if (resolver === undefined) hook.release();
      else resolver.resolve(hook);
    } else if (Resolve_which(resolve) === Resolve.exception) {
      resolver?.reject(readException(Resolve_getException(resolve)));
    } else {
      this.abort(new RpcError("Unknown Resolve type"));
    }
  }

  startEmbargo(target: RpcClientHook): Settle<void> {
    const id = this.nextEmbargoId++;
    const settle = new Settle<void>();
    this.embargoes.set(id, settle);
    const { b, root } = newMessage(Message.disembargo);
    const dis = root.initStruct(0, DISEMBARGO_DWORDS, DISEMBARGO_PWORDS);
    target.writeTarget(dis.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS));
    dis.setU16(OFF.disembargoContextUnion, Disembargo_context.senderLoopback);
    dis.setU32(OFF.disembargoContextValue, id);
    this.transport.send(b.toFlat());
    return settle;
  }

  /**
   * A Disembargo with `senderLoopback` is echoed back as
   * `receiverLoopback` carrying the same id. That reflection is what lets
   * the sender know every call it had already sent through a promise has
   * arrived, so it can stop routing new ones the long way round.
   */
  private handleDisembargo(disembargo: Ptr): void {
    const context = Disembargo_getContext(disembargo);
    switch (Disembargo_context_which(context)) {
      case Disembargo_context.provide: {
        // The introducer lifts the embargo on the Accept it arranged,
        // naming its own Provide question. One naming nothing we hold is
        // the sender's problem, not a reason to disturb this connection.
        const provideQuestion = Disembargo_context_getProvide(context);
        const held = this.heldAccepts.get(provideQuestion);
        if (held === undefined) return;
        this.heldAccepts.delete(provideQuestion);
        this.answerNow(held.answerId, capPayload(held.hook));
        return;
      }
      case Disembargo_context.receiverLoopback: {
        const id = Disembargo_context_getReceiverLoopback(context);
        const embargo = this.embargoes.get(id);
        if (embargo === undefined) {
          this.abort(new RpcError("Invalid embargo ID in Disembargo.context.receiverLoopback"));
          return;
        }
        this.embargoes.delete(id);
        embargo.resolve();
        return;
      }
      case Disembargo_context.senderLoopback: {
        const id = Disembargo_context_getSenderLoopback(context);
        const hook = this.targetHook(Disembargo_getTarget(disembargo));
        if (hook === undefined) {
          this.abort(new RpcError("Disembargo target does not exist"));
          return;
        }
        const finishLoopback = (resolved: ClientHook): void => {
          if (this.gone !== undefined) {
            resolved.release();
            return;
          }
          const inner = innermost(resolved);
          if (inner.brand !== this) {
            resolved.release();
            this.abort(
              new RpcError("Disembargo senderLoopback sent to an object that does not point back"),
            );
            return;
          }
          const { b, root } = newMessage(Message.disembargo);
          const out = root.initStruct(0, DISEMBARGO_DWORDS, DISEMBARGO_PWORDS);
          (inner as RpcClientHook).writeTarget(
            out.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS),
          );
          resolved.release();
          // `context` is a group, so it shares Disembargo's own data section
          // rather than living behind a pointer.
          out.setU16(OFF.disembargoContextUnion, Disembargo_context.receiverLoopback);
          out.setU32(OFF.disembargoContextValue, id);
          this.transport.send(b.toFlat());
        };
        const current = innermost(hook);
        if (current.whenMoreResolved() === undefined) {
          finishLoopback(hook);
          return;
        }
        // Target is still a pending promise (for example behind an embargo on
        // a middle hop); wait until it settles before checking and echoing.
        void (async () => {
          let h = hook;
          try {
            for (;;) {
              const cur = innermost(h);
              const more = cur.whenMoreResolved();
              if (more === undefined) break;
              const next = (await more).addRef();
              h.release();
              h = next;
            }
            finishLoopback(h);
          } catch (e) {
            h.release();
            this.abort(
              new RpcError(
                `Disembargo target failed while resolving: ${e instanceof Error ? e.message : String(e)}`,
              ),
            );
          }
        })();
        return;
      }
      default:
        return;
    }
  }

  // --- level 4 -----------------------------------------------------

  /**
   * Level 4. On a two-party network the comparison is decidable locally:
   * both ends can only name capabilities this vat exports, so the same
   * object has the same hook. A vat bridging to another network would
   * forward the join onward instead, which needs a three-party layer
   * this transport does not have.
   */
  private handleJoin(join: Ptr): void {
    if (join.kind !== PtrKind.Struct) return;
    const questionId = Join_getQuestionId(join);
    if (this.answers.has(questionId)) {
      this.abort(new RpcError(`join reuses question id ${questionId} still in use`));
      return;
    }
    const keyPart = Join_getKeyPart(join);
    if (keyPart.kind !== PtrKind.Struct) {
      // Without a JoinKeyPart there is no way to tell which set this
      // belongs to, so it can only fail on its own.
      this.sendJoinResult(questionId, 0, false, undefined);
      return;
    }

    const joinId = JoinKeyPart_getJoinId(keyPart);
    const partCount = JoinKeyPart_getPartCount(keyPart);
    const partNum = JoinKeyPart_getPartNum(keyPart);
    if (partCount <= 0 || partNum < 0 || partNum >= partCount) {
      this.sendJoinResult(questionId, joinId, false, undefined);
      return;
    }

    let state = this.joins.get(joinId);
    if (state === undefined) {
      state = { partCount, parts: new Array(partCount).fill(undefined), seen: 0 };
      this.joins.set(joinId, state);
    } else if (state.partCount !== partCount || state.parts[partNum] !== undefined) {
      // A disagreeing partCount, or a partNum reused before the set
      // completed, makes the set unanswerable.
      this.sendJoinResult(questionId, joinId, false, undefined);
      return;
    }

    state.parts[partNum] = { questionId, hook: this.targetHook(Join_getTarget(join)) };
    state.seen++;
    if (state.seen < state.partCount) return;

    this.joins.delete(joinId);
    const parts = state.parts as Array<{ questionId: number; hook: ClientHook | undefined }>;
    const first = parts[0]!.hook === undefined ? undefined : innermost(parts[0]!.hook);
    // A part naming nothing we host cannot be shown equal to anything.
    const same =
      first !== undefined && parts.every((p) => p.hook !== undefined && innermost(p.hook) === first);
    // Exactly one result carries the joined capability, per JoinResult.
    parts.forEach((part, i) => {
      this.sendJoinResult(part.questionId, joinId, same, same && i === 0 ? part.hook : undefined);
    });
    for (const part of parts) part.hook?.release();
  }

  private sendJoinResult(
    questionId: number,
    joinId: number,
    succeeded: boolean,
    cap: ClientHook | undefined,
  ): void {
    const b = new CallBuilder(JOIN_RESULT_DWORDS, JOIN_RESULT_PWORDS);
    b.root.setU32(OFF.joinResultJoinId, joinId);
    b.root.setBool(OFF.joinResultSucceeded, succeeded);
    if (cap !== undefined) b.setCap(b.root, 0, cap.addRef());
    this.answerNow(questionId, b.toPayload());
  }

  /**
   * Write a one-entry capTable naming a capability hosted by a third
   * vat: where the recipient should go, which pending `Provide` to claim
   * once there, and the vine we export so calls work in the meantime.
   */
  writeThirdPartyCapTable(payload: StructBuilder, where: Introduction, nonce: bigint): void {
    const cd = payload.initCompositeList(1, 1, CAP_DESCRIPTOR_DWORDS, CAP_DESCRIPTOR_PWORDS);
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

  // --- errors and shutdown --------------------------------------------

  private writeException(exc: StructBuilder, error: unknown): void {
    const e = toRpcError(error);
    exc.setU16(OFF.exceptionType, EXCEPTION_TYPES[e.type]);
    exc.setText(0, e.message);
  }

  private sendException(questionId: number, error: RpcError): void {
    const { b, root } = newMessage(Message.return);
    const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
    ret.setU32(OFF.returnAnswerId, questionId);
    ret.setU16(OFF.returnUnion, Return.exception);
    ret.setBool(OFF.returnReleaseParamCaps, false, true);
    this.writeException(ret.initStruct(0, EXCEPTION_DWORDS, EXCEPTION_PWORDS), error);
    this.transport.send(b.toFlat());
  }

  /** Echo a message we did not understand, per the spec. */
  private sendUnimplemented(frame: Uint8Array): void {
    const incoming = CapnpMessage.fromFlat(frame).root();
    const { b, root } = newMessage(Message.unimplemented);
    root.setP(0, incoming);
    this.transport.send(b.toFlat());
  }

  /**
   * The peer did not understand a message of ours. A question it ignored
   * will never be answered, so it fails with `unimplemented`. A
   * capability sent in a `Resolve` it ignored will never be used, so the
   * reference it would have held is released.
   */
  private handleUnimplemented(echoed: Ptr): void {
    if (echoed.kind !== PtrKind.Struct) return;
    const unimplemented = new RpcError("peer does not implement this message", "unimplemented");
    switch (Message_which(echoed)) {
      case Message.call:
        this.failAsked(Call_getQuestionId(Message_getCall(echoed)), unimplemented);
        return;
      case Message.bootstrap:
        this.failAsked(Bootstrap_getQuestionId(Message_getBootstrap(echoed)), unimplemented);
        return;
      case Message.provide:
        this.failAsked(Provide_getQuestionId(Message_getProvide(echoed)), unimplemented);
        return;
      case Message.accept:
        this.failAsked(Accept_getQuestionId(Message_getAccept(echoed)), unimplemented);
        return;
      case Message.join:
        this.failAsked(Join_getQuestionId(Message_getJoin(echoed)), unimplemented);
        return;
      case Message.resolve: {
        const resolve = Message_getResolve(echoed);
        if (Resolve_which(resolve) !== Resolve.cap) return;
        const desc = Resolve_getCap(resolve);
        if (desc.kind !== PtrKind.Struct) return;
        switch (CapDescriptor_which(desc)) {
          case CapDescriptor.senderHosted:
            this.releaseExport(CapDescriptor_getSenderHosted(desc), 1);
            break;
          case CapDescriptor.senderPromise:
            this.releaseExport(CapDescriptor_getSenderPromise(desc), 1);
            break;
          case CapDescriptor.thirdPartyHosted: {
            const tp = CapDescriptor_getThirdPartyHosted(desc);
            if (tp.kind === PtrKind.Struct) {
              this.releaseExport(ThirdPartyCapDescriptor_getVineId(tp), 1);
            }
            break;
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private failAsked(questionId: number, error: RpcError): void {
    const q = this.questions.get(questionId);
    if (q === undefined || q.returned) return;
    this.failQuestion(q, error);
    for (const id of q.paramExports) this.releaseExport(id, 1);
    q.paramExports = [];
    if (q.finished) this.questions.delete(questionId);
  }

  /**
   * Give up on the connection after an unrecoverable error: tell the
   * peer why with `Abort`, then fail everything that was waiting.
   */
  abort(error: RpcError): void {
    if (this.gone !== undefined) return;
    try {
      const { b, root } = newMessage(Message.abort);
      this.writeException(root.initStruct(0, EXCEPTION_DWORDS, EXCEPTION_PWORDS), error);
      this.transport.send(b.toFlat());
    } catch {
      // The transport may be what failed; the connection is going either way.
    }
    this.disconnect(error);
  }

  /**
   * The connection is over, by `Abort` from the peer, by transport
   * closure, or by our own `abort`. Every question still waiting fails,
   * every import becomes a broken capability, and everything exported
   * is released.
   */
  disconnect(error: RpcError): void {
    if (this.gone !== undefined) return;
    this.gone = error.type === "disconnected" ? error : new RpcError(error.message, "disconnected");
    const reason = this.gone;

    for (const q of this.questions.values()) {
      if (!q.returned) this.failQuestion(q, reason);
    }
    for (const embargo of this.embargoes.values()) embargo.reject(reason);
    this.embargoes.clear();
    for (const imp of this.imports.values()) {
      const resolver = imp.resolver;
      imp.resolver = undefined;
      resolver?.reject(reason);
    }

    for (const answer of this.answers.values()) {
      answer.finished = true;
      answer.call?.release();
    }
    this.answers.clear();
    for (const slot of this.exports.values()) slot.hook.release();
    this.exports.clear();
    this.exportIdByHook.clear();
    for (const hook of this.introductionHooks.values()) hook.release();
    this.introductionHooks.clear();
    for (const held of this.heldAccepts.values()) held.hook.release();
    this.heldAccepts.clear();
    for (const join of this.joins.values()) {
      for (const part of join.parts) part?.hook?.release();
    }
    this.joins.clear();
    this.transport.close();
  }
}
