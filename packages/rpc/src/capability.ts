/**
 * The capability layer: what a call is made on, and what comes back.
 *
 * A capability is a `ClientHook`. Wherever one lives (in this process,
 * across a connection, behind a promise, broken), a caller sees the same
 * five operations: call it, learn whether it has resolved further, wait
 * for that, take another reference, and drop one. This mirrors
 * capnp-C++'s `ClientHook`, `PipelineHook` and `Capability::Client`, so
 * the rules for resolution, pipelining and cancellation read the same in
 * both.
 *
 * Reference counts are explicit because JavaScript cannot run code when a
 * value goes unreachable. Whoever receives a hook owns one reference and
 * calls `release()`; keeping one longer takes `addRef()`.
 */
import {
  type BuilderPointer,
  Message as CapnpMessage,
  MessageBuilder,
  Orphan,
  Ptr,
  PtrKind,
  StructBuilder,
} from "@haozeke/capnp";

export type ExceptionType = "failed" | "overloaded" | "disconnected" | "unimplemented";

/** An RPC exception, carrying the `Exception.Type` the wire distinguishes. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly type: ExceptionType = "failed",
    /** `Exception.trace` from the peer, as capnp-C++ `setRemoteTrace` keeps it. */
    readonly remoteTrace?: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export function toRpcError(e: unknown): RpcError {
  if (e instanceof RpcError) return e;
  return new RpcError(e instanceof Error ? e.message : String(e));
}

/**
 * A value that settles once and tells its observers synchronously.
 *
 * Native promises always defer their callbacks, and two things here
 * cannot afford that: calls queued behind a promise must be forwarded in
 * the order they were made, and a connection must act on a Return in the
 * same `pump()` that read it. `promise` gives callers the native view.
 */
export class Settle<T> {
  state: "pending" | "ok" | "err" = "pending";
  value!: T;
  error!: RpcError;
  private observers: Array<(s: Settle<T>) => void> = [];
  private native: Promise<T> | undefined;

  resolve(value: T): void {
    if (this.state !== "pending") return;
    this.state = "ok";
    this.value = value;
    this.flush();
  }

  reject(error: unknown): void {
    if (this.state !== "pending") return;
    this.state = "err";
    this.error = toRpcError(error);
    this.flush();
  }

  /** Run `fn` now if settled, otherwise when it settles. */
  onSettled(fn: (s: Settle<T>) => void): void {
    if (this.state === "pending") this.observers.push(fn);
    else fn(this);
  }

  get promise(): Promise<T> {
    this.native ??= new Promise<T>((resolve, reject) => {
      this.onSettled((s) => (s.state === "ok" ? resolve(s.value) : reject(s.error)));
    });
    return this.native;
  }

  private flush(): void {
    const obs = this.observers;
    this.observers = [];
    for (const fn of obs) fn(this);
  }
}

let nullContent: Ptr | undefined;

/** What a null content reads as: a struct whose every field is its default. */
function defaultContent(): Ptr {
  if (nullContent === undefined) {
    const b = new MessageBuilder();
    b.initRoot(0, 0);
    nullContent = CapnpMessage.fromFlat(b.toFlat()).root();
  }
  return nullContent;
}

/**
 * The content of a message together with the capabilities its pointers
 * name. A capability pointer holds an index; the hook it stands for is
 * `caps[index]`.
 */
export class Payload {
  /** A null content reads as a struct of defaults, as capnp-C++ getters read one. */
  readonly content: Ptr;

  constructor(
    content: Ptr,
    readonly caps: ClientHook[] = [],
  ) {
    this.content = content.kind === PtrKind.Null ? defaultContent() : content;
  }

  /** The content was a null pointer, and is sent on as one. */
  get contentIsNull(): boolean {
    return this.content === nullContent;
  }

  /** The hook a capability pointer inside this payload names. */
  getCap(ptr: Ptr): ClientHook {
    if (ptr.kind !== PtrKind.Cap) return newNullCap();
    const hook = this.caps[ptr.count];
    if (hook === undefined) {
      return new BrokenClient(new RpcError("capability index is outside the cap table"));
    }
    return hook.addRef();
  }

  /**
   * The capability at the end of a chain of pointer fields, as an owned
   * reference. This is what a pipelined call addresses.
   */
  getPipelinedCap(ops: readonly number[]): ClientHook {
    let pos = this.content;
    for (const field of ops) {
      if (pos.kind !== PtrKind.Struct) {
        return new BrokenClient(new RpcError("pipeline path walks into a non-struct"));
      }
      pos = pos.getP(field);
    }
    return this.getCap(pos);
  }

  release(): void {
    for (const h of this.caps) h.release();
    this.caps.length = 0;
  }
}

/** Parameters or results under construction: a message plus its caps. */
export class CallBuilder {
  readonly message = new MessageBuilder();
  readonly root: StructBuilder;
  readonly caps: ClientHook[] = [];

  /** With `results`, a root nobody writes to becomes a null content. */
  constructor(dwords = 1, pwords = 1, results = false) {
    const root = this.message.initRoot(dwords, pwords);
    this.root = results ? new ResultsStruct(root) : root;
  }

  /**
   * Put `hook` in the cap table, taking over the caller's reference. A
   * null capability is a null pointer and takes no table entry, as in
   * capnp-C++'s `setCapabilityPointer`.
   */
  addCap(hook: ClientHook): Orphan {
    if (isNullCap(hook)) {
      hook.release();
      return Orphan.null();
    }
    this.caps.push(hook);
    return Orphan.cap(this.message, this.caps.length - 1);
  }

  /** Point `struct`'s pointer field at `hook`, taking over the reference. */
  setCap(struct: StructBuilder, ptrIndex: number, hook: ClientHook): void {
    struct.adopt(ptrIndex, this.addCap(hook));
  }

  /** The readable view; the builder gives up its capabilities to it. */
  toPayload(): Payload {
    if (this.root instanceof ResultsStruct && !this.root.written) {
      return new Payload(defaultContent(), this.caps.splice(0));
    }
    const root = CapnpMessage.fromFlat(this.message.toFlat(), {
      maxSegments: Number.MAX_SAFE_INTEGER,
    }).root();
    return new Payload(root, this.caps.splice(0));
  }
}

/**
 * The results struct a method is handed. capnp-C++ leaves a Return's
 * content null until the method calls `getResults()`; writing to this
 * struct is that call here.
 */
class ResultsStruct extends StructBuilder {
  written = false;

  constructor(root: StructBuilder) {
    super(root.builder, root.seg, root.word, root.dwords, root.pwords);
  }

  override setU8(...a: Parameters<StructBuilder["setU8"]>): void {
    this.written = true;
    super.setU8(...a);
  }

  override setU16(...a: Parameters<StructBuilder["setU16"]>): void {
    this.written = true;
    super.setU16(...a);
  }

  override setU32(...a: Parameters<StructBuilder["setU32"]>): void {
    this.written = true;
    super.setU32(...a);
  }

  override setU64(...a: Parameters<StructBuilder["setU64"]>): void {
    this.written = true;
    super.setU64(...a);
  }

  override setF32(...a: Parameters<StructBuilder["setF32"]>): void {
    this.written = true;
    super.setF32(...a);
  }

  override setF64(...a: Parameters<StructBuilder["setF64"]>): void {
    this.written = true;
    super.setF64(...a);
  }

  override setBool(...a: Parameters<StructBuilder["setBool"]>): void {
    this.written = true;
    super.setBool(...a);
  }

  /** Every pointer write goes through a slot. */
  override slot(ptrIndex: number): BuilderPointer {
    this.written = true;
    return super.slot(ptrIndex);
  }

  override asPointer(): BuilderPointer {
    this.written = true;
    return super.asPointer();
  }
}

/** Where a pipelined capability comes from while the call is still out. */
export interface PipelineHook {
  /** An owned reference to the capability at `ops` in the eventual results. */
  getPipelinedCap(ops: readonly number[]): ClientHook;
}

/** Hook supplied by an RPC connection so a forwarded call can use `sendResultsTo.yourself`. */
export interface TailHandler {
  tryTailCall(
    target: ClientHook,
    interfaceId: bigint,
    methodId: number,
    params: Payload,
  ): CallState | undefined;
}

export interface CallOptions {
  /** A `-> stream` call: flow-controlled, results are empty. */
  streaming?: boolean;
  /** Present when the caller's connection can take results directly from a forwarded call. */
  tailHandler?: TailHandler;
  /** Internal: mark an outgoing `Call` with `sendResultsTo.yourself`. */
  sendResultsToYourself?: boolean;
  /** Server-side failure handler propagated across queued and membrane wrappers. */
  onError?: (error: unknown) => void;
  /** `Call.noPromisePipelining`: the caller will not pipeline, so the pipeline is disabled. */
  noPromisePipelining?: boolean;
  /**
   * `Call.onlyPromisePipeline`, as capnp-C++ `sendForPipeline()` sends: the
   * caller only pipelines, and a remote call's results never arrive.
   */
  onlyPromisePipeline?: boolean;
}

/** What capnp-C++ `getDisabledPipeline()` returns. */
export const disabledPipeline: PipelineHook = {
  getPipelinedCap: () =>
    new BrokenClient(
      new RpcError("caller specified noPromisePipelining hint, but then tried to pipeline"),
    ),
};

/**
 * One call in flight. `result` settles with the results; `pipeline`
 * addresses capabilities inside them before they arrive; `release` says
 * the caller no longer wants the outcome, which cancels the call when
 * nothing else depends on it.
 */
export class CallState {
  readonly result = new Settle<Payload>();
  pipeline!: PipelineHook;
  released = false;
  onRelease: (() => void) | undefined;
  /**
   * A server-side failure that escaped the call, such as `dispose` throwing
   * while a result capability is dropped. The connection aborts.
   */
  onError: ((error: unknown) => void) | undefined;
  /** Bytes the call occupied on the wire, for flow control; zero when it never was sent. */
  wireSize = 0;

  release(): void {
    if (this.released) return;
    this.released = true;
    this.onRelease?.();
    this.result.onSettled((s) => {
      if (s.state === "ok") s.value.release();
    });
  }
}

export interface ClientHook {
  call(interfaceId: bigint, methodId: number, params: Payload, opts?: CallOptions): CallState;
  /** The capability this one has resolved to, if it is a resolved promise. */
  getResolved(): ClientHook | undefined;
  /** Settles with the next resolution, or undefined if this is no promise. */
  whenMoreResolved(): Promise<ClientHook> | undefined;
  addRef(): ClientHook;
  release(): void;
  /**
   * Make a `-> stream` call. Resolves when the sender may send more, and
   * rejects once any earlier stream call on this capability has failed.
   * Hooks without flow control of their own leave this to
   * `callStreaming()`.
   */
  callStreaming?(interfaceId: bigint, methodId: number, params: Payload): Promise<void>;
  /** Resolves when every stream call made through this hook has been acknowledged. */
  flush?(): Promise<void>;
  /** Identifies which connection or wrapper made this hook. */
  readonly brand: unknown;
  /** The error a broken capability fails with. */
  readonly brokenError: RpcError | undefined;
}

/** A stream promise that can be canceled, dropping the underlying call. */
export type StreamingPromise = Promise<void> & { cancel(): void };

/** A stream call on a hook with no flow control: resolves when the call returns. */
export function callStreaming(
  hook: ClientHook,
  interfaceId: bigint,
  methodId: number,
  params: Payload,
): StreamingPromise {
  if (hook.callStreaming !== undefined) {
    const promise = hook.callStreaming(interfaceId, methodId, params) as StreamingPromise;
    promise.cancel ??= () => {};
    return promise;
  }
  const call = hook.call(interfaceId, methodId, params, { streaming: true });
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    call.release();
  };
  const promise = call.result.promise.then(
    () => release(),
    (e) => {
      release();
      throw e;
    },
  ) as StreamingPromise;
  promise.cancel = release;
  return promise;
}

export abstract class RefHook {
  protected refs = 1;

  addRef(): this {
    if (this.refs <= 0) throw new RpcError("capability used after release");
    this.refs++;
    return this;
  }

  release(): void {
    if (this.refs <= 0) return;
    if (--this.refs === 0) this.dispose();
  }

  protected abstract dispose(): void;
}

export function failedCall(error: RpcError): CallState {
  const state = new CallState();
  state.result.reject(error);
  state.pipeline = { getPipelinedCap: () => new BrokenClient(error) };
  return state;
}

/** A capability that fails every call with one error. */
export class BrokenClient extends RefHook implements ClientHook {
  readonly brand = BrokenClient;
  constructor(
    readonly error: RpcError,
    /** True for the capability a null pointer names, which membranes leave alone. */
    readonly isNull = false,
  ) {
    super();
  }

  get brokenError(): RpcError {
    return this.error;
  }

  call(_i: bigint, _m: number, params: Payload): CallState {
    params.release();
    return failedCall(this.error);
  }

  getResolved(): undefined {
    return undefined;
  }

  /**
   * A null capability is resolved. Any other broken capability is a
   * promise that has already failed, as in capnp-C++, so waiting on it
   * rejects and exporting it sends `Resolve.exception`.
   */
  whenMoreResolved(): Promise<ClientHook> | undefined {
    if (this.isNull) return undefined;
    const failed = Promise.reject(this.error);
    failed.catch(() => {});
    return failed;
  }

  protected dispose(): void {}
}

export function newBrokenCap(error: unknown): ClientHook {
  return new BrokenClient(toRpcError(error));
}

/** The capability a null pointer stands for: every call fails. */
export function newNullCap(): ClientHook {
  return new BrokenClient(new RpcError("called null capability"), true);
}

export function isNullCap(hook: ClientHook): boolean {
  return hook instanceof BrokenClient && hook.isNull;
}

/** What a server's `dispatch` may return besides nothing. */
export interface DispatchResult {
  promise?: Promise<void>;
  /** The method is `-> stream`: later calls wait for it, and failure breaks the capability. */
  streaming?: boolean;
  allowCancellation?: boolean;
}

/** Per-call handle a server can use, beyond the bare parameters. */
export interface CallContext {
  /** Aborts when the caller cancels, if the server allowed cancellation. */
  readonly signal: AbortSignal;
  /** Opt in to cancellation: without it a canceled call still runs to completion. */
  allowCancellation(): void;
  readonly params: Payload;
  /** The hook a capability pointer in the parameters names (a new reference). */
  getCap(ptr: Ptr): ClientHook;
  /** Replace the result struct with one of the given size. Call before adding caps. */
  initResults(dwords: number, pwords: number): StructBuilder;
  /** Point a result pointer field at `hook`, taking over the reference. */
  setResultCap(struct: StructBuilder, ptrIndex: number, hook: ClientHook): void;
  /**
   * Forward this call to `target` as a tail call. When `target` lives across
   * the same RPC connection the call arrived on, the connection sends
   * `sendResultsTo.yourself` and answers the caller with `takeFromOtherQuestion`.
   */
  tailCall(
    target: Client,
    interfaceId: bigint,
    methodId: number,
    fill?: (params: StructBuilder, caps: CallBuilder) => void,
    paramsDwords?: number,
    paramsPwords?: number,
  ): Promise<void>;
}

export interface RpcServer {
  /**
   * Handle one call. Write the reply into `results` and return; throw to
   * answer with an exception. Return a promise to answer later.
   */
  dispatch(
    interfaceId: bigint,
    methodId: number,
    params: Ptr,
    results: StructBuilder,
    ctx: CallContext,
  ): void | Promise<void> | DispatchResult;
  /** True for `-> stream` methods. */
  isStreaming?(interfaceId: bigint, methodId: number): boolean;
  /** Called when the last reference to this capability is dropped. */
  dispose?(): void;
}

class LocalCallContext implements CallContext {
  results = new CallBuilder(1, 1, true);
  readonly controller = new AbortController();
  cancelRequested = false;
  cancellable = false;
  tailCalled = false;
  /** `initResults()` or `setResultCap()` ran, so the results are this call's own. */
  resultsInitialized = false;
  tailState: CallState | undefined;
  /** Abort a cancel that arrived before `allowCancellation()`. */
  applyPendingCancel: (() => void) | undefined;

  constructor(
    readonly params: Payload,
    private readonly onTailCall: (
      target: ClientHook,
      interfaceId: bigint,
      methodId: number,
      params: Payload,
    ) => CallState,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  allowCancellation(): void {
    if (this.cancellable) return;
    this.cancellable = true;
    // C++ kept the Finish until allowCancellation(), then canceled the call.
    if (this.cancelRequested) this.applyPendingCancel?.();
  }

  getCap(ptr: Ptr): ClientHook {
    return this.params.getCap(ptr);
  }

  initResults(dwords: number, pwords: number): StructBuilder {
    this.resultsInitialized = true;
    this.results = new CallBuilder(dwords, pwords);
    return this.results.root;
  }

  setResultCap(struct: StructBuilder, ptrIndex: number, hook: ClientHook): void {
    this.resultsInitialized = true;
    this.results.setCap(struct, ptrIndex, hook);
  }

  tailCall(
    target: Client,
    interfaceId: bigint,
    methodId: number,
    fill?: (params: StructBuilder, caps: CallBuilder) => void,
    paramsDwords = 1,
    paramsPwords = 1,
  ): Promise<void> {
    if (this.tailCalled) {
      return Promise.reject(new RpcError("tailCall() may only be called once per call"));
    }
    if (this.resultsInitialized) {
      throw new RpcError("Can't call tailCall() after initializing the results struct.");
    }
    this.tailCalled = true;
    const params = new CallBuilder(paramsDwords, paramsPwords);
    fill?.(params.root, params);
    const tail = this.onTailCall(target.hook, interfaceId, methodId, params.toPayload());
    this.tailState = tail;
    return tail.result.promise.then(() => {});
  }
}

class LocalPipeline implements PipelineHook {
  private delegate: PipelineHook | undefined;
  private readonly pending: Array<{
    ops: readonly number[];
    eventual: Settle<ClientHook>;
    drop: () => void;
  }> = [];

  constructor(
    private readonly result: Settle<Payload>,
    private readonly retain: () => void,
    private readonly releaseRef: () => void,
  ) {}

  setDelegate(pipeline: PipelineHook): void {
    if (this.delegate !== undefined) return;
    this.delegate = pipeline;
    for (const p of this.pending.splice(0)) {
      p.eventual.resolve(pipeline.getPipelinedCap(p.ops));
      p.drop();
    }
  }

  getPipelinedCap(ops: readonly number[]): ClientHook {
    if (this.delegate !== undefined) return this.delegate.getPipelinedCap(ops);
    const r = this.result;
    if (r.state === "ok") return r.value.getPipelinedCap(ops);
    if (r.state === "err") return new BrokenClient(r.error);
    this.retain();
    let held = true;
    const drop = (): void => {
      if (!held) return;
      held = false;
      this.releaseRef();
    };
    const eventual = new Settle<ClientHook>();
    const entry = { ops, eventual, drop };
    this.pending.push(entry);
    r.onSettled((s) => {
      const idx = this.pending.indexOf(entry);
      if (idx !== -1) this.pending.splice(idx, 1);
      if (eventual.state === "pending") {
        eventual.resolve(s.state === "ok" ? s.value.getPipelinedCap(ops) : new BrokenClient(s.error));
      }
      drop();
    });
    return new QueuedClient(eventual, drop);
  }
}

/** A capability implemented in this process by an `RpcServer`. */
export class LocalClient extends RefHook implements ClientHook {
  readonly brand = LocalClient;
  private blocked: Promise<void> | undefined;
  private broken: RpcError | undefined;

  constructor(readonly server: RpcServer) {
    super();
  }

  get brokenError(): RpcError | undefined {
    return this.broken;
  }

  getResolved(): undefined {
    return undefined;
  }

  whenMoreResolved(): undefined {
    return undefined;
  }

  call(interfaceId: bigint, methodId: number, params: Payload, opts?: CallOptions): CallState {
    if (this.broken !== undefined) {
      params.release();
      return failedCall(this.broken);
    }
    const state = new CallState();
    state.onError = opts?.onError;
    let liveRefs = 1;
    let pipeline!: LocalPipeline;
    const ctx = new LocalCallContext(params, (target, iface, method, tailParams) => {
      const tailOpts =
        opts?.tailHandler !== undefined || opts?.onError !== undefined
          ? { tailHandler: opts.tailHandler, onError: opts.onError }
          : undefined;
      const tail = target.call(iface, method, tailParams, tailOpts);
      pipeline.setDelegate(tail.pipeline);
      tail.result.onSettled((s) => {
        if (state.result.state !== "pending") return;
        if (s.state === "ok") {
          state.result.resolve(
            new Payload(
              s.value.content,
              s.value.caps.map((c) => c.addRef()),
            ),
          );
        } else {
          state.result.reject(s.error);
        }
      });
      if (ctx.cancelRequested && ctx.cancellable) tail.release();
      return tail;
    });
    // A running call keeps the capability alive, so dropping the last
    // reference while a call is queued or in flight does not dispose the
    // server underneath it.
    this.addRef();
    state.result.onSettled(() => this.release());
    const applyPendingCancel = (): void => {
      if (state.result.state !== "pending") return;
      ctx.controller.abort();
      state.result.reject(new RpcError("canceled"));
    };
    ctx.applyPendingCancel = applyPendingCancel;
    const dropInterest = (): void => {
      if (--liveRefs > 0) return;
      ctx.cancelRequested = true;
      if (ctx.tailState !== undefined) ctx.tailState.release();
      if (!ctx.cancellable) return;
      applyPendingCancel();
    };
    pipeline = new LocalPipeline(
      state.result,
      () => {
        liveRefs++;
      },
      dropInterest,
    );
    state.pipeline = pipeline;
    state.onRelease = dropInterest;
    this.when(() => this.run(interfaceId, methodId, ctx, state));
    return state;
  }

  /** Run `start` now, or once a streaming call ahead of it has finished. */
  private when(start: () => void): void {
    if (this.blocked === undefined) start();
    else void this.blocked.then(() => this.when(start));
  }

  private run(interfaceId: bigint, methodId: number, ctx: LocalCallContext, state: CallState): void {
    if (this.broken !== undefined) {
      ctx.params.release();
      state.result.reject(this.broken);
      return;
    }
    const streaming = this.server.isStreaming?.(interfaceId, methodId) ?? false;
    const releaseResultCaps = (): void => {
      const caps = ctx.results.caps.splice(0);
      let first: unknown;
      let failed = false;
      for (const c of caps) {
        try {
          c.release();
        } catch (e) {
          if (!failed) {
            failed = true;
            first = e;
          }
        }
      }
      if (failed) throw first;
    };
    const finish = (error?: unknown): void => {
      const params = ctx.params;
      params.release();
      if (ctx.tailCalled) {
        // Results (and any error) are already wired from `ctx.tailState`.
        releaseResultCaps();
        if (error !== undefined) {
          if (streaming) this.broken = toRpcError(error);
          if (state.result.state === "pending") state.result.reject(error);
        }
        return;
      }
      if (error !== undefined) {
        if (streaming) this.broken = toRpcError(error);
        state.result.reject(error);
        releaseResultCaps();
      } else if (state.result.state === "pending" && !ctx.cancelRequested) {
        state.result.resolve(ctx.results.toPayload());
      } else {
        releaseResultCaps();
        state.result.reject(new RpcError("canceled"));
      }
    };
    const guard = (body: () => void): void => {
      try {
        body();
      } catch (e) {
        if (state.onError === undefined) throw e;
        try {
          state.onError(e);
        } catch {
          // Aborting the connection can itself drop capabilities.
        }
      }
    };

    let ret: void | Promise<void> | DispatchResult;
    try {
      ret = this.server.dispatch(
        interfaceId,
        methodId,
        ctx.params.content,
        ctx.results.root,
        ctx,
      );
    } catch (e) {
      guard(() => finish(e));
      return;
    }

    let promise: Promise<void> | undefined;
    let isStreaming = streaming;
    if (ret !== undefined && ret !== null && typeof (ret as Promise<void>).then === "function") {
      promise = ret as Promise<void>;
    } else if (ret !== undefined && ret !== null) {
      const r = ret as DispatchResult;
      promise = r.promise;
      isStreaming ||= r.streaming === true;
      if (r.allowCancellation) ctx.allowCancellation();
    }
    if (promise === undefined) {
      guard(finish);
      return;
    }
    const done = promise.then(
      () => guard(finish),
      (e) => {
        guard(() => {
          if (isStreaming) this.broken = toRpcError(e);
          finish(e);
        });
      },
    );
    if (isStreaming) {
      const unblock = (): void => {
        if (this.blocked === gate) this.blocked = undefined;
      };
      // Unblock when the call settles — including on cancellation — so a
      // canceled streaming call whose handler ignores abort cannot deadlock.
      const gate: Promise<void> = Promise.race([done, state.result.promise.then(() => {}, () => {})]).then(
        unblock,
        unblock,
      );
      this.blocked = gate;
    }
  }

  protected dispose(): void {
    this.server.dispose?.();
  }
}

/**
 * A capability that is not here yet. Calls wait for it, in order, and
 * then go to whatever it turned out to be.
 */
export class QueuedClient extends RefHook implements ClientHook {
  readonly brand = QueuedClient;
  private redirect: ClientHook | undefined;

  constructor(
    private readonly eventual: Settle<ClientHook>,
    private readonly onPendingDispose?: () => void,
  ) {
    super();
    eventual.onSettled((s) => {
      this.redirect = s.state === "ok" ? s.value : new BrokenClient(s.error);
    });
  }

  get brokenError(): RpcError | undefined {
    return this.redirect?.brokenError;
  }

  getResolved(): ClientHook | undefined {
    return this.redirect;
  }

  whenMoreResolved(): Promise<ClientHook> {
    return this.eventual.promise;
  }

  call(interfaceId: bigint, methodId: number, params: Payload, opts?: CallOptions): CallState {
    if (this.redirect !== undefined) return this.redirect.call(interfaceId, methodId, params, opts);

    const outer = new CallState();
    const inner = new Settle<CallState>();
    let canceledBeforeSend = false;
    let sent = false;
    let completionReleased = false;
    let pipelineRefs = 0;
    // Keep this QueuedClient (and any underlying pipeline ref) alive until
    // the queued call is forwarded or canceled.
    this.addRef();
    let releasedSelf = false;
    const releaseSelf = (): void => {
      if (releasedSelf) return;
      releasedSelf = true;
      this.release();
    };
    // The queued call is only dropped once neither the caller's result
    // promise nor any capability taken from its pipeline still wants it,
    // as in capnp-C++ where QueuedClient::call() forks the two apart.
    const cancelIfUnwanted = (): void => {
      if (sent || canceledBeforeSend || !completionReleased || pipelineRefs > 0) return;
      canceledBeforeSend = true;
      params.release();
      const err = new RpcError("canceled");
      inner.reject(err);
      outer.result.reject(err);
      releaseSelf();
    };
    outer.pipeline = {
      getPipelinedCap: (ops) => {
        if (inner.state === "ok") return inner.value.pipeline.getPipelinedCap(ops);
        if (inner.state === "err") return new BrokenClient(inner.error);
        const eventual = new Settle<ClientHook>();
        pipelineRefs++;
        let dropped = false;
        const dropPipelineRef = (): void => {
          if (dropped) return;
          dropped = true;
          pipelineRefs--;
          cancelIfUnwanted();
        };
        inner.onSettled((s) => {
          eventual.resolve(
            s.state === "ok"
              ? s.value.pipeline.getPipelinedCap(ops)
              : new BrokenClient(s.error),
          );
          dropPipelineRef();
        });
        return new QueuedClient(eventual, dropPipelineRef);
      },
    };
    outer.onRelease = () => {
      completionReleased = true;
      cancelIfUnwanted();
    };
    this.eventual.onSettled(() => {
      if (canceledBeforeSend) return;
      sent = true;
      const handle = this.redirect!.call(interfaceId, methodId, params, opts);
      inner.resolve(handle);
      handle.result.onSettled((s) => {
        if (s.state === "ok") outer.result.resolve(s.value);
        else outer.result.reject(s.error);
      });
      if (outer.released) handle.release();
      else outer.onRelease = () => handle.release();
      releaseSelf();
    });
    return outer;
  }

  callStreaming(interfaceId: bigint, methodId: number, params: Payload): Promise<void> {
    if (this.redirect !== undefined) {
      return callStreaming(this.redirect, interfaceId, methodId, params);
    }
    let canceled = false;
    let cancelInner: (() => void) | undefined;
    let rejectPromise: ((reason: unknown) => void) | undefined;
    this.addRef();
    let releasedSelf = false;
    const releaseSelf = (): void => {
      if (releasedSelf) return;
      releasedSelf = true;
      this.release();
    };
    const promise = new Promise<void>((resolve, reject) => {
      rejectPromise = reject;
      this.eventual.onSettled(() => {
        if (canceled) {
          releaseSelf();
          return;
        }
        const inner = callStreaming(this.redirect!, interfaceId, methodId, params);
        cancelInner = () => inner.cancel();
        inner.then(
          () => {
            releaseSelf();
            resolve();
          },
          (error) => {
            releaseSelf();
            reject(error);
          },
        );
      });
    }) as StreamingPromise;
    promise.cancel = () => {
      if (cancelInner !== undefined) {
        cancelInner();
        return;
      }
      if (canceled) return;
      canceled = true;
      params.release();
      rejectPromise?.(new RpcError("canceled"));
      releaseSelf();
    };
    return promise;
  }

  flush(): Promise<void> {
    const forward = (): Promise<void> => this.redirect?.flush?.() ?? Promise.resolve();
    if (this.redirect !== undefined) return forward();
    this.addRef();
    return new Promise((resolve) => {
      this.eventual.onSettled(() => {
        const done = forward();
        this.release();
        resolve(done);
      });
    });
  }

  protected dispose(): void {
    if (this.eventual.state === "pending") this.onPendingDispose?.();
    this.eventual.onSettled((s) => {
      if (s.state === "ok") s.value.release();
    });
  }
}

/** Handle on a capability; the type applications hold. */
export class Client {
  constructor(readonly hook: ClientHook) {}

  call(
    interfaceId: bigint,
    methodId: number,
    fill?: (params: StructBuilder, caps: CallBuilder) => void,
    paramsDwords = 1,
    paramsPwords = 1,
    opts?: CallOptions,
  ): RpcPromise {
    const params = new CallBuilder(paramsDwords, paramsPwords);
    fill?.(params.root, params);
    const state = this.hook.call(interfaceId, methodId, params.toPayload(), opts);
    if (opts?.noPromisePipelining) state.pipeline = disabledPipeline;
    return new RpcPromise(state);
  }

  /**
   * Call a `-> stream` method. The promise resolves when the next call
   * may be made without running too far ahead of the receiver, and
   * rejects once an earlier call on this capability has failed.
   */
  callStreaming(
    interfaceId: bigint,
    methodId: number,
    fill?: (params: StructBuilder, caps: CallBuilder) => void,
    paramsDwords = 1,
    paramsPwords = 1,
  ): Promise<void> {
    const params = new CallBuilder(paramsDwords, paramsPwords);
    fill?.(params.root, params);
    return callStreaming(this.hook, interfaceId, methodId, params.toPayload());
  }

  /** Resolves when every stream call has been acknowledged. A stream failure rejects the next send. */
  flush(): Promise<void> {
    let h = this.hook;
    for (let r = h.getResolved(); r !== undefined; r = h.getResolved()) h = r;
    return h.flush?.() ?? Promise.resolve();
  }

  /** A second handle on the same capability. */
  dup(): Client {
    return new Client(this.hook.addRef());
  }

  release(): void {
    this.hook.release();
  }

  [Symbol.dispose](): void {
    this.release();
  }

  /** The hook with every resolved promise looked through. */
  resolved(): ClientHook {
    let h = this.hook;
    for (let r = h.getResolved(); r !== undefined; r = h.getResolved()) h = r;
    return h;
  }

  /** Settles once this capability is no longer a pending promise. */
  async whenResolved(): Promise<void> {
    for (;;) {
      const next = this.resolved().whenMoreResolved();
      if (next === undefined) return;
      await next;
    }
  }

  get isBroken(): boolean {
    return this.resolved().brokenError !== undefined;
  }

  static broken(error: unknown): Client {
    return new Client(newBrokenCap(error));
  }

  static local(server: RpcServer): Client {
    return new Client(new LocalClient(server));
  }

  /** A capability that becomes `eventual` once it settles. */
  static fromPromise(eventual: Promise<Client>): Client {
    const settle = new Settle<ClientHook>();
    eventual.then(
      (c) => settle.resolve(c.hook),
      (e) => settle.reject(e),
    );
    return new Client(new QueuedClient(settle));
  }
}

/** A call that has been made and may not have returned. */
export class RpcPromise implements PromiseLike<Payload> {
  constructor(readonly call: CallState) {}

  get result(): Settle<Payload> {
    return this.call.result;
  }

  then<R1 = Payload, R2 = never>(
    onFulfilled?: ((value: Payload) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.call.result.promise.then(onFulfilled, onRejected);
  }

  /** The capability at `ops` in the results, usable before they arrive. */
  pipeline(...ops: number[]): Client {
    return new Client(this.call.pipeline.getPipelinedCap(ops));
  }

  /** Say the outcome is no longer wanted; cancels the call if nothing else needs it. */
  release(): void {
    this.call.release();
  }

  [Symbol.dispose](): void {
    this.release();
  }
}
