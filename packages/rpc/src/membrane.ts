/**
 * Membranes, ported from capnp-C++'s `capnp/membrane.h`.
 *
 * A membrane wraps a capability so that every capability that crosses it,
 * in a call's parameters or in its results, is wrapped in the same
 * membrane. That is what makes revocation sound: a wrapper alone would let
 * a capability returned through it escape, and the holder could then reach
 * the target by a route the revoker cannot cut.
 *
 * A capability that crosses the membrane and comes back is unwrapped
 * rather than wrapped twice, so what Carol gets back from Bob is her own
 * object. Two membranes made with the same policy (more exactly, with
 * the same `rootPolicy()`) are the same membrane for that purpose.
 *
 * Ownership follows the rest of this package: functions that take a
 * `Client` take over the caller's reference, and ones that return one hand
 * over a new reference.
 */
import {
  BrokenClient,
  type CallOptions,
  CallState,
  callStreaming,
  Client,
  type ClientHook,
  failedCall,
  isNullCap,
  Payload,
  type PipelineHook,
  QueuedClient,
  RefHook,
  RpcError,
  Settle,
  toRpcError,
} from "./capability.ts";

/**
 * What a membrane decides, and how capabilities that cross it are made.
 * Subclass it and implement the two call hooks; the rest has working
 * defaults.
 */
export abstract class MembranePolicy {
  /** Wrappers this root policy has made, keyed by the capability inside. */
  readonly wrappers = new Map<ClientHook, MembraneHook>();
  readonly reverseWrappers = new Map<ClientHook, MembraneHook>();

  /**
   * A call from outside the membrane to an object inside. Return nothing to
   * let it proceed, with every capability in it wrapped; return a
   * capability to redirect the call there instead (which is treated as
   * outside, so nothing is wrapped for it); or throw to fail the call.
   * `target` is the object inside, lent for the duration of the call; `dup()` it to keep it.
   */
  abstract inboundCall(interfaceId: bigint, methodId: number, target: Client): Client | undefined;

  /**
   * Like `inboundCall`, for a call from inside to an object outside. It
   * should return nothing in exactly the cases `inboundCall` does, or
   * calls on a promise that later resolves across the membrane will be
   * treated differently from calls on its resolution.
   */
  abstract outboundCall(interfaceId: bigint, methodId: number, target: Client): Client | undefined;

  /**
   * A promise that rejects when the membrane is revoked. On revocation
   * every capability across the membrane is dropped, calls in flight are
   * canceled with the rejection, and later calls fail with it.
   */
  onRevoked(): Promise<unknown> | undefined {
    return undefined;
  }

  /**
   * When a call would be redirected but its target is still a promise,
   * wait for the promise to resolve further and try again. Needed by
   * policies that must not intercept calls the promise will turn out to
   * reflect back out of the membrane.
   */
  shouldResolveBeforeRedirecting(): boolean {
    return false;
  }

  /**
   * An outside capability is crossing in. The default wraps it so its
   * calls go through `outboundCall`.
   */
  importExternal(external: Client): Client {
    return new Client(new MembraneHook(external.hook, this, true));
  }

  /**
   * An inside capability is crossing out. The default wraps it so its
   * calls go through `inboundCall`.
   */
  exportInternal(internal: Client): Client {
    return new Client(new MembraneHook(internal.hook, this, false));
  }

  /**
   * Policies sharing a root can pass capabilities back and forth through
   * each other's membranes, unwrapping instead of double-wrapping.
   */
  rootPolicy(): MembranePolicy {
    return this;
  }

  /** An inside capability that was exported is being imported again. */
  importInternal(
    internal: Client,
    _exportPolicy: MembranePolicy,
    _importPolicy: MembranePolicy,
  ): Client {
    return internal;
  }

  /** An outside capability that was imported is being exported again. */
  exportExternal(
    external: Client,
    _importPolicy: MembranePolicy,
    _exportPolicy: MembranePolicy,
  ): Client {
    return external;
  }
}

/**
 * A policy that lets everything through until `revoke` is called.
 * Revocation is the common reason to want a membrane.
 */
export class RevocablePolicy extends MembranePolicy {
  private reject!: (e: Error) => void;
  private readonly revocation: Promise<never>;
  constructor() {
    super();
    this.revocation = new Promise<never>((_, reject) => (this.reject = reject));
    // Nobody may be listening yet; an unhandled rejection is not a fault.
    this.revocation.catch(() => {});
  }

  revoke(reason: Error | string = "revoked"): void {
    this.reject(typeof reason === "string" ? new RpcError(reason) : reason);
  }

  inboundCall(): undefined {
    return undefined;
  }

  outboundCall(): undefined {
    return undefined;
  }

  override onRevoked(): Promise<never> {
    return this.revocation;
  }
}

interface Flight {
  outer: CallState;
  inner: CallState;
}

class MembraneHook extends RefHook implements ClientHook {
  readonly brand = MembraneHook;
  private inner: ClientHook | undefined;
  private revoked: RpcError | undefined;
  private revokedHook: ClientHook | undefined;
  private resolvedWrap: ClientHook | undefined;
  private readonly flights = new Set<Flight>();

  /** Takes over the reference to `inner`. */
  constructor(
    inner: ClientHook,
    readonly policy: MembranePolicy,
    readonly reverse: boolean,
  ) {
    super();
    this.inner = inner;
    this.wrapperMap().set(inner, this);
    this.policy.onRevoked()?.then(
      () => this.revoke(new RpcError("onRevoked() resolved; it should only reject")),
      (e) => this.revoke(toRpcError(e)),
    );
  }

  private wrapperMap(): Map<ClientHook, MembraneHook> {
    const root = this.policy.rootPolicy();
    return this.reverse ? root.reverseWrappers : root.wrappers;
  }

  /** A new reference to what is inside, or a broken capability once revoked. */
  innerRef(): ClientHook {
    return this.inner === undefined ? new BrokenClient(this.revoked!) : this.inner.addRef();
  }

  private revoke(error: RpcError): void {
    if (this.revoked !== undefined || this.inner === undefined) return;
    this.revoked = error;
    for (const f of [...this.flights]) {
      f.outer.result.reject(error);
      f.inner.release();
    }
    this.flights.clear();
    this.dropInner();
  }

  private dropInner(): void {
    const inner = this.inner;
    if (inner === undefined) return;
    this.inner = undefined;
    const map = this.wrapperMap();
    if (map.get(inner) === this) map.delete(inner);
    inner.release();
  }

  get brokenError(): RpcError | undefined {
    return this.revoked ?? this.inner?.brokenError;
  }

  getResolved(): ClientHook | undefined {
    if (this.revoked !== undefined) return (this.revokedHook ??= new BrokenClient(this.revoked));
    if (this.resolvedWrap !== undefined) return this.resolvedWrap;
    const resolved = this.inner!.getResolved();
    if (resolved === undefined) return undefined;
    this.resolvedWrap = wrapCap(resolved.addRef(), this.policy, this.reverse);
    return this.resolvedWrap;
  }

  whenMoreResolved(): Promise<ClientHook> | undefined {
    if (this.revoked !== undefined) return Promise.resolve(this.getResolved()!);
    const more = this.inner!.whenMoreResolved();
    if (more === undefined) return undefined;
    return more.then((next) => {
      this.resolvedWrap ??= wrapCap(next.addRef(), this.policy, this.reverse);
      return this.resolvedWrap;
    });
  }

  /**
   * Apply the policy. Either the call is redirected, or it crosses and its
   * parameters are wrapped for the way in.
   */
  private route(
    interfaceId: bigint,
    methodId: number,
    params: Payload,
  ): { target: ClientHook; params: Payload; crossing: boolean } {
    const inner = this.inner!;
    const asClient = new Client(inner.addRef());
    let redirect: Client | undefined;
    try {
      redirect = this.reverse
        ? this.policy.outboundCall(interfaceId, methodId, asClient)
        : this.policy.inboundCall(interfaceId, methodId, asClient);
    } catch (e) {
      params.release();
      throw toRpcError(e);
    } finally {
      asClient.release();
    }
    if (redirect !== undefined) {
      const pending = inner.getResolved() === undefined && inner.whenMoreResolved() !== undefined;
      if (pending && this.policy.shouldResolveBeforeRedirecting()) {
        redirect.release();
        return { target: this.waitAndRetry(), params, crossing: false };
      }
      return { target: redirect.hook, params, crossing: false };
    }
    // Capabilities in the parameters cross the other way from the call.
    const wrapped = new Payload(
      params.content,
      params.caps.splice(0).map((c) => wrapCap(c, this.policy, !this.reverse)),
    );
    return { target: inner.addRef(), params: wrapped, crossing: true };
  }

  /** A stand-in that sends calls to what this membrane resolves to, which applies the policy again. */
  private waitAndRetry(): ClientHook {
    const next = new Settle<ClientHook>();
    this.whenMoreResolved()!.then(
      (hook) => next.resolve(hook.addRef()),
      (e) => next.reject(e),
    );
    return new QueuedClient(next);
  }

  call(interfaceId: bigint, methodId: number, params: Payload, opts?: CallOptions): CallState {
    if (this.revoked !== undefined) {
      params.release();
      return failedCall(this.revoked);
    }
    let routed;
    try {
      routed = this.route(interfaceId, methodId, params);
    } catch (e) {
      return failedCall(toRpcError(e));
    }
    if (!routed.crossing) {
      const call = routed.target.call(interfaceId, methodId, routed.params, opts);
      routed.target.release();
      return call;
    }

    const inner = routed.target.call(interfaceId, methodId, routed.params, opts);
    routed.target.release();
    const outer = new CallState();
    const flight: Flight = { outer, inner };
    this.flights.add(flight);
    outer.pipeline = new MembranePipeline(this, inner.pipeline);
    inner.result.onSettled((s) => {
      this.flights.delete(flight);
      if (s.state === "ok") {
        outer.result.resolve(
          new Payload(
            s.value.content,
            s.value.caps.map((c) => wrapCap(c.addRef(), this.policy, this.reverse)),
          ),
        );
      } else {
        outer.result.reject(s.error);
      }
    });
    outer.onRelease = () => {
      this.flights.delete(flight);
      inner.release();
    };
    return outer;
  }

  callStreaming(interfaceId: bigint, methodId: number, params: Payload): Promise<void> {
    if (this.revoked !== undefined) {
      params.release();
      return Promise.reject(this.revoked);
    }
    let routed;
    try {
      routed = this.route(interfaceId, methodId, params);
    } catch (e) {
      return Promise.reject(toRpcError(e));
    }
    const done = callStreaming(routed.target, interfaceId, methodId, routed.params);
    routed.target.release();
    return done;
  }

  flush(): Promise<void> {
    return this.inner?.flush?.() ?? Promise.resolve();
  }

  protected dispose(): void {
    this.dropInner();
    this.revokedHook?.release();
    this.resolvedWrap?.release();
  }
}

class MembranePipeline implements PipelineHook {
  constructor(
    private readonly owner: MembraneHook,
    private readonly inner: PipelineHook,
  ) {}

  getPipelinedCap(ops: readonly number[]): ClientHook {
    const cap = this.inner.getPipelinedCap(ops);
    return wrapCap(cap, this.owner.policy, this.owner.reverse);
  }
}

/**
 * Wrap `cap` for crossing the membrane in the direction `reverse` names,
 * or unwrap it if it is a wrapper from the same membrane going the
 * other way. Takes over the caller's reference.
 */
function wrapCap(cap: ClientHook, policy: MembranePolicy, reverse: boolean): ClientHook {
  if (isNullCap(cap)) return cap;
  const root = policy.rootPolicy();
  if (cap instanceof MembraneHook && cap.policy.rootPolicy() === root && cap.reverse === !reverse) {
    // Passing back through the membrane it came from.
    const inside = new Client(cap.innerRef());
    const from = cap.policy;
    cap.release();
    const unwrapped = reverse
      ? root.importInternal(inside, from, policy)
      : root.exportExternal(inside, from, policy);
    return unwrapped.hook;
  }
  const existing = (reverse ? root.reverseWrappers : root.wrappers).get(cap);
  if (existing !== undefined) {
    cap.release();
    return existing.addRef();
  }
  const client = new Client(cap);
  return (reverse ? policy.importExternal(client) : policy.exportInternal(client)).hook;
}

/**
 * Wrap `inner`, which is inside, so it can be called from outside. Takes
 * over the reference.
 */
export function membrane(inner: Client, policy: MembranePolicy): Client {
  return new Client(wrapCap(inner.hook, policy, false));
}

/**
 * Like `membrane`, but `outer` is outside and the result is for use
 * inside. The membrane code sets these up where it needs them.
 */
export function reverseMembrane(outer: Client, policy: MembranePolicy): Client {
  return new Client(wrapCap(outer.hook, policy, true));
}

/**
 * The payload as seen inside the membrane: every capability in it is
 * wrapped for crossing in. Leaves `from` as it was.
 */
export function copyIntoMembrane(from: Payload, policy: MembranePolicy): Payload {
  return new Payload(
    from.content,
    from.caps.map((c) => wrapCap(c.addRef(), policy, true)),
  );
}

/** The payload as seen outside: every capability in it is wrapped for crossing out. */
export function copyOutOfMembrane(from: Payload, policy: MembranePolicy): Payload {
  return new Payload(
    from.content,
    from.caps.map((c) => wrapCap(c.addRef(), policy, false)),
  );
}
