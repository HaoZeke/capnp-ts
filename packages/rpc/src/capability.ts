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
  Message as CapnpMessage,
  MessageBuilder,
  Orphan,
  Ptr,
  PtrKind,
  type StructBuilder,
} from "@haozeke/capnp";

export type ExceptionType = "failed" | "overloaded" | "disconnected" | "unimplemented";

/** An RPC exception, carrying the `Exception.Type` the wire distinguishes. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly type: ExceptionType = "failed",
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

/**
 * The content of a message together with the capabilities its pointers
 * name. A capability pointer holds an index; the hook it stands for is
 * `caps[index]`.
 */
export class Payload {
  constructor(
    readonly content: Ptr,
    readonly caps: ClientHook[] = [],
  ) {}

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
    let cursor = this.content;
    for (const field of ops) {
      if (cursor.kind !== PtrKind.Struct) {
        return new BrokenClient(new RpcError("pipeline path walks into a non-struct"));
      }
      cursor = cursor.getP(field);
    }
    return this.getCap(cursor);
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

  constructor(dwords = 1, pwords = 1) {
    this.root = this.message.initRoot(dwords, pwords);
  }

  /** Put `hook` in the cap table, taking over the caller's reference. */
  addCap(hook: ClientHook): Orphan {
    this.caps.push(hook);
    return Orphan.cap(this.message, this.caps.length - 1);
  }

  /** Point `struct`'s pointer field at `hook`, taking over the reference. */
  setCap(struct: StructBuilder, ptrIndex: number, hook: ClientHook): void {
    struct.adopt(ptrIndex, this.addCap(hook));
  }

  /** The readable view; the builder gives up its capabilities to it. */
  toPayload(): Payload {
    const root = CapnpMessage.fromFlat(this.message.toFlat()).root();
    return new Payload(root, this.caps.splice(0));
  }
}

/** Where a pipelined capability comes from while the call is still out. */
export interface PipelineHook {
  /** An owned reference to the capability at `ops` in the eventual results. */
  getPipelinedCap(ops: readonly number[]): ClientHook;
}

export interface CallOptions {
  /** A `-> stream` call: flow-controlled, results are empty. */
  streaming?: boolean;
}

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
  /** Resolves when every stream call made through this hook has returned. */
  flush?(): Promise<void>;
  /** Identifies which connection or wrapper made this hook. */
  readonly brand: unknown;
  /** The error a broken capability fails with. */
  readonly brokenError: RpcError | undefined;
}

/** A stream call on a hook with no flow control: resolves when the call returns. */
export function callStreaming(
  hook: ClientHook,
  interfaceId: bigint,
  methodId: number,
  params: Payload,
): Promise<void> {
  if (hook.callStreaming !== undefined) return hook.callStreaming(interfaceId, methodId, params);
  const call = hook.call(interfaceId, methodId, params, { streaming: true });
  return call.result.promise.then(
    () => call.release(),
    (e) => {
      call.release();
      throw e;
    },
  );
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

  whenMoreResolved(): undefined {
    return undefined;
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
  results = new CallBuilder();
  readonly controller = new AbortController();
  cancelRequested = false;
  cancellable = false;

  constructor(readonly params: Payload) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  allowCancellation(): void {
    this.cancellable = true;
  }

  getCap(ptr: Ptr): ClientHook {
    return this.params.getCap(ptr);
  }

  initResults(dwords: number, pwords: number): StructBuilder {
    this.results = new CallBuilder(dwords, pwords);
    return this.results.root;
  }

  setResultCap(struct: StructBuilder, ptrIndex: number, hook: ClientHook): void {
    this.results.setCap(struct, ptrIndex, hook);
  }
}

class LocalPipeline implements PipelineHook {
  constructor(private readonly result: Settle<Payload>) {}

  getPipelinedCap(ops: readonly number[]): ClientHook {
    const r = this.result;
    if (r.state === "ok") return r.value.getPipelinedCap(ops);
    if (r.state === "err") return new BrokenClient(r.error);
    const eventual = new Settle<ClientHook>();
    r.onSettled((s) => {
      eventual.resolve(s.state === "ok" ? s.value.getPipelinedCap(ops) : new BrokenClient(s.error));
    });
    return new QueuedClient(eventual);
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

  call(interfaceId: bigint, methodId: number, params: Payload, _opts?: CallOptions): CallState {
    if (this.broken !== undefined) {
      params.release();
      return failedCall(this.broken);
    }
    const ctx = new LocalCallContext(params);
    const state = new CallState();
    // A running call keeps the capability alive, so dropping the last
    // reference while a call is queued or in flight does not dispose the
    // server underneath it.
    this.addRef();
    state.result.onSettled(() => this.release());
    state.pipeline = new LocalPipeline(state.result);
    state.onRelease = () => {
      ctx.cancelRequested = true;
      if (state.result.state !== "pending" || !ctx.cancellable) return;
      ctx.controller.abort();
      state.result.reject(new RpcError("canceled"));
    };
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
    const finish = (error?: unknown): void => {
      const params = ctx.params;
      params.release();
      if (error !== undefined) {
        if (streaming) this.broken = toRpcError(error);
        state.result.reject(error);
        ctx.results.caps.forEach((c) => c.release());
      } else if (state.result.state === "pending" && !ctx.cancelRequested) {
        state.result.resolve(ctx.results.toPayload());
      } else {
        ctx.results.caps.forEach((c) => c.release());
        state.result.reject(new RpcError("canceled"));
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
      finish(e);
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
      finish();
      return;
    }
    const done = promise.then(
      () => finish(),
      (e) => {
        if (isStreaming) this.broken = toRpcError(e);
        finish(e);
      },
    );
    if (isStreaming) {
      this.blocked = done.then(() => {
        this.blocked = undefined;
      });
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

  constructor(private readonly eventual: Settle<ClientHook>) {
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
    outer.pipeline = {
      getPipelinedCap: (ops) => {
        if (inner.state === "ok") return inner.value.pipeline.getPipelinedCap(ops);
        const eventual = new Settle<ClientHook>();
        inner.onSettled((s) => {
          eventual.resolve(
            s.state === "ok"
              ? s.value.pipeline.getPipelinedCap(ops)
              : new BrokenClient(s.error),
          );
        });
        return new QueuedClient(eventual);
      },
    };
    this.eventual.onSettled(() => {
      const handle = this.redirect!.call(interfaceId, methodId, params, opts);
      inner.resolve(handle);
      handle.result.onSettled((s) => {
        if (s.state === "ok") outer.result.resolve(s.value);
        else outer.result.reject(s.error);
      });
      if (outer.released) handle.release();
      else outer.onRelease = () => handle.release();
    });
    return outer;
  }

  protected dispose(): void {
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
    return new RpcPromise(this.hook.call(interfaceId, methodId, params.toPayload(), opts));
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

  /** Resolves when every stream call has returned; rejects with the first failure. */
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
