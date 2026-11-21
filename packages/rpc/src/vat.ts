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
  ElemSize,
  Message as CapnpMessage,
  MessageBuilder,
  nonStructPointerMessage,
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
  NoneEntry,
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
  Call_sendResultsTo,
  Call_sendResultsTo_which,
  CAP_DESCRIPTOR_DWORDS,
  CAP_DESCRIPTOR_PWORDS,
  CapDescriptor,
  CapDescriptor_getAttachedFd,
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
  Exception_getTrace,
  Exception_getType,
  Disembargo_context,
  Disembargo_context_getProvide,
  Disembargo_context_getSenderLoopback,
  Disembargo_context_getReceiverLoopback,
  Disembargo_context_which,
  Disembargo_getContext,
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
  Message_getAccept,
  Message_getProvide,
  Message_getResolve,
  Message_getJoin,
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

/** A frame's size as capnp-C++ `MessageReader::sizeInWords()` counts it: segments only. */
function segmentWords(frame: Uint8Array): number {
  const segments = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, true) + 1;
  return frame.length / 8 - (Math.floor(segments / 2) + 1);
}

const REMOTE_PREFIX = "remote exception: ";

/**
 * Write an exception string. Bytes above 127 and interior NULs stay raw,
 * matching the `char` values kj puts in the description.
 */
function writeWireText(struct: StructBuilder, index: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0 || c > 127) {
      const bytes = new Uint8Array(text.length);
      for (let j = 0; j < text.length; j++) bytes[j] = text.charCodeAt(j) & 0xff;
      struct.setTextBytes(index, bytes);
      return;
    }
  }
  struct.setText(index, text);
}

/** A received exception, as capnp-C++ `toException()` reads one for every message kind. */
function readException(exc: Ptr): RpcError {
  const e = structOrDefault(exc);
  // Reason is read before the trace, so a bad reason wins over a bad trace.
  // The trace is text: kind is checked before the struct body bounds.
  const reason = Exception_getReason(e);
  const tracePtr = e.getP(1, "text");
  const trace = tracePtr.kind === PtrKind.Null ? undefined : Exception_getTrace(e);
  const message = reason.startsWith(REMOTE_PREFIX) ? reason : REMOTE_PREFIX + reason;
  const wireType = Exception_getType(e);
  return new RpcError(message, exceptionTypeFromWire(wireType), trace, wireType);
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

/**
 * True when `p` or a pointer it reaches is a capability.
 * The walk matches `WireHelpers::totalSize`: a capability is only counted,
 * and a later structural error still throws. `setUnimplemented` calls
 * `totalSize` before the copy, so that error is the one the peer reports.
 */
function messageHasCapability(p: Ptr): boolean {
  if (p.kind === PtrKind.Cap) return true;
  if (p.kind === PtrKind.Null) return false;
  if (p.kind === PtrKind.Struct) {
    let found = false;
    for (let i = 0; i < p.pwords; i++) {
      if (messageHasCapability(p.getP(i, "copy"))) found = true;
    }
    return found;
  }
  if (p.kind === PtrKind.List) {
    let found = false;
    if (p.esize === ElemSize.Pointer) {
      for (let i = 0; i < p.listLen(); i++) {
        if (messageHasCapability(p.listGetP(i, "copy"))) found = true;
      }
    } else if (p.esize === ElemSize.Composite && p.pwords > 0) {
      for (let i = 0; i < p.listLen(); i++) {
        const el = p.listGetStruct(i);
        for (let j = 0; j < el.pwords; j++) {
          if (messageHasCapability(el.getP(j, "copy"))) found = true;
        }
      }
    }
    return found;
  }
  return false;
}

/** Wire kind of a pointer that has already been followed, for a `KJ_REQUIRE` value. */
function wireKindOf(p: Ptr): number {
  if (p.kind === PtrKind.List) return 1;
  if (p.kind === PtrKind.Cap) return 3;
  return 0;
}

/** `p`, or a struct with no fields when `p` is null: every field reads as its default. */
function structOrDefault(p: Ptr): Ptr {
  if (p.kind !== PtrKind.Null && p.kind !== PtrKind.Struct) {
    throw new RpcError(nonStructPointerMessage(wireKindOf(p)));
  }
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
  /** `onlyPromisePipeline`: no Return is coming, so Finish rejects the result. */
  pipelineOnly: boolean;
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
  /** Param capabilities, kept until `Finish` the way `RpcCallContext` keeps them. */
  paramCaps?: ClientHook[];
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
  getFd(): number | undefined {
    return this.inner.getFd?.();
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

/**
 * The call's content pointer is resolved the first time something reads it.
 * `Payload_getContent` follows the pointer, so doing it here would abort a
 * call whose method never looks at its parameters.
 */
function lazyCallPayload(params: Ptr, caps: ClientHook[]): Payload {
  const payload = emptyPayload();
  payload.caps.push(...caps);
  let resolved: Ptr | undefined;
  Object.defineProperty(payload, "content", {
    configurable: true,
    enumerable: true,
    get(): Ptr {
      if (resolved === undefined) {
        resolved = new Payload(Payload_getContent(params)).content;
      }
      return resolved;
    },
  });
  return payload;
}

function settledCall(payload: Payload): CallState {
  const call = new CallState();
  call.result.resolve(payload);
  call.pipeline = {
    getPipelinedCap: (ops) => payload.pipelinedCapAt(ops),
  };
  return call;
}

/** Locally chosen ids, as capnp-C++ `ExportTable`: the lowest freed id goes first. */
class IdAllocator {
  private next = 0;
  /** Min-heap of freed ids. */
  private readonly free: number[] = [];

  take(): number {
    const free = this.free;
    if (free.length === 0) return this.next++;
    const top = free[0]!;
    const last = free.pop()!;
    if (free.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < free.length && free[l]! < (m === i ? last : free[m]!)) m = l;
        if (r < free.length && free[r]! < (m === i ? last : free[m]!)) m = r;
        if (m === i) break;
        free[i] = free[m]!;
        i = m;
      }
      free[i] = last;
    }
    return top;
  }

  release(id: number): void {
    const free = this.free;
    let i = free.length;
    free.push(id);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (free[p]! <= id) break;
      free[i] = free[p]!;
      i = p;
    }
    free[i] = id;
  }
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
  private readonly exportIds = new IdAllocator();
  private readonly questionIds = new IdAllocator();
  private nextHighQuestionId = 0;
  /** The peer answered a pipeline-only question, so it ignores the hint. */
  private gotReturnForHighQuestionId = false;
  private readonly embargoIds = new IdAllocator();
  private gone: RpcError | undefined;
  /** FDs to send with the message currently being built. */
  private outFds: number[] = [];
  /** FDs that arrived with the frame `pumpOnce` is handling. */
  private messageFds: Array<number | undefined> = [];
  /** True when `messageFds` are OS descriptors the import must close. */
  private ownsMessageFds = false;

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
      this.transport.setPaused?.(true);
      return false;
    }
    const frame = this.transport.receive();
    const messageFds = [...(this.transport.receivedFds?.() ?? [])];
    const ownsMessageFds = this.transport.ownsReceivedFds?.() ?? false;
    this.messageFds = messageFds;
    this.ownsMessageFds = ownsMessageFds;
    try {
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
        this.abort(new RpcError(e instanceof Error ? e.message : String(e)));
      }
      return true;
    } finally {
      // Descriptors claim an index by clearing it. Anything still set was
      // never adopted, so the transport closes it when this side owns it.
      if (ownsMessageFds) {
        for (const fd of messageFds) {
          if (fd !== undefined) this.transport.closeFd?.(fd);
        }
      }
      this.messageFds = [];
    }
  }

  private dispatchFrame(frame: Uint8Array): void {
    const msg = CapnpMessage.fromFlat(frame, RPC_FRAME);
    const root = structOrDefault(msg.root("struct"));
    const which = Message_which(root);
    // Every body is the union's one pointer. A null one reads as the
    // default struct, as capnp-C++'s generated getters return.
    const body = (): Ptr => structOrDefault(root.getP(0, "struct"));

    switch (which) {
      case Message.bootstrap:
        this.handleBootstrap(body());
        break;
      case Message.call:
        this.handleCall(body(), segmentWords(frame));
        break;
      case Message.finish:
        this.handleFinish(body());
        break;
      case Message.release:
        this.handleRelease(body());
        break;
      case Message.resolve:
        this.handleResolve(body());
        break;
      case Message.join:
        if (this.twoParty) this.sendUnimplemented(frame);
        else this.handleJoin(body());
        break;
      case Message.disembargo:
        this.handleDisembargo(body());
        break;
      case Message.return:
        this.handleReturn(body(), frame);
        break;
      case Message.provide:
        if (this.twoParty) this.sendUnimplemented(frame);
        else this.handleProvide(body());
        break;
      case Message.accept:
        if (this.twoParty) this.sendUnimplemented(frame);
        else this.handleAccept(body());
        break;
      case Message.abort:
        this.abort(readException(body()));
        break;
      case Message.unimplemented:
        this.handleUnimplemented(body());
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

  /** Send `frame`, attaching any FDs `writeDescriptor` collected for it. */
  private sendFlat(frame: Uint8Array): void {
    const fds = this.outFds;
    this.outFds = [];
    if (fds.length > 0) this.transport.send(frame, fds);
    else this.transport.send(frame);
  }

  /**
   * Handle pending messages one at a time, with a microtask between them.
   * capnp-C++ `messageLoop` uses `kj::evalLater` so a ready promise's
   * continuation runs before the next frame in the same read.
   */
  pumpTurns(): void {
    const step = (): void => {
      if (!this.pumpOnce()) return;
      if (this.gone === undefined && this.transport.pending > 0) queueMicrotask(step);
    };
    step();
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
    const id = this.exportIds.take();
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
    const fd = inner.getFd?.();
    if (fd !== undefined) {
      // rpc.capnp: attachedFd is a UInt8 whose default 0xff is never a
      // real index. Linux accepts at most 253 descriptors in one send.
      // Refuse before writing the index. A later truncate would leave an
      // index that points past the list that was actually sent.
      if (this.outFds.length >= 253) {
        this.outFds = [];
        throw new RpcError("expected nfds <= 253; too many attached file descriptors");
      }
      // Schema default is 0xff, so the wire byte is the index XOR 255.
      desc.setU8(2, this.outFds.length, 255);
      this.outFds.push(fd);
    }
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
      this.sendFlat(b.toFlat());
    };
    // A released id can be reused by a new export; only the slot this
    // promise was exported in may send its Resolve.
    const owner = this.exports.get(exportId);
    eventual.then(
      (resolution) => {
        const slot = this.exports.get(exportId);
        if (slot === undefined || slot !== owner || slot.hook !== promiseHook) return;
        const target = this.innermostForExport(resolution);
        if (this.exportIdByHook.get(slot.hook) === exportId) this.exportIdByHook.delete(slot.hook);
        const old = slot.hook;
        slot.hook = target.addRef();
        old.release();
        if (target.brand !== this) {
          // A local promise not yet exported takes over this entry, and
          // no Resolve goes out until it settles. A broken capability is
          // such a promise, already rejected.
          if (!this.exportIdByHook.has(target)) {
            const more = target.whenMoreResolved();
            if (more !== undefined) {
              this.exportIdByHook.set(target, exportId);
              this.resolveExportedPromise(exportId, target, more);
              return;
            }
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
        if (slot === undefined || slot !== owner || slot.hook !== promiseHook) return;
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
      this.abort(new RpcError("Tried to release invalid export ID."));
      return;
    }
    if (count < 0 || count > slot.refcount) {
      this.abort(
        new RpcError(
          `expected refcount <= exp->refcount [${count} <= ${slot.refcount}]; Tried to drop export's refcount below zero.`,
        ),
      );
      return;
    }
    slot.refcount -= count;
    if (slot.refcount > 0) return;
    this.exports.delete(id);
    this.exportIds.release(id);
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

  private importCap(importId: number, isPromise: boolean, fd?: number): ClientHook {
    let imp = this.imports.get(importId);
    if (imp === undefined) {
      imp = { remoteRefs: 0 };
      this.imports.set(importId, imp);
    }
    imp.remoteRefs++;
    const existing = imp.importClient;
    const importClient =
      existing === undefined
        ? (imp.importClient = new ImportClient(this, importId, fd, this.ownsMessageFds))
        : existing.addRef();
    const fresh = existing === undefined;
    // The constructor already owns a first fd. A later one is adopted,
    // which keeps it when none is stored and closes it when one is.
    if (!fresh && fd !== undefined) importClient.adoptFd(fd);

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

  private dropFd(fd: number | undefined): void {
    if (fd === undefined || !this.ownsMessageFds) return;
    this.transport.closeFd?.(fd);
  }

  /** Close an OS descriptor the transport handed this connection. */
  closeFd(fd: number): void {
    this.transport.closeFd?.(fd);
  }

  /** FD named by this descriptor, taken so a second use sees none. */
  private takeAttachedFd(desc: Ptr): number | undefined {
    const index = CapDescriptor_getAttachedFd(desc);
    if (index >= this.messageFds.length) return undefined;
    const fd = this.messageFds[index];
    this.messageFds[index] = undefined;
    return fd;
  }

  /** Make a hook from one entry of a received cap table. */
  private receiveCap(desc: Ptr): ClientHook {
    if (desc.kind !== PtrKind.Struct) {
      return new NoneEntry();
    }
    const fd = this.takeAttachedFd(desc);
    switch (CapDescriptor_which(desc)) {
      case CapDescriptor.none:
        this.dropFd(fd);
        return new NoneEntry();
      case CapDescriptor.senderHosted:
        return this.importCap(CapDescriptor_getSenderHosted(desc), false, fd);
      case CapDescriptor.senderPromise:
        return this.importCap(CapDescriptor_getSenderPromise(desc), true, fd);
      case CapDescriptor.receiverHosted: {
        this.dropFd(fd);
        const slot = this.exports.get(CapDescriptor_getReceiverHosted(desc));
        if (slot === undefined) {
          return new BrokenClient(new RpcError("invalid 'receiverHosted' export ID"));
        }
        const hook = slot.hook.addRef();
        return hook.brand === this ? new TribbleRaceBlocker(hook) : hook;
      }
      case CapDescriptor.receiverAnswer: {
        this.dropFd(fd);
        const hook = this.pipelinedCap(CapDescriptor_getReceiverAnswer(desc), "descriptor");
        if (hook === undefined) {
          return new BrokenClient(new RpcError("invalid 'receiverAnswer'"));
        }
        return hook.brand === this ? new TribbleRaceBlocker(hook) : hook;
      }
      case CapDescriptor.thirdPartyHosted: {
        const tp = CapDescriptor_getThirdPartyHosted(desc);
        // The vine is an ordinary import through the introducer, which is
        // the fallback the spec gives a receiver that cannot reach the
        // third party. A host that is not text is a two-party id: keep
        // the vine and skip the introduction record.
        const vine = this.importCap(ThirdPartyCapDescriptor_getVineId(tp), false, fd);
        // capnp-C++ imports the vine and does not read `id` on two-party.
        if (this.twoParty) return vine;
        const nonce = this.noteIntroduction(tp);
        if (nonce !== undefined) {
          this.introductionHooks.get(nonce)?.release();
          this.introductionHooks.set(nonce, vine.addRef());
        }
        return vine;
      }
      default:
        this.dropFd(fd);
        this.abort(new RpcError("unknown CapDescriptor type"));
        return new BrokenClient(new RpcError("unknown CapDescriptor type"));
    }
  }

  private receiveCaps(payload: Ptr): ClientHook[] {
    if (payload.kind !== PtrKind.Struct) return [];
    const table = payload.getP(1, "list");
    if (table.kind === PtrKind.Null) return [];
    const hooks: ClientHook[] = [];
    for (let i = 0; i < table.listLen(); i++) hooks.push(this.receiveCap(table.listGetP(i)));
    return hooks;
  }

  // --- client side -------------------------------------------------
  //
  // Asking questions rather than only answering them. A question is
  // outstanding from the moment it is sent until its Return arrives, so
  // the caller can pipeline against it in the meantime.

  private newQuestion(id = this.questionIds.take()): { id: number; q: QuestionState } {
    const call = new CallState();
    const q: QuestionState = {
      call,
      ref: new QuestionRef(() => this.finishQuestion(id, q)),
      paramExports: [],
      failed: false,
      returned: false,
      finished: false,
      skipFinish: false,
      isTailCall: false,
      pipelineOnly: false,
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
    if (r.state === "ok") return this.pipelineCapOrBroken(r.value, ops);
    if (r.state === "err") return new BrokenClient(r.error);
    const eventual = new Settle<ClientHook>();
    r.onSettled((s) => {
      eventual.resolve(
        s.state === "ok" ? this.pipelineCapOrBroken(s.value, ops) : new BrokenClient(s.error),
      );
    });
    return new PromiseClient(
      this,
      new PipelineClient(this, q.ref.addRef(), id, ops),
      eventual,
      undefined,
    );
  }

  /** A client's own pipeline. A bad path is a broken capability, not an abort. */
  private pipelineCapOrBroken(payload: Payload, ops: readonly number[]): ClientHook {
    try {
      return payload.pipelinedCapAt(ops);
    } catch (e) {
      return new BrokenClient(toRpcError(e));
    }
  }

  /** The last interest in a question is gone: tell the peer. */
  private finishQuestion(id: number, q: QuestionState): void {
    // A reused id may name a newer question by now.
    if (this.questions.get(id) !== q) return;
    q.finished = true;
    q.redirectedCall?.release();
    q.redirectedCall = undefined;
    if (q.pipelineOnly && q.call.result.state === "pending") {
      q.call.result.reject(new RpcError("canceled"));
    }
    if (q.returned) this.dropQuestion(id, q);
    if (this.gone !== undefined || q.skipFinish) return;
    const { b, root } = newMessage(Message.finish);
    const finish = root.initStruct(0, FINISH_DWORDS, FINISH_PWORDS);
    finish.setU32(0, id);
    // Results already received are held through imports of our own, which
    // send their own Release. Results never received are abandoned here.
    finish.setBool(OFF.finishReleaseResultCaps, !q.returned, true);
    finish.setBool(OFF.finishRequireEarly, false, true);
    this.sendFlat(b.toFlat());
  }

  /** Frees the id once, however many paths reach the end of `q`. */
  private dropQuestion(id: number, q: QuestionState): void {
    if (this.questions.get(id) !== q) return;
    this.questions.delete(id);
    if (id < 0x80000000) this.questionIds.release(id);
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
    this.sendFlat(b.toFlat());
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
      q.pipelineOnly = true;
    }
    write(call.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS));
    q.paramExports = this.writePayload(
      call.initStruct(1, PAYLOAD_DWORDS, PAYLOAD_PWORDS),
      params,
      true,
    );
    const frame = b.toFlat();
    q.call.wireSize = frame.length;
    this.sendFlat(frame);
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
    this.sendFlat(b.toFlat());
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
    this.sendFlat(b.toFlat());
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
    this.sendFlat(b.toFlat());
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
    this.sendFlat(b.toFlat());
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
    this.sendFlat(b.toFlat());
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
      this.abort(new RpcError("expected question->isAwaitingReturn; Duplicate Return."));
      return;
    }
    q.returned = true;
    q.reply = frame;
    const which = Return_which(ret);
    q.failed = which !== Return.results;

    // Released last, as the C++ `KJ_DEFER`, so a result can still name a
    // param cap as `receiverHosted`.
    const releaseIds = Return_getReleaseParamCaps(ret) ? q.paramExports : [];
    q.paramExports = [];
    if (Return_getNoFinishNeeded(ret)) q.skipFinish = true;
    try {
      this.settleReturn(answerId, q, ret, which);
    } finally {
      for (const id of releaseIds) this.releaseExport(id, 1);
    }
  }

  private settleReturn(answerId: number, q: QuestionState, ret: Ptr, which: number): void {
    // A Return for a question we already finished is not checked. Only a
    // redirect back to us still needs cancelling.
    if (q.finished) {
      if (which === Return.resultsSentElsewhere) q.failed = false;
      if (which === Return.takeFromOtherQuestion) {
        this.takeResults(q, Return_getTakeFromOtherQuestion(ret));
      }
      // The Return is still the acknowledgement a streaming flow controller
      // waits on, so a pending result settles here.
      if (q.call.result.state === "pending") q.call.result.resolve(emptyPayload());
      this.dropQuestion(answerId, q);
      return;
    }

    switch (which) {
      case Return.results: {
        if (q.isTailCall) {
          this.abort(
            new RpcError(
              "expected !question->isTailCall; Tail call `Return` must set `resultsSentElsewhere`, not `results`.",
            ),
          );
          return;
        }
        const payload = Return_getResults(ret);
        // The content pointer stays unread until something touches the results.
        q.call.result.resolve(
          payload.kind === PtrKind.Null
            ? emptyPayload()
            : lazyCallPayload(payload, this.receiveCaps(payload)),
        );
        break;
      }
      case Return.exception:
        if (q.isTailCall) {
          this.abort(
            new RpcError(
              "expected !question->isTailCall; Tail call `Return` must set `resultsSentElsewhere`, not `exception`.",
            ),
          );
          return;
        }
        q.call.result.reject(readException(Return_getException(ret)));
        break;
      case Return.canceled:
        this.abort(new RpcError("Return message falsely claims call was canceled."));
        return;
      case Return.resultsSentElsewhere:
        if (!q.isTailCall) {
          this.abort(
            new RpcError(
              "expected question->isTailCall; `Return` had `resultsSentElsewhere` but this was not a tail call.",
            ),
          );
          return;
        }
        q.failed = false;
        q.call.result.resolve(emptyPayload());
        break;
      case Return.takeFromOtherQuestion:
        this.takeResults(q, Return_getTakeFromOtherQuestion(ret));
        break;
      default:
        this.abort(new RpcError("Unknown 'Return' type."));
        return;
    }
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
    this.sendFlat(b.toFlat());
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
    // Level 3 stores the host as text. A two-party id puts something else
    // there, and reading that as text aborts the connection.
    const host = vat.getP(0);
    if (host.kind !== PtrKind.List || host.esize !== ElemSize.Byte) return undefined;
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
      this.abort(
        new RpcError(`expected !answer.active; questionId is already in use; answerId = ${questionId}`),
      );
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
      cap = this.bootstrapCap(bootstrap.getP(0, "text"));
    } catch (e) {
      cap = toRpcError(e);
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
    this.sendFlat(b.toFlat());
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
    this.transport.setPaused?.(false);
    afterQueuedWork(() => {
      if (this.gone === undefined) this.pump();
    });
  }

  /**
   * The call context is dropped before a Return. `onlyPromisePipeline`
   * sends nothing. A redirect reports `resultsSentElsewhere`. Anything
   * else is `canceled`.
   */
  private sendCanceledReturn(questionId: number, call?: Ptr): void {
    const yourself =
      call !== undefined && Call_sendResultsTo_which(call) === Call_sendResultsTo.yourself;
    // A redirect still owes `resultsSentElsewhere`. The pipeline-only hint
    // suppresses the Return only when results stay with the caller.
    if (call !== undefined && Call_getOnlyPromisePipeline(call) && !yourself) return;
    const { b, root } = newMessage(Message.return);
    const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
    ret.setU32(OFF.returnAnswerId, questionId);
    ret.setU16(OFF.returnUnion, yourself ? Return.resultsSentElsewhere : Return.canceled);
    ret.setBool(OFF.returnReleaseParamCaps, false, true);
    this.sendFlat(b.toFlat());
  }

  private releaseParamCaps(answer: AnswerState): void {
    const caps = answer.paramCaps;
    if (caps === undefined) return;
    answer.paramCaps = undefined;
    for (const c of caps) c.release();
  }

  /** A Call, checked in the order of capnp-C++ `handleCall`. */
  private handleCall(call: Ptr, words: number): void {
    const questionId = Call_getQuestionId(call);
    const target = this.targetHook(call.getP(0, "struct"), true);
    if (target === undefined) return;
    const sendTo = Call_sendResultsTo_which(call);
    if (sendTo !== Call_sendResultsTo.caller && sendTo !== Call_sendResultsTo.yourself) {
      target.release();
      this.abort(new RpcError("Unsupported `Call.sendResultsTo`."));
      return;
    }
    const params = Call_getParams(call);
    const caps = this.receiveCaps(params);
    if (this.answers.has(questionId)) {
      // capnp-C++ finds the id in use only after it built the call context,
      // and dropping that context cancels it and releases its params.
      if (this.gone === undefined) this.sendCanceledReturn(questionId, call);
      caps.forEach((c) => c.release());
      target.release();
      this.abort(new RpcError("expected !answer.active; questionId is already in use"));
      return;
    }
    // Content stays unread until the method touches its parameters. A method
    // that ignores them still succeeds, and a bad pointer becomes the call's
    // exception rather than an abort.
    const callPayload =
      params.kind === PtrKind.Null ? emptyPayload() : lazyCallPayload(params, caps);
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
    // capnp-C++ keeps the params cap table in the call context until the
    // context is destroyed, which is `Finish` (or the answer leaving with
    // `noFinishNeeded`).
    answer.paramCaps = caps.map((c) => c.addRef());
    const state = target.call(Call_getInterfaceId(call), Call_getMethodId(call), callPayload, opts);
    target.release();
    answer.call = state;
    state.onError = onError;
    this.callWordsInFlight += words;
    state.result.onSettled((s) => {
      this.callWordsInFlight -= words;
      this.returnInOrder(() => {
        this.completeAnswer(questionId, answer, s);
      });
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
      let failed: unknown;
      while (this.waitingReturns.length > 0) {
        const next = this.waitingReturns.shift()!;
        try {
          next();
        } catch (e) {
          if (failed === undefined) failed = e;
        }
      }
      if (failed !== undefined) this.abort(toRpcError(failed));
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
    this.sendFlat(b.toFlat());
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
      this.sendCanceledReturn(questionId);
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
      this.sendFlat(b.toFlat());
      if (noCaps) {
        // The call context dies with this Return, so the param table goes
        // after the Return is on the wire.
        this.releaseParamCaps(answer);
        answer.call.release();
      }
    } else {
      this.sendException(questionId, s.error);
      // An exception Return ends the call context too. Result caps would
      // have kept it until Finish.
      this.releaseParamCaps(answer);
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
      getPipelinedCap: (ops) => {
        // Read the returned path first. A non-struct or non-cap throws here,
        // before the live reference is taken.
        const returned = results.pipelinedCapAt(ops);
        return this.resolutionAtReturnTime(live.getPipelinedCap(ops), returned, atReturn);
      },
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
    this.releaseParamCaps(answer);
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
      // A pipeline-only forward never settles on its own: rejecting the
      // result runs the bookkeeping that a Return would have run.
      answer.call.release();
      if (answer.onlyPromisePipeline && answer.call.result.state === "pending") {
        answer.call.result.reject(new RpcError("canceled"));
      }
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
          this.abort(new RpcError(e instanceof Error ? e.message : String(e)));
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
    if (target.kind !== PtrKind.Null && target.kind !== PtrKind.Struct) {
      throw new RpcError(nonStructPointerMessage(wireKindOf(target)));
    }
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
        // capnp-C++ prints the target, and a union it cannot name prints as `()`.
        if (abortOnInvalid) this.abort(new RpcError("Unknown message target type.; target = ()"));
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
    // capnp-C++ reads a null `PromisedAnswer` as the default one, which
    // names question 0 with an empty transform.
    const isDefault = mode !== "legacy" && promised.kind === PtrKind.Null;
    if (!isDefault && promised.kind !== PtrKind.Struct) {
      if (mode === "target") throw new RpcError(nonStructPointerMessage(wireKindOf(promised)));
      return undefined;
    }
    const answer = this.answers.get(isDefault ? 0 : PromisedAnswer_getQuestionId(promised));
    if (mode !== "target" && (answer === undefined || (mode === "descriptor" && answer.finished))) {
      return undefined;
    }
    const ops: number[] = [];
    const transform = isDefault ? undefined : promised.getP(0, "list");
    const opCount = transform?.listLen() ?? 0;
    for (let i = 0; transform !== undefined && i < opCount; i++) {
      const op = transform.listGetP(i);
      const opWhich = PromisedAnswer_Op_which(op);
      // noop is a real op and does not move. Anything else is the
      // unsupported-pipeline-op protocol error, which disconnects.
      if (opWhich === PromisedAnswer_Op.noop) continue;
      if (opWhich !== PromisedAnswer_Op.getPointerField) {
        this.abort(new RpcError(`Unsupported pipeline op.; (uint)opReader.which() = ${opWhich}`));
        return undefined;
      }
      ops.push(PromisedAnswer_Op_getGetPointerField(op));
    }
    if (answer === undefined || (mode === "target" && answer.finished)) return undefined;
    if (answer.singleCap && opCount > 0) {
      return new BrokenClient(new RpcError("Invalid pipeline transform."));
    }
    return answer.call.pipeline.getPipelinedCap(ops);
  }

  // --- resolution and embargo -----------------------------------------

  /**
   * A Resolve, read as capnp-C++ `handleResolve` does: the replacement
   * first, so a bad descriptor aborts before the import is looked up and
   * a replacement nobody can take is released.
   */
  private handleResolve(resolve: Ptr): void {
    let hook: ClientHook | undefined;
    let error: RpcError | undefined;
    if (Resolve_which(resolve) === Resolve.cap) {
      const desc = resolve.getP(0, "struct");
      if (desc.kind !== PtrKind.Null && desc.kind !== PtrKind.Struct) {
        throw new RpcError(nonStructPointerMessage(wireKindOf(desc)));
      }
      if (desc.kind !== PtrKind.Struct || CapDescriptor_which(desc) === CapDescriptor.none) {
        this.abort(new RpcError("'Resolve' contained 'CapDescriptor.none'."));
        return;
      }
      hook = this.receiveCap(desc);
    } else if (Resolve_which(resolve) === Resolve.exception) {
      error = readException(Resolve_getException(resolve));
    } else {
      this.abort(new RpcError("Unknown 'Resolve' type."));
      return;
    }
    const imp = this.imports.get(Resolve_getPromiseId(resolve));
    // C++ disconnects when Resolve names an import that was never a
    // promise. A second Resolve of a real promise does not: the fulfiller
    // is still in the table and a second fulfill is ignored.
    if (
      imp !== undefined &&
      imp.resolver === undefined &&
      !imp.wasPromise &&
      imp.importClient !== undefined
    ) {
      hook?.release();
      this.abort(new RpcError("Got 'Resolve' for a non-promise import."));
      return;
    }
    const resolver = imp?.resolver;
    if (imp !== undefined) imp.resolver = undefined;
    if (hook === undefined) {
      if (error !== undefined) resolver?.reject(error);
    } else if (resolver === undefined) {
      // A promise nobody holds any more still sent us a reference.
      hook.release();
    } else {
      resolver.resolve(hook);
    }
  }

  startEmbargo(target: RpcClientHook): Settle<void> {
    const id = this.embargoIds.take();
    const settle = new Settle<void>();
    this.embargoes.set(id, settle);
    const { b, root } = newMessage(Message.disembargo);
    const dis = root.initStruct(0, DISEMBARGO_DWORDS, DISEMBARGO_PWORDS);
    target.writeTarget(dis.initStruct(0, MESSAGE_TARGET_DWORDS, MESSAGE_TARGET_PWORDS));
    dis.setU16(OFF.disembargoContextUnion, Disembargo_context.senderLoopback);
    dis.setU32(OFF.disembargoContextValue, id);
    this.sendFlat(b.toFlat());
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
          this.abort(new RpcError("Invalid embargo ID in 'Disembargo.context.receiverLoopback'."));
          return;
        }
        this.embargoes.delete(id);
        this.embargoIds.release(id);
        embargo.resolve();
        return;
      }
      case Disembargo_context.senderLoopback: {
        const id = Disembargo_context_getSenderLoopback(context);
        const hook = this.targetHook(disembargo.getP(0, "struct"), true);
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
          // `context` is a group, so it shares Disembargo's own data section
          // rather than living behind a pointer.
          out.setU16(OFF.disembargoContextUnion, Disembargo_context.receiverLoopback);
          out.setU32(OFF.disembargoContextValue, id);
          this.sendFlat(b.toFlat());
          resolved.release();
        };
        // As capnp-C++ does: wait for the target to settle (for example
        // behind an embargo on a middle hop), then let calls already queued
        // towards it go first, then echo. `finishLoopback` releases on
        // every path that returns. A throw from `sendFlat` leaves `h`
        // owned, so the catch releases it once.
        void (async () => {
          let h: ClientHook | undefined = hook;
          try {
            for (;;) {
              const current: ClientHook | undefined = h;
              if (current === undefined) break;
              const more: Promise<ClientHook> | undefined = innermost(current).whenMoreResolved();
              if (more === undefined) break;
              const next: ClientHook = (await more).addRef();
              current.release();
              h = next;
            }
            await new Promise<void>((res) => afterQueuedWork(res));
            if (h !== undefined) {
              finishLoopback(h);
              h = undefined;
            }
          } catch (e) {
            h?.release();
            // capnp-C++ fails the connection with the target's own error.
            this.abort(toRpcError(e));
          }
        })();
        return;
      }
      default:
        break;
    }
    const target = disembargo.getP(0, "struct");
    if (target.kind !== PtrKind.Null && target.kind !== PtrKind.Struct) {
      throw new RpcError(nonStructPointerMessage(wireKindOf(target)));
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
    exc.setU16(OFF.exceptionType, e.wireType !== undefined ? e.wireType : EXCEPTION_TYPES[e.type]);
    writeWireText(exc, 0, e.message);
    if (this.traceEncoder !== undefined) writeWireText(exc, 1, this.traceEncoder(e));
  }

  private sendException(questionId: number, error: RpcError): void {
    const { b, root } = newMessage(Message.return);
    const ret = root.initStruct(0, RETURN_DWORDS, RETURN_PWORDS);
    ret.setU32(OFF.returnAnswerId, questionId);
    ret.setU16(OFF.returnUnion, Return.exception);
    ret.setBool(OFF.returnReleaseParamCaps, false, true);
    this.writeException(ret.initStruct(0, EXCEPTION_DWORDS, EXCEPTION_PWORDS), error);
    this.sendFlat(b.toFlat());
  }

  /** Echo a message we did not understand, per the spec. */
  private sendUnimplemented(frame: Uint8Array): void {
    const incoming = CapnpMessage.fromFlat(frame, RPC_FRAME).root();
    // capnp-C++ `setUnimplemented` copies through an empty cap table, so any
    // capability pointer aborts with the copy-path sentence.
    if (messageHasCapability(incoming)) {
      this.abort(new RpcError("Message contained invalid capability pointer."));
      return;
    }
    const { b, root } = newMessage(Message.unimplemented);
    root.setP(0, incoming);
    this.sendFlat(b.toFlat());
  }

  /**
   * The peer did not understand a message of ours. A question it ignored
   * will never be answered, so it fails with `unimplemented`. A
   * capability sent in a `Resolve` it ignored will never be used, so the
   * reference it would have held is released.
   */
  private handleUnimplemented(echoed: Ptr): void {
    const notImplemented = (): void =>
      this.abort(
        new RpcError(
          `Peer did not implement required RPC message type.; (uint)message.which() = ${
            echoed.kind === PtrKind.Struct ? Message_which(echoed) : 0
          }`,
        ),
      );
    if (echoed.kind !== PtrKind.Struct) {
      notImplemented();
      return;
    }
    switch (Message_which(echoed)) {
      case Message.provide:
      case Message.accept:
      case Message.join:
        // Two-party has no level-3 or level-4 messages. An echo of one aborts.
        notImplemented();
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
        notImplemented();
        return;
    }
  }

  /**
   * Give up on the connection after an unrecoverable error: tell the
   * peer why with `Abort`, then fail everything that was waiting.
   */
  abort(error: RpcError): void {
    if (this.gone !== undefined) return;
    this.outFds = [];
    try {
      const { b, root } = newMessage(Message.abort);
      this.writeException(root.initStruct(0, EXCEPTION_DWORDS, EXCEPTION_PWORDS), error);
      this.sendFlat(b.toFlat());
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
      this.releaseParamCaps(answer);
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
