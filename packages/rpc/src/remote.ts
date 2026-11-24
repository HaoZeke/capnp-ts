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

import { WindowFlowController } from "./flow.ts";

import {
  BrokenClient,
  callStreaming,
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
  /** Current stream window in bytes for this connection. */
  readonly streamWindow: number;
  /** Create a stream flow controller backed by this connection's window policy. */
  createFlowController(): WindowFlowController;
  sendCallTo(
    write: TargetWriter,
    interfaceId: bigint,
    methodId: number,
    params: Payload,
    opts?: CallOptions,
  ): CallState;
  /** The last reference to import `importId` has gone. */
  importDropped(importId: number, client: ClientHook): void;
  /** The last reference to a PromiseClient riding on `importId` has gone. */
  promiseDropped(importId: number, client: ClientHook): void;
  /** Send a Disembargo on `target`; settles when it comes back. */
  startEmbargo(target: RpcClientHook): Settle<void>;
  /** Close an OS descriptor this host owns. The transport implements it. */
  closeFd?(fd: number): void;
}

/** A hook that knows how to name itself in a message. */
export interface RpcClientHook extends ClientHook {
  /** Fill in a `CapDescriptor` that refers back to this capability. */
  writeDescriptor(desc: StructBuilder): void;
  /** Fill in a `MessageTarget` that addresses this capability. */
  writeTarget(target: StructBuilder): void;
  /** Adopt an existing flow controller when a promise resolves onto this capability. */
  adoptFlow(flow: WindowFlowController): void;
}

/** Send one stream call through `flow`. `cancel` releases the question. */
function sendStreaming(
  host: RemoteHost,
  flow: WindowFlowController,
  write: TargetWriter,
  interfaceId: bigint,
  methodId: number,
  params: Payload,
): Promise<void> & { cancel(): void } {
  const call = host.sendCallTo(write, interfaceId, methodId, params, { streaming: true });
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    call.release();
  };
  call.result.onSettled(() => release());
  const promise = flow.send(call.wireSize, call.result) as Promise<void> & { cancel(): void };
  promise.cancel = release;
  return promise;
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
  flow: WindowFlowController;
  readonly adoptedFlows: WindowFlowController[] = [];
  /** FD received with this import. Closed on drop only when this process owns it. */
  private attachedFd: number | undefined;
  private ownsFd = false;

  constructor(
    private readonly host: RemoteHost,
    readonly importId: number,
    fd?: number,
    ownsFd = false,
  ) {
    super();
    this.flow = host.createFlowController();
    this.attachedFd = fd;
    this.ownsFd = ownsFd && fd !== undefined;
  }

  /**
   * Take ownership of `fd`. The first one is stored. Another is closed,
   * because this import already has a descriptor.
   */
  adoptFd(fd: number): void {
    if (this.attachedFd === undefined) {
      this.attachedFd = fd;
      this.ownsFd = true;
      return;
    }
    this.host.closeFd?.(fd);
  }

  getFd(): number | undefined {
    return this.attachedFd;
  }

  adoptFlow(incoming: WindowFlowController): void {
    if (this.flow.peakInFlight === 0 && !this.flow.failed) {
      this.flow = incoming;
    } else {
      this.adoptedFlows.push(incoming);
    }
  }

  callStreaming(interfaceId: bigint, methodId: number, params: Payload): Promise<void> {
    for (const f of this.adoptedFlows) {
      if (f.failureError !== undefined) {
        params.release();
        return Promise.reject(f.failureError);
      }
    }
    return sendStreaming(
      this.host,
      this.flow,
      (t) => this.writeTarget(t),
      interfaceId,
      methodId,
      params,
    );
  }

  flush(): Promise<void> {
    if (this.adoptedFlows.length === 0) return this.flow.waitAllAcked();
    return Promise.all([
      this.flow.waitAllAcked(),
      ...this.adoptedFlows.map((f) => f.waitAllAcked()),
    ]).then(() => {});
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
    if (opts?.tailHandler !== undefined && !opts.sendResultsToYourself) {
      const tail = opts.tailHandler.tryTailCall(this, interfaceId, methodId, params);
      if (tail !== undefined) return tail;
    }
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
    if (this.ownsFd && this.attachedFd !== undefined) {
      this.host.closeFd?.(this.attachedFd);
    }
    this.attachedFd = undefined;
    this.host.importDropped(this.importId, this);
  }
}

/** A capability inside an answer that has not come back yet. */
export class PipelineClient extends RefHook implements RpcClientHook {
  flow: WindowFlowController;
  readonly adoptedFlows: WindowFlowController[] = [];

  constructor(
    private readonly host: RemoteHost,
    private readonly question: QuestionRef,
    private readonly questionId: number,
    private readonly ops: readonly number[],
  ) {
    super();
    this.flow = host.createFlowController();
  }

  adoptFlow(incoming: WindowFlowController): void {
    if (this.flow.peakInFlight === 0 && !this.flow.failed) {
      this.flow = incoming;
    } else {
      this.adoptedFlows.push(incoming);
    }
  }

  callStreaming(interfaceId: bigint, methodId: number, params: Payload): Promise<void> {
    for (const f of this.adoptedFlows) {
      if (f.failureError !== undefined) {
        params.release();
        return Promise.reject(f.failureError);
      }
    }
    return sendStreaming(
      this.host,
      this.flow,
      (t) => this.writeTarget(t),
      interfaceId,
      methodId,
      params,
    );
  }

  flush(): Promise<void> {
    if (this.adoptedFlows.length === 0) return this.flow.waitAllAcked();
    return Promise.all([
      this.flow.waitAllAcked(),
      ...this.adoptedFlows.map((f) => f.waitAllAcked()),
    ]).then(() => {});
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
    if (opts?.tailHandler !== undefined && !opts.sendResultsToYourself) {
      const tail = opts.tailHandler.tryTailCall(this, interfaceId, methodId, params);
      if (tail !== undefined) return tail;
    }
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
type ResolutionType = "unresolved" | "remote" | "reflected" | "merged" | "broken";

export class PromiseClient extends RefHook implements RpcClientHook {
  private cap: RpcClientHook | ClientHook;
  private resolutionType: ResolutionType = "unresolved";
  private receivedCall = false;
  private disposed = false;
  private readonly more = new Settle<ClientHook>();
  private readonly adoptedFlows: WindowFlowController[] = [];

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

  private get resolved(): boolean {
    return this.resolutionType !== "unresolved";
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

  /**
   * Unresolved promises do not expose an FD. A resolved one uses the
   * target's FD. See `PromiseClient::getFd` in `rpc.c++`.
   */
  getFd(): number | undefined {
    if (!this.resolved) return undefined;
    return this.cap.getFd?.();
  }

  /**
   * Underlying capability for export-table resolution: strips unresolved
   * PromiseClient layers to reach their backing ImportClient/PipelineClient
   * so Disembargo bounces back on the original wire identity.
   */
  getInnermostClient(): ClientHook {
    this.receivedCall = true;
    if (this.cap instanceof PromiseClient) return this.cap.getInnermostClient();
    return this.cap;
  }

  whenMoreResolved(): Promise<ClientHook> {
    return this.more.promise;
  }

  adoptFlow(incoming: WindowFlowController): void {
    if (this.cap.brand === this.host) {
      (this.cap as RpcClientHook).adoptFlow(incoming);
    } else {
      this.adoptedFlows.push(incoming);
    }
  }

  call(interfaceId: bigint, methodId: number, params: Payload, opts?: CallOptions): CallState {
    this.receivedCall = true;
    if (!this.resolved && opts?.tailHandler !== undefined && !opts.sendResultsToYourself) {
      const tail = opts.tailHandler.tryTailCall(this, interfaceId, methodId, params);
      if (tail !== undefined) return tail;
    }
    return this.cap.call(interfaceId, methodId, params, opts);
  }

  callStreaming(interfaceId: bigint, methodId: number, params: Payload): Promise<void> {
    this.receivedCall = true;
    for (const f of this.adoptedFlows) {
      if (f.failureError !== undefined) {
        params.release();
        return Promise.reject(f.failureError);
      }
    }
    return callStreaming(this.cap, interfaceId, methodId, params);
  }

  flush(): Promise<void> {
    const inner = this.cap.flush?.() ?? Promise.resolve();
    if (this.adoptedFlows.length === 0) return inner;
    return Promise.all([inner, ...this.adoptedFlows.map((f) => f.waitAllAcked())]).then(() => {});
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
    let target = replacement;
    const isSameConnection = target.brand === this.host;

    if (isSameConnection) {
      if (target instanceof PromiseClient) {
        while (target instanceof PromiseClient && target.resolutionType === "merged") {
          const next = target.cap.addRef();
          target.release();
          target = next;
        }
        if (target instanceof PromiseClient) {
          if (target.resolved) {
            this.resolutionType = target.resolutionType;
          } else {
            target.receivedCall = target.receivedCall || this.receivedCall;
            this.resolutionType = "merged";
          }
        } else {
          this.resolutionType = "remote";
        }
      } else {
        this.resolutionType = "remote";
      }
    } else if (isError || target.brand === BrokenClient) {
      // Null and broken capabilities do not represent one of our own exports
      // and never need a Disembargo (sending one would abort the connection).
      this.resolutionType = "broken";
    } else {
      this.resolutionType = "reflected";
    }

    // Transfer any active flow controller from the initial RpcClient so
    // pipelined streaming calls keep their window and error state.
    if (previous instanceof ImportClient || previous instanceof PipelineClient) {
      const flows: WindowFlowController[] = [];
      if (previous.flow.peakInFlight > 0 || previous.flow.failed) flows.push(previous.flow);
      flows.push(...previous.adoptedFlows);
      for (const f of flows) {
        if (target.brand === this.host) (target as RpcClientHook).adoptFlow(f);
        else this.adoptedFlows.push(f);
      }
    }

    if (
      this.resolutionType === "reflected" &&
      this.receivedCall &&
      this.host.disconnected === undefined
    ) {
      // The target is hosted here, and we have already sent calls
      // through the peer to reach it. Hold new calls until the peer
      // echoes a Disembargo sent behind them.
      const lifted = this.host.startEmbargo(previous as RpcClientHook);
      const eventual = new Settle<ClientHook>();
      lifted.onSettled((s) => {
        if (s.state === "ok") eventual.resolve(target);
        else {
          target.release();
          eventual.reject(s.error);
        }
      });
      this.cap = new QueuedClient(eventual);
    } else {
      this.cap = target;
    }
    previous.release();
    this.more.resolve(this.cap);
  }

  protected dispose(): void {
    this.disposed = true;
    if (this.importId !== undefined) this.host.promiseDropped(this.importId, this);
    if (!this.resolved) {
      this.more.reject(
        this.host.disconnected ?? new RpcError("Promise client was released", "disconnected"),
      );
    }
    if (this.resolved) this.cap.release();
    else (this.cap as ClientHook).release();
  }
}
