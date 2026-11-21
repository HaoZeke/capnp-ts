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
  disabledPipeline,
  Client,
  type CallOptions,
  type ClientHook,
  type ExceptionType,
  isNullCap,
  LocalClient,
  newNullCap,
  Payload,
  QueuedClient,
  RefHook,
  RpcError,
  type RpcServer,
  Settle,
  type TailHandler,
  toRpcError,
} from "./capability.ts";
import { DEFAULT_STREAM_WINDOW, WindowFlowController, type WindowGetter } from "./flow.ts";
import {
  ImportClient,
  PipelineClient,
  PromiseClient,
  QuestionRef,
  type RemoteHost,
  type RpcClientHook,
  type TargetWriter,
} from "./remote.ts";
import type { Restorer } from "./restorer.ts";
import {
  CALL_DWORDS,
  CALL_PWORDS,
  Call_getInterfaceId,
  Call_getMethodId,
  Call_getNoPromisePipelining,
  Call_getOnlyPromisePipeline,
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
  Bootstrap_getDeprecatedObjectId,
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
  Exception_getTrace,
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
  Finish_getRequireEarlyCancellationWorkaround,
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
  callNoPromisePipelining: 129,
  callOnlyPromisePipeline: 130,
  returnAnswerId: 0,
  returnUnion: 6,
  returnTakeFromOtherQuestion: 8,
  returnReleaseParamCaps: 32, // bit offset, default true
  returnNoFinishNeeded: 33, // bit offset
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

const REMOTE_PREFIX = "remote exception: ";

/** A received exception, as capnp-C++ `toException()` reads one for every message kind. */
function readException(exc: Ptr): RpcError {
  const e = structOrDefault(exc);
  const trace = e.getP(1).kind === PtrKind.Null ? undefined : Exception_getTrace(e);
  const reason = Exception_getReason(e);
  const message = reason.startsWith(REMOTE_PREFIX) ? reason : REMOTE_PREFIX + reason;
  return new RpcError(message, exceptionTypeFromWire(Exception_getType(e)), trace);
}

/**
 * A `Disembargo` in capnp-C++'s text format, as its errors print one:
 * every scalar, non-null pointers, and the active union member.
 */
function disembargoText(d: Ptr): string {
  const context = ["senderLoopback", "receiverLoopback", "accept", "provide"];
  const which = d.getU16(OFF.disembargoContextUnion);
  const name = context[which];
  let ctx = "";
  if (name === "accept") ctx = "accept = void";
  else if (name !== undefined) ctx = `${name} = ${d.getU32(OFF.disembargoContextValue)}`;
  const target = d.getP(0);
  const fields = target.kind === PtrKind.Null ? [] : [`target = ${messageTargetText(target)}`];
  fields.push(`context = (${ctx})`);
  return `(${fields.join(", ")})`;
}

function messageTargetText(t: Ptr): string {
  switch (t.getU16(4)) {
    case 0:
      return `(importedCap = ${t.getU32(0)})`;
    case 1: {
      const pa = structOrDefault(t.getP(0));
      const fields = [`questionId = ${pa.getU32(0)}`];
      const ops = pa.getP(0);
      if (ops.kind === PtrKind.List) {
        const parts: string[] = [];
        for (let i = 0; i < ops.listLen(); i++) {
          const op = ops.listGetP(i);
          const w = op.getU16(0);
          parts.push(w === 0 ? "(noop = void)" : w === 1 ? `(getPointerField = ${op.getU16(2)})` : "()");
        }
        fields.push(`transform = [${parts.join(", ")}]`);
      }
      return `(promisedAnswer = (${fields.join(", ")}))`;
    }
    default:
      return "()";
  }
}

/** RPC frames are read as capnp-C++ `FlatArrayMessageReader` reads them, with no segment cap. */
const RPC_FRAME = { maxSegments: Number.MAX_SAFE_INTEGER };

let emptyStruct: Ptr | undefined;

/** `p`, or a struct with no fields when `p` is null: every field reads as its default. */
function structOrDefault(p: Ptr): Ptr {
  if (p.kind !== PtrKind.Null) return p;
  if (emptyStruct === undefined) {
    const b = new MessageBuilder();
    b.initRoot(0, 0);
    emptyStruct = CapnpMessage.fromFlat(b.toFlat()).root();
  }
  return emptyStruct;
}

/** A capability held for a third vat, and the Provide that arranged it. */
interface Provision {
  hook: ClientHook;
  questionId: number;
  /** The connection the `Provide` came in on; the arrangement ends with it. */
  owner: RpcConnection;
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
 * Connections given no vat are two-party, as capnp-C++ 1.4 always is:
 * they echo `Provide`, `Accept` and `Join` back as unimplemented.
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
  /** Redirected answer claimed by `Return.takeFromOtherQuestion`, canceled if `q` finishes. */
  redirectedCall?: CallState;
}

/** A question the peer asked, from its Call until its Finish. */
interface AnswerState {
  call: CallState;
  /** Exports made for the results, released if Finish says to. */
  resultExports: number[];
  /** The call said `sendResultsTo.yourself`: the results stay here for the caller to claim. */
  resultsElsewhere: boolean;
  /** True once `Return.takeFromOtherQuestion` claimed a redirected answer. */
  redirectClaimed: boolean;
  /**
   * `Call.onlyPromisePipeline`: keep the answer so the peer can pipeline,
   * but do not send `Return` or export the result capabilities.
   */
  onlyPromisePipeline: boolean;
  /** `Call.noPromisePipelining`: the caller will not pipeline on this answer. */
  noPromisePipelining: boolean;
  /** True once this answer was answered via `Return.takeFromOtherQuestion`. */
  tailSent: boolean;
  /** A Call's answer: its pipeline is frozen when the Return carries capabilities. */
  isCall: boolean;
  /** A Bootstrap's answer, a capnp-C++ `SingleCapPipeline`: any transform at all is invalid. */
  singleCap: boolean;
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

/**
 * Run `fn` once the work already queued has run, as `kj::evalLast` does.
 * The package avoids runtime-specific globals, and `setImmediate` is
 * missing from browsers and workers.
 */
function afterQueuedWork(fn: () => void): void {
  if (typeof setImmediate === "function") setImmediate(fn);
  else setTimeout(fn, 0);
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
  /** No vat was given, so level 3 and 4 messages are refused. */
  private readonly twoParty: boolean;
  /** Embargoed Accepts, keyed by the introducer's Provide question. */
  private readonly heldAccepts = new Map<number, HeldAccept>();
  private readonly introductions = new Map<bigint, Introduction>();
  private readonly introductionHooks = new Map<bigint, ClientHook>();
  private readonly bootstrapHook: ClientHook | undefined;
  private nextExportId = 0;
  private nextQuestionId = 0;
  private nextHighQuestionId = 0;
  /** The peer answered a pipeline-only question, so it ignores the hint. */
  private gotReturnForHighQuestionId = false;
  private nextEmbargoId = 0;
  private gone: RpcError | undefined;

  private readonly windowGetter: WindowGetter;
  private flowLimit: number;
  private traceEncoder: ((error: RpcError) => string) | undefined;
  private readonly restorer: Restorer | undefined;
  /** Words of incoming calls not yet complete, as capnp-C++ `callWordsInFlight`. */
  private callWordsInFlight = 0;
  private flowBlocked = false;
  /** Returns waiting for queued work, oldest first. */
  private readonly waitingReturns: Array<() => void> = [];

  constructor(
    private readonly transport: Transport,
    bootstrap?: RpcServer | Client,
    vat?: Vat,
    options: {
      streamWindow?: number | (() => number) | WindowGetter;
      /** Words of incoming calls in flight past which no more messages are read. Unlimited by default. */
      flowLimit?: number;
      /** Fills `Exception.trace` in what this side sends, as capnp-C++ `setTraceEncoder`. */
      traceEncoder?: (error: RpcError) => string;
      /** Answers named Bootstraps, and plain ones when no bootstrap is given. */
      restorer?: Restorer;
    } = {},
  ) {
    this.flowLimit = options.flowLimit ?? Infinity;
    this.traceEncoder = options.traceEncoder;
    this.restorer = options.restorer;
    this.vat = vat ?? new Vat();
    this.twoParty = vat === undefined;
    const w = options.streamWindow;
    if (typeof w === "number") {
      this.windowGetter = { getWindow: () => w };
    } else if (typeof w === "function") {
      this.windowGetter = { getWindow: w };
    } else if (w !== undefined) {
      this.windowGetter = w;
    } else {
      // capnp-C++ two-party uses the transport send buffer when the
      // socket reports one, and otherwise a fixed 64 KiB window. The
      // adaptive window is only used when the caller passes one in
      // streamWindow.
      let useTransportBuf = transport.getSendBufferSize !== undefined;
      this.windowGetter = {
        getWindow: () => {
          if (useTransportBuf) {
            const buf = transport.getSendBufferSize?.();
            if (buf !== undefined && buf > 0) return buf;
            useTransportBuf = false;
          }
          return DEFAULT_STREAM_WINDOW;
        },
      };
    }
    // The connection owns one ref, as capnp-C++'s RpcSystem owns the
    // bootstrap Client. Each Bootstrap answer addRefs again. Without the
    // owned ref, releasing the caller's Client drops the hook and the
    // next Bootstrap throws "capability used after release".
    if (bootstrap instanceof Client) this.bootstrapHook = bootstrap.hook.addRef();
    else if (bootstrap !== undefined) this.bootstrapHook = this.hookFor(bootstrap);
  }

  /** Current stream window in bytes before a sender must wait. */
  get streamWindow(): number {
    return this.windowGetter.getWindow();
  }

  createFlowController(): WindowFlowController {
    return new WindowFlowController(this.windowGetter);
  }

  get disconnected(): RpcError | undefined {
    return this.gone;
  }

  /** Handle one pending message. Returns false when none was waiting. */
  pumpOnce(): boolean {
    // As capnp-C++ `messageLoop`: past the flow limit, wait for calls to
    // complete before reading more.
    if (this.callWordsInFlight > this.flowLimit && this.gone === undefined) {
      this.flowBlocked = true;
      return false;
    }
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
    const msg = CapnpMessage.fromFlat(frame, RPC_FRAME);
    const root = msg.root();
    const which = Message_which(root);
    // Every body is the union's one pointer. A null one reads as the
    // default struct, as capnp-C++'s generated getters return.
    const body = (get: (p: Ptr) => Ptr): Ptr => structOrDefault(get(root));

    switch (which) {
      case Message.bootstrap:
        this.handleBootstrap(body(Message_getBootstrap));
        break;
      case Message.call:
        this.handleCall(body(Message_getCall), frame.length / 8);
        break;
      case Message.finish:
        this.handleFinish(body(Message_getFinish));
        break;
      case Message.release:
        this.handleRelease(body(Message_getRelease));
        break;
      case Message.resolve:
        this.handleResolve(body(Message_getResolve));
        break;
      case Message.join:
        if (this.twoParty) this.sendUnimplemented(frame);
        else this.handleJoin(body(Message_getJoin));
        break;
      case Message.disembargo:
        this.handleDisembargo(body(Message_getDisembargo));
        break;
      case Message.return:
        this.handleReturn(body(Message_getReturn), frame);
        break;
      case Message.provide:
        if (this.twoParty) this.sendUnimplemented(frame);
        else this.handleProvide(body(Message_getProvide));
        break;
      case Message.accept:
        if (this.twoParty) this.sendUnimplemented(frame);
        else this.handleAccept(body(Message_getAccept));
        break;
      case Message.abort:
        this.abort(readException(body(Message_getAbort)));
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
        old.release();
        if (target.brand !== this) {
          // A local promise not yet exported takes over this entry, and
          // no Resolve goes out until it settles. A broken capability is
          // such a promise, already rejected.
          const more = target.whenMoreResolved();
          if (more !== undefined && !this.exportIdByHook.has(target)) {
            this.exportIdByHook.set(target, exportId);
            this.resolveExportedPromise(exportId, target, more);
            return;
          }
        }
        slot.pendingResolve = false;
        send((resolve) => {
          resolve.setU16(OFF.resolveUnion, Resolve.cap);
          const desc = resolve.initStruct(0, CAP_DESCRIPTOR_DWORDS, CAP_DESCRIPTOR_PWORDS);
          // capnp-C++ exports a null capability here like any other.
          if (!isNullCap(target)) {
            this.writeDescriptor(target, desc);
            return;
          }
          this.exportInner(target, (id) => {
            desc.setU16(OFF.capDescriptorUnion, CapDescriptor.senderHosted);
            desc.setU32(OFF.capDescriptorId, id);
          });
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
    if (!p.contentIsNull) payload.setP(0, p.content);
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
        const hook = this.pipelinedCap(CapDescriptor_getReceiverAnswer(desc), "descriptor");
        if (hook === undefined) {
          return new BrokenClient(new RpcError("descriptor names an unknown answer"));
        }
        return hook.brand === this ? new TribbleRaceBlocker(hook) : hook;
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
        this.abort(new RpcError("unknown CapDescriptor type"));
        return new BrokenClient(new RpcError("unknown CapDescriptor type"));
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

  private newQuestion(id = this.nextQuestionId++): { id: number; q: QuestionState } {
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
    q.redirectedCall?.release();
    q.redirectedCall = undefined;
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
    return this.restore();
  }

  /** A named export of the peer, as capnp-C++ `EzRpcClient::importCap`. */
  restore(name?: string): Client {
    const { q } = this.startBootstrap(name);
    const cap = q.call.pipeline.getPipelinedCap([]);
    q.call.release();
    return new Client(cap);
  }

  private startBootstrap(name?: string): { id: number; q: QuestionState } {
    const question = this.newQuestion();
    if (this.gone !== undefined) {
      this.failQuestion(question.q, this.gone);
      return question;
    }
    const { b, root } = newMessage(Message.bootstrap);
    const bs = root.initStruct(0, BOOTSTRAP_DWORDS, BOOTSTRAP_PWORDS);
    bs.setU32(OFF.bootstrapQuestionId, question.id);
    if (name !== undefined) bs.setText(0, name);
    this.transport.send(b.toFlat());
    return question;
  }

  private failQuestion(q: QuestionState, error: RpcError): void {
    q.returned = true;
    q.failed = true;
    q.call.result.reject(error);
  }

  /** A question id with the top bit set, as capnp-C++ `ExportTable::nextHigh` picks one. */
  private highQuestionId(): number {
    for (;;) {
      const id = (0x80000000 | (this.nextHighQuestionId++ & 0x7fffffff)) >>> 0;
      if (!this.questions.has(id)) return id;
    }
  }

  sendCallTo(
    write: TargetWriter,
    interfaceId: bigint,
    methodId: number,
    params: Payload,
    opts?: CallOptions,
  ): CallState {
    // A peer that answered one pipeline-only call gets plain calls after.
    const pipelineOnly =
      opts?.onlyPromisePipeline === true &&
      !opts.sendResultsToYourself &&
      !this.gotReturnForHighQuestionId;
    const { id, q } = pipelineOnly ? this.newQuestion(this.highQuestionId()) : this.newQuestion();
    if (opts?.noPromisePipelining) q.call.pipeline = disabledPipeline;
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
    if (opts?.noPromisePipelining) call.setBool(OFF.callNoPromisePipelining, true);
    if (pipelineOnly) {
      call.setBool(OFF.callOnlyPromisePipeline, true);
      // No Return is coming, so the Finish need not wait for one.
      q.returned = true;
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
   * which is what this reads. With `pointerIndex`, the capability is the
   * one in that pointer field of the result struct, as in `JoinResult`.
   */
  answerCapId(questionId: number, pointerIndex?: number): number {
    const r = this.questions.get(questionId)?.call.result;
    if (r?.state !== "ok") return -1;
    const content =
      pointerIndex === undefined ? r.value.content : r.value.content.getP(pointerIndex);
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
    // A pipeline-only question id has the high bit set. C++ ignores a
    // Return for those, because the id may already have been reused.
    if (answerId >= 0x80000000) {
      this.gotReturnForHighQuestionId = true;
      return;
    }
    const q = this.questions.get(answerId);
    if (q === undefined) {
      this.abort(new RpcError("Invalid question ID in Return message."));
      return;
    }
    if (q.returned) {
      this.abort(new RpcError("Duplicate Return."));
      return;
    }
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
          this.abort(
            new RpcError("Tail call `Return` must set `resultsSentElsewhere`, not `results`."),
          );
          return;
        }
        const payload = Return_getResults(ret);
        // Our Finish already said to drop the results, so nothing is
        // imported for a question that was abandoned.
        if (q.finished) break;
        q.call.result.resolve(
          payload.kind === PtrKind.Null
            ? emptyPayload()
            : new Payload(Payload_getContent(payload), this.receiveCaps(payload)),
        );
        break;
      }
      case Return.exception:
        if (q.isTailCall) {
          this.abort(
            new RpcError("Tail call `Return` must set `resultsSentElsewhere`, not `exception`."),
          );
          return;
        }
        if (!q.finished) q.call.result.reject(readException(Return_getException(ret)));
        break;
      case Return.canceled:
        // Legal only as the reply to a Finish we already sent. C++ treats
        // Return.canceled for a question the caller still holds as a
        // protocol error and disconnects.
        if (!q.finished) {
          this.abort(new RpcError("Return message falsely claims call was canceled."));
          return;
        }
        break;
      case Return.resultsSentElsewhere:
        if (!q.isTailCall) {
          this.abort(
            new RpcError("`Return` had `resultsSentElsewhere` but this was not a tail call."),
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
        this.abort(new RpcError("Unknown 'Return' type."));
        return;
    }
    // Finish already told the peer this question is done. The Return is
    // still the acknowledgement a streaming flow controller waits on;
    // leaving the result pending keeps those bytes in the window and
    // flush() never resolves.
    if (q.finished && q.call.result.state === "pending") {
      q.call.result.resolve(emptyPayload());
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
    if (q.finished) {
      const other = this.answers.get(otherAnswerId);
      if (other !== undefined && other.resultsElsewhere && !other.redirectClaimed) {
        other.redirectClaimed = true;
        other.call.release();
        this.sendRedirectReturn(otherAnswerId, other);
      }
      return;
    }
    const other = this.answers.get(otherAnswerId);
    if (other === undefined) {
      this.abort(new RpcError("`Return.takeFromOtherQuestion` had invalid answer ID."));
      return;
    }
    if (!other.resultsElsewhere || other.redirectClaimed || other.finished) {
      this.abort(
        new RpcError(
          "`Return.takeFromOtherQuestion` referenced a call that did not use `sendResultsTo.yourself`.",
        ),
      );
      return;
    }
    // The first claim consumes the redirected answer. A second claim of the
    // same answer is a protocol error, as in capnp-C++.
    other.redirectClaimed = true;
    this.sendRedirectReturn(otherAnswerId, other);
    q.redirectedCall = other.call;
    other.call.result.onSettled((s) => {
      q.redirectedCall = undefined;
      if (!q.finished) {
        if (s.state !== "ok") q.call.result.reject(s.error);
        else {
          q.failed = false;
          q.call.result.resolve(
            new Payload(
              s.value.content,
              s.value.caps.map((c) => c.addRef()),
            ),
          );
        }
      } else if (q.call.result.state === "pending") {
        q.call.result.resolve(emptyPayload());
      }
      if (other.finished) other.call.release();
    });
  }

  private sendRedirectReturn(questionId: number, answer: AnswerState): void {
    if (answer.returned) return;
    answer.returned = true;
    if (answer.finished && this.answers.get(questionId) === answer) {
      this.answers.delete(questionId);
    }
    if (this.gone !== undefined) return;
    const { b, root } = newMessage(Message.return);
    const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
    ret.setU32(OFF.returnAnswerId, questionId);
    ret.setU16(OFF.returnUnion, Return.resultsSentElsewhere);
    ret.setBool(OFF.returnReleaseParamCaps, false, true);
    this.transport.send(b.toFlat());
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
    this.vat.provisions.get(nonce)?.hook.release();
    this.vat.provisions.set(nonce, { hook, questionId, owner: this });
    this.answerNow(questionId, emptyPayload());
  }

  /**
   * `Accept`: claim a capability a third vat provided for us.
   *
   * A nonce is single-use. Leaving it claimable would let anyone who
   * learns it take the capability again later.
   */
  private handleAccept(accept: Ptr): void {
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

  /**
   * `Bootstrap`, as capnp-C++ `handleBootstrap` answers it. The Return
   * leaves `releaseParamCaps` at its default: there were no params.
   * Pipelined calls reach the capability the Return named, and only with
   * an empty transform.
   */
  private handleBootstrap(bootstrap: Ptr): void {
    const questionId = Bootstrap_getQuestionId(bootstrap);
    if (this.answers.has(questionId)) {
      this.abort(new RpcError(`bootstrap reuses question id ${questionId} still in use`));
      return;
    }
    const answer = this.newAnswer(questionId);
    answer.returned = true;
    answer.singleCap = true;
    const { b, root } = newMessage(Message.return);
    const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
    ret.setU32(OFF.returnAnswerId, questionId);
    let pipelineCap: ClientHook;
    let cap: ClientHook | RpcError;
    try {
      cap = this.bootstrapCap(Bootstrap_getDeprecatedObjectId(bootstrap));
    } catch (e) {
      cap = e instanceof RpcError ? e : new RpcError(String(e));
    }
    if (cap instanceof RpcError) {
      const error = cap;
      ret.setU16(OFF.returnUnion, Return.exception);
      this.writeException(ret.initStruct(0, EXCEPTION_DWORDS, EXCEPTION_PWORDS), error);
      answer.call = new CallState();
      answer.call.result.reject(error);
      pipelineCap = new BrokenClient(error);
    } else {
      pipelineCap = this.innermostForExport(cap).addRef();
      const payload = capPayload(cap);
      ret.setU16(OFF.returnUnion, Return.results);
      answer.resultExports = this.writePayload(
        ret.initStruct(0, PAYLOAD_DWORDS, PAYLOAD_PWORDS),
        payload,
        false,
      );
      answer.call = settledCall(payload);
    }
    answer.call.pipeline = {
      getPipelinedCap: (ops) =>
        ops.length === 0
          ? pipelineCap.addRef()
          : new BrokenClient(new RpcError("Invalid pipeline transform.")),
    };
    const onRelease = answer.call.onRelease;
    answer.call.onRelease = () => {
      onRelease?.();
      pipelineCap.release();
    };
    this.transport.send(b.toFlat());
  }

  /** What a Bootstrap names, as capnp-C++ `handleBootstrap` and `baseCreateFor`. */
  private bootstrapCap(objectId: Ptr): ClientHook {
    if (objectId.kind !== PtrKind.Null) {
      if (this.restorer === undefined) {
        throw new RpcError(
          "This vat only supports a bootstrap interface, not the old Cap'n-Proto-0.4-style named exports.",
        );
      }
      return this.restorer(objectId).hook.addRef();
    }
    if (this.bootstrapHook !== undefined) return this.bootstrapHook.addRef();
    if (this.restorer !== undefined) return this.restorer(objectId).hook.addRef();
    return new BrokenClient(new RpcError("This vat does not expose any public/bootstrap interfaces."));
  }

  /** As capnp-C++ `RpcSystem::setTraceEncoder`. */
  setTraceEncoder(encode: ((error: RpcError) => string) | undefined): void {
    this.traceEncoder = encode;
  }

  /** As capnp-C++ `RpcSystem::setFlowLimit`. */
  setFlowLimit(words: number): void {
    this.flowLimit = words;
    this.maybeUnblockFlow();
  }

  private maybeUnblockFlow(): void {
    if (!this.flowBlocked || this.callWordsInFlight >= this.flowLimit) return;
    this.flowBlocked = false;
    afterQueuedWork(() => {
      if (this.gone === undefined) this.pump();
    });
  }

  private handleCall(call: Ptr, words: number): void {
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
    const target = this.targetHook(Call_getTarget(call), true);
    if (target === undefined) {
      caps.forEach((c) => c.release());
      return;
    }
    let callPayload: Payload;
    try {
      callPayload =
        params.kind === PtrKind.Null
          ? emptyPayload()
          : new Payload(Payload_getContent(params), caps);
    } catch (e) {
      target.release();
      caps.forEach((c) => c.release());
      throw e;
    }
    const answer = this.newAnswer(questionId);
    answer.isCall = true;
    answer.resultsElsewhere = sendTo === Call_sendResultsTo.yourself;
    // Redirected results ignore onlyPromisePipeline: the peer is waiting
    // on resultsSentElsewhere, not on a pipeline-only hint.
    answer.onlyPromisePipeline =
      !answer.resultsElsewhere && Call_getOnlyPromisePipeline(call);
    answer.noPromisePipelining = Call_getNoPromisePipelining(call);
    const tailHandler: TailHandler | undefined = answer.resultsElsewhere
      ? undefined
      : {
          tryTailCall: (cap, iface, method, callParams) =>
            this.trySendTailCall(questionId, answer, cap, iface, method, callParams),
        };
    const onError = (e: unknown): void => {
      const message = e instanceof Error ? e.message : String(e);
      this.abort(new RpcError(message));
    };
    const opts: CallOptions = { onError };
    if (tailHandler !== undefined) opts.tailHandler = tailHandler;
    // As capnp-C++ passes the call's hints to `startCall`: a forwarded or
    // tail call goes out with `sendForPipeline()`.
    if (answer.onlyPromisePipeline) opts.onlyPromisePipeline = true;
    const state = target.call(Call_getInterfaceId(call), Call_getMethodId(call), callPayload, opts);
    target.release();
    answer.call = state;
    state.onError = onError;
    this.callWordsInFlight += words;
    state.result.onSettled((s) => {
      this.callWordsInFlight -= words;
      this.returnInOrder(() => this.completeAnswer(questionId, answer, s));
      this.maybeUnblockFlow();
    });
  }

  /**
   * capnp-C++ sends a call's Return as a continuation of the call, so an
   * exported promise the call resolved reaches the wire first. Here a
   * Return waits for queued work while any exported promise is unresolved,
   * and a later Return never overtakes one that waits.
   */
  private returnInOrder(send: () => void): void {
    if (this.waitingReturns.length === 0) {
      let pending = false;
      for (const slot of this.exports.values()) if (slot.pendingResolve) pending = true;
      if (!pending) {
        send();
        return;
      }
    }
    this.waitingReturns.push(send);
    if (this.waitingReturns.length > 1) return;
    afterQueuedWork(() => {
      try {
        while (this.waitingReturns.length > 0) {
          this.waitingReturns[0]!();
          this.waitingReturns.shift();
        }
      } catch (e) {
        this.waitingReturns.length = 0;
        this.abort(new RpcError(`protocol error: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
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
    // The caller ignores this Return, so skipping the round trip gains nothing.
    if (answer.noPromisePipelining) return undefined;
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
      redirectClaimed: false,
      onlyPromisePipeline: false,
      noPromisePipelining: false,
      tailSent: false,
      isCall: false,
      singleCap: false,
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
      if (answer.finished && this.answers.get(questionId) === answer) {
        this.answers.delete(questionId);
      }
      return;
    }
    if (answer.resultsElsewhere) {
      // A Finish that arrived while this call was still open is answered
      // once the call settles. Until then the peer has not been told that
      // the redirect is done.
      if (answer.finished && !answer.returned) this.sendRedirectReturn(questionId, answer);
      return;
    }
    if (answer.onlyPromisePipeline) {
      // The caller will pipeline and then Finish. A Return here would
      // export capabilities the peer never Releases.
      answer.returned = true;
      if (answer.finished && this.answers.get(questionId) === answer) {
        this.answers.delete(questionId);
      }
      return;
    }
    answer.returned = true;
    const finished = answer.finished;
    if (finished && this.answers.get(questionId) === answer) this.answers.delete(questionId);
    if (this.gone !== undefined) return;
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
      if (answer.isCall && s.value.caps.length > 0) this.freezePipeline(answer, s.value);
      const noCaps = answer.isCall && s.value.caps.length === 0;
      if (noCaps) {
        // Nothing to pipeline on and nothing to release: the caller need
        // not Finish, and the answer goes now.
        ret.setBool(OFF.returnNoFinishNeeded, true);
        answer.finished = true;
        if (this.answers.get(questionId) === answer) this.answers.delete(questionId);
      }
      this.transport.send(b.toFlat());
      if (noCaps) answer.call.release();
    } else {
      this.sendException(questionId, s.error);
    }
  }

  /**
   * `PostReturnRpcPipeline`: once the Return has named the result
   * capabilities, pipelined calls and Disembargos on this answer reach
   * what the Return described, even if a promise among them later
   * resolves elsewhere. That is the Tribble 4-way race in rpc.capnp.
   */
  private freezePipeline(answer: AnswerState, results: Payload): void {
    const atReturn = new Map<ClientHook, ClientHook>();
    for (const cap of results.caps) {
      if (atReturn.has(cap)) continue;
      const inner = this.innermostForExport(cap);
      if (inner !== cap) atReturn.set(cap, inner.addRef());
    }
    const live = answer.call.pipeline;
    answer.call.pipeline = {
      getPipelinedCap: (ops) =>
        this.resolutionAtReturnTime(
          live.getPipelinedCap(ops),
          results.getPipelinedCap(ops),
          atReturn,
        ),
    };
    const onRelease = answer.call.onRelease;
    answer.call.onRelease = () => {
      onRelease?.();
      for (const h of atReturn.values()) h.release();
      atReturn.clear();
    };
  }

  /** Follow `original` to `returned` and answer what `returned` was at Return time. Takes both references. */
  private resolutionAtReturnTime(
    original: ClientHook,
    returned: ClientHook,
    atReturn: Map<ClientHook, ClientHook>,
  ): ClientHook {
    let ptr = original;
    for (;;) {
      if (ptr === returned) {
        const unwrapped = (atReturn.get(returned) ?? returned).addRef();
        original.release();
        returned.release();
        return unwrapped;
      }
      const r = ptr.getResolved();
      if (r === undefined) break;
      ptr = r;
    }
    const more = ptr.whenMoreResolved();
    if (more !== undefined) {
      const eventual = new Settle<ClientHook>();
      more.then(
        (next) => {
          eventual.resolve(this.resolutionAtReturnTime(next.addRef(), returned, atReturn));
          original.release();
        },
        (e) => {
          eventual.reject(e);
          original.release();
          returned.release();
        },
      );
      return new QueuedClient(eventual);
    }
    if (ptr.brokenError !== undefined) {
      const broken = ptr.addRef();
      original.release();
      returned.release();
      return broken;
    }
    original.release();
    returned.release();
    return new BrokenClient(
      new RpcError(
        "An RPC call's capnp::PipelineHook object resolved a pipelined capability to a " +
          "different final object than what was returned in the actual response. This could " +
          "be a bug in Cap'n Proto, or could be due to a use of context.setPipeline() that " +
          "was inconsistent with the later results.",
      ),
    );
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
    if (answer.redirectClaimed) {
      if (answer.returned && this.answers.get(questionId) === answer) {
        this.answers.delete(questionId);
      }
      if (answer.call.result.state !== "pending") answer.call.release();
      return;
    }
    if (answer.resultsElsewhere) {
      // `sendResultsTo.yourself` is a redirected task in C++. Finish drops
      // it before the next message is read. `requireEarlyCancellationWorkaround`
      // does not postpone that drop: the flag only covers a still-running
      // direct call. A call that refuses cancellation keeps running, and
      // `resultsSentElsewhere` follows when the call settles.
      answer.call.release();
      if (!answer.returned && answer.call.result.state !== "pending") {
        this.sendRedirectReturn(questionId, answer);
      }
      return;
    }
    const releaseCall = (): void => {
      // Releasing the call is what cancels it, if it is still running.
      answer.call.release();
      if (answer.returned && this.answers.get(questionId) === answer) {
        this.answers.delete(questionId);
      }
    };
    if (
      Finish_getRequireEarlyCancellationWorkaround(finish) &&
      answer.call.result.state === "pending"
    ) {
      afterQueuedWork(() => {
        // Nothing wraps this turn the way `pumpOnce` wraps a message.
        try {
          releaseCall();
        } catch (e) {
          this.abort(new RpcError(`protocol error: ${e instanceof Error ? e.message : String(e)}`));
        }
      });
    } else {
      releaseCall();
    }
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
  private targetHook(target: Ptr, abortOnInvalid = false): ClientHook | undefined {
    switch (MessageTarget_which(target)) {
      case MessageTarget.importedCap: {
        const slot = this.exports.get(MessageTarget_getImportedCap(target));
        if (slot !== undefined) return slot.hook.addRef();
        if (abortOnInvalid) this.abort(new RpcError("Message target is not a current export ID."));
        return undefined;
      }
      case MessageTarget.promisedAnswer: {
        const hook = this.pipelinedCap(
          MessageTarget_getPromisedAnswer(target),
          abortOnInvalid ? "target" : "legacy",
        );
        if (hook !== undefined) return hook;
        if (this.gone !== undefined || !abortOnInvalid) return undefined;
        return new BrokenClient(
          new RpcError("Pipeline call on a request that returned no capabilities or was already closed."),
        );
      }
      default:
        if (abortOnInvalid) this.abort(new RpcError("Unknown message target type."));
        return undefined;
    }
  }

  /**
   * The capability a `PromisedAnswer` names.
   *
   * The modes follow capnp-C++ where it has a rule and p33 where the
   * level 3 extensions share the lookup:
   * - `target` is `getMessageTarget`: the transform is checked first, and
   *   an answer that is gone or finished has no pipeline left.
   * - `descriptor` is `receiveCap` for `receiverAnswer`: the transform is
   *   only read when the answer still has a pipeline.
   * - `legacy` serves `Provide` and `Join`, which keep the pre-parity
   *   behavior.
   */
  private pipelinedCap(
    promised: Ptr,
    mode: "target" | "descriptor" | "legacy" = "legacy",
  ): ClientHook | undefined {
    if (promised.kind !== PtrKind.Struct) return undefined;
    const answer = this.answers.get(PromisedAnswer_getQuestionId(promised));
    if (mode !== "target" && (answer === undefined || (mode === "descriptor" && answer.finished))) {
      return undefined;
    }
    const ops: number[] = [];
    const transform = PromisedAnswer_getTransform(promised);
    for (let i = 0; i < transform.listLen(); i++) {
      const op = transform.listGetP(i);
      const opWhich = PromisedAnswer_Op_which(op);
      // noop is a real op and does not move. Anything else is the
      // unsupported-pipeline-op protocol error, which disconnects.
      if (opWhich === PromisedAnswer_Op.noop) continue;
      if (opWhich !== PromisedAnswer_Op.getPointerField) {
        this.abort(new RpcError("Unsupported pipeline op."));
        return undefined;
      }
      ops.push(PromisedAnswer_Op_getGetPointerField(op));
    }
    if (answer === undefined || (mode === "target" && answer.finished)) return undefined;
    if (answer.singleCap && transform.listLen() > 0) {
      return new BrokenClient(new RpcError("Invalid pipeline transform."));
    }
    return answer.call.pipeline.getPipelinedCap(ops);
  }

  // --- resolution and embargo -----------------------------------------

  private handleResolve(resolve: Ptr): void {
    const id = Resolve_getPromiseId(resolve);
    const imp = this.imports.get(id);
    // C++ disconnects when Resolve names an import that was never a
    // promise. A second Resolve of a real promise does not: the fulfiller
    // is still in the table and a second fulfill is ignored.
    if (
      imp !== undefined &&
      imp.resolver === undefined &&
      !imp.wasPromise &&
      imp.importClient !== undefined
    ) {
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
        if (this.twoParty) break;
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
        const hook = this.targetHook(Disembargo_getTarget(disembargo), true);
        if (hook === undefined) return;
        const finishLoopback = (resolved: ClientHook): void => {
          if (this.gone !== undefined) {
            resolved.release();
            return;
          }
          const inner = innermost(resolved);
          if (inner.brand !== this) {
            resolved.release();
            // capnp-C++ prints the two pointer addresses; 0 and 1 stand in for them.
            this.abort(
              new RpcError(
                "expected target->getBrand() == this [0 == 1]; " +
                  "'Disembargo' of type 'senderLoopback' sent to an object that does not point back to the sender.",
              ),
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
        // As capnp-C++ does: wait for the target to settle (for example
        // behind an embargo on a middle hop), then let calls already queued
        // towards it go first, then echo.
        void (async () => {
          let h = hook;
          try {
            for (;;) {
              const more = innermost(h).whenMoreResolved();
              if (more === undefined) break;
              const next = (await more).addRef();
              h.release();
              h = next;
            }
            await new Promise<void>((res) => afterQueuedWork(res));
          } catch (e) {
            h.release();
            // capnp-C++ fails the connection with the target's own error.
            this.abort(toRpcError(e));
            return;
          }
          finishLoopback(h);
        })();
        return;
      }
      default:
        break;
    }
    this.abort(
      new RpcError(`Unimplemented Disembargo type.; disembargo = ${disembargoText(disembargo)}`),
    );
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
    if (this.traceEncoder !== undefined) exc.setText(1, this.traceEncoder(e));
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
    const incoming = CapnpMessage.fromFlat(frame, RPC_FRAME).root();
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
    if (echoed.kind !== PtrKind.Struct) {
      this.abort(new RpcError("Peer did not implement required RPC message type."));
      return;
    }
    const unimplemented = new RpcError("peer does not implement this message", "unimplemented");
    switch (Message_which(echoed)) {
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
        this.abort(new RpcError("Peer did not implement required RPC message type."));
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
    this.gone =
      error.type === "disconnected"
        ? error
        : new RpcError(error.message, "disconnected", error.remoteTrace);
    const reason = this.gone;

    // A Return can set `returned` and then abort before the promise is
    // settled (a tail call answered with `results`, for example). C++
    // rejects every question that still has a fulfiller, and the protocol
    // says every outstanding question fails on disconnect.
    for (const q of this.questions.values()) {
      q.redirectedCall?.release();
      q.redirectedCall = undefined;
      if (q.call.result.state === "pending") this.failQuestion(q, reason);
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
    // Drop the connection's own bootstrap ref. C++ releases the
    // bootstrap capability with the vat that held it.
    this.bootstrapHook?.release();
    this.exportIdByHook.clear();
    for (const hook of this.introductionHooks.values()) hook.release();
    this.introductionHooks.clear();
    for (const held of this.heldAccepts.values()) held.hook.release();
    this.heldAccepts.clear();
    for (const [nonce, provision] of this.vat.provisions) {
      if (provision.owner !== this) continue;
      provision.hook.release();
      this.vat.provisions.delete(nonce);
    }
    for (const join of this.joins.values()) {
      for (const part of join.parts) part?.hook?.release();
    }
    this.joins.clear();
    this.transport.close();
  }
}
