/**
 * Capabilities that live across a connection.
 *
 * An `ImportClient` names an object the peer exports. A `PipelineClient`
 * names a capability inside an answer the peer has not yet returned. A
 * `PromiseClient` stands for something the peer will resolve to later and
 * switches to the real target when it does, which is how a chain of
 * promises shortens to a direct reference.
 *
 * These take their connection through `RemoteHost`, so they carry no
 * knowledge of the wire beyond which message to ask for.
 */
import type { StructBuilder } from "@haozeke/capnp";

import {
  BrokenClient,
  type CallOptions,
  CallState,
  type ClientHook,
  type Payload,
  QueuedClient,
  RefHook,
  RpcError,
  Settle,
} from "./capability.ts";

/** Fills in a `MessageTarget`. */
export type TargetWriter = (target: StructBuilder) => void;

export interface RemoteHost {
  /** Set once the connection is gone; every remote capability then fails. */
  readonly disconnected: RpcError | undefined;
  sendCallTo(
    write: TargetWriter,
    interfaceId: bigint,
    methodId: number,
    params: Payload,
    opts?: CallOptions,
  ): CallState;
  /** The last reference to import `importId` has gone. */
  importDropped(importId: number, client: ClientHook): void;
  /** Send a Disembargo on `target`; settles when it comes back. */
  startEmbargo(target: RpcClientHook): Settle<void>;
}

/** A hook that knows how to name itself in a message. */
export interface RpcClientHook extends ClientHook {
  /** Fill in a `CapDescriptor` that refers back to this capability. */
  writeDescriptor(desc: StructBuilder): void;
  /** Fill in a `MessageTarget` that addresses this capability. */
  writeTarget(target: StructBuilder): void;
}

/** One pending question; `Finish` goes out when the last reference is dropped. */
export class QuestionRef {
  private refs = 1;
  constructor(private readonly onZero: () => void) {}

  addRef(): this {
    this.refs++;
    return this;
  }

  release(): void {
    if (this.refs <= 0) return;
    if (--this.refs === 0) this.onZero();
  }
}

const TARGET_UNION = 4;
const IMPORTED_CAP = 0;
const PROMISED_ANSWER = 1;

export function writePromisedAnswer(
  target: StructBuilder,
  questionId: number,
  ops: readonly number[],
): void {
  target.setU16(TARGET_UNION, PROMISED_ANSWER);
  writeTransform(target.initStruct(0, 1, 1), questionId, ops);
}

/** Fill a `PromisedAnswer`: its question id and the pointer-field path. */
export function writeTransform(
  promised: StructBuilder,
  questionId: number,
  ops: readonly number[],
): void {
  promised.setU32(0, questionId);
  if (ops.length === 0) return;
  let op = promised.initCompositeList(0, ops.length, 1, 0);
  ops.forEach((field, i) => {
    if (i > 0) op = op.nextElement();
    op.setU16(0, 1); // getPointerField
    op.setU16(2, field);
  });
}

const RECEIVER_HOSTED = 3;
const RECEIVER_ANSWER = 4;

export class ImportClient extends RefHook implements RpcClientHook {
  constructor(
    private readonly host: RemoteHost,
    readonly importId: number,
  ) {
    super();
  }

  get brand(): unknown {
    return this.host;
  }

  get brokenError(): RpcError | undefined {
    return this.host.disconnected;
  }

  getResolved(): undefined {
    return undefined;
  }

  whenMoreResolved(): undefined {
    return undefined;
  }

  call(interfaceId: bigint, methodId: number, params: Payload, opts?: CallOptions): CallState {
    return this.host.sendCallTo((t) => this.writeTarget(t), interfaceId, methodId, params, opts);
  }

  writeTarget(target: StructBuilder): void {
    target.setU16(TARGET_UNION, IMPORTED_CAP);
    target.setU32(0, this.importId);
  }

  writeDescriptor(desc: StructBuilder): void {
    desc.setU16(0, RECEIVER_HOSTED);
    desc.setU32(4, this.importId);
  }

  protected dispose(): void {
    this.host.importDropped(this.importId, this);
  }
}

/** A capability inside an answer that has not come back yet. */
export class PipelineClient extends RefHook implements RpcClientHook {
  constructor(
    private readonly host: RemoteHost,
    private readonly question: QuestionRef,
    private readonly questionId: number,
    private readonly ops: readonly number[],
  ) {
    super();
  }

  get brand(): unknown {
    return this.host;
  }

  get brokenError(): RpcError | undefined {
    return this.host.disconnected;
  }

  getResolved(): undefined {
    return undefined;
  }

  whenMoreResolved(): undefined {
    return undefined;
  }

  call(interfaceId: bigint, methodId: number, params: Payload, opts?: CallOptions): CallState {
    return this.host.sendCallTo((t) => this.writeTarget(t), interfaceId, methodId, params, opts);
  }

  writeTarget(target: StructBuilder): void {
    writePromisedAnswer(target, this.questionId, this.ops);
  }

  writeDescriptor(desc: StructBuilder): void {
    desc.setU16(0, RECEIVER_ANSWER);
    writeTransform(desc.initStruct(0, 1, 1), this.questionId, this.ops);
  }

  protected dispose(): void {
    this.question.release();
  }
}

/**
 * A promise the peer has made. Until it resolves, calls go to the peer
 * under the name it gave; once it does, they go to the target. If the
 * target is hosted here and calls were already in flight through the
 * peer, an embargo holds new calls back until the peer has echoed ours.
 */
export class PromiseClient extends RefHook implements RpcClientHook {
  private cap: RpcClientHook | ClientHook;
  private resolved = false;
  private receivedCall = false;
  private disposed = false;
  private readonly more = new Settle<ClientHook>();

  constructor(
    private readonly host: RemoteHost,
    initial: RpcClientHook,
    eventual: Settle<ClientHook>,
    /** The import this promise rides on, if it is one. */
    readonly importId: number | undefined,
  ) {
    super();
    this.cap = initial;
    eventual.onSettled((s) => {
      if (s.state === "ok") this.resolve(s.value, false);
      else this.resolve(new BrokenClient(s.error), true);
    });
  }

  get brand(): unknown {
    return this.host;
  }

  get brokenError(): RpcError | undefined {
    return this.resolved ? this.cap.brokenError : this.host.disconnected;
  }

  getResolved(): ClientHook | undefined {
    return this.resolved ? this.cap : undefined;
  }

  whenMoreResolved(): Promise<ClientHook> {
    return this.more.promise;
  }

  call(interfaceId: bigint, methodId: number, params: Payload, opts?: CallOptions): CallState {
    this.receivedCall = true;
    return this.cap.call(interfaceId, methodId, params, opts);
  }

  writeTarget(target: StructBuilder): void {
    this.receivedCall = true;
    (this.cap as RpcClientHook).writeTarget(target);
  }

  writeDescriptor(desc: StructBuilder): void {
    this.receivedCall = true;
    (this.cap as RpcClientHook).writeDescriptor(desc);
  }

  private resolve(replacement: ClientHook, isError: boolean): void {
    if (this.disposed || this.resolved) {
      replacement.release();
      return;
    }
    const previous = this.cap;
    const local = replacement.brand !== this.host;
    if (local && this.receivedCall && !isError && this.host.disconnected === undefined) {
      // The target is hosted here, and we have already sent calls
      // through the peer to reach it. Hold new calls until the peer
      // echoes a Disembargo sent behind them.
      const lifted = this.host.startEmbargo(previous as RpcClientHook);
      const eventual = new Settle<ClientHook>();
      lifted.onSettled(() => eventual.resolve(replacement));
      this.cap = new QueuedClient(eventual);
    } else {
      this.cap = replacement;
    }
    this.resolved = true;
    previous.release();
    this.more.resolve(this.cap);
  }

  protected dispose(): void {
    this.disposed = true;
    if (this.resolved) this.cap.release();
    else (this.cap as ClientHook).release();
  }
}
