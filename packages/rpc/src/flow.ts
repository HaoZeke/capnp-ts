/**
 * Flow control for `-> stream` calls, after capnp-C++'s
 * `RpcFlowController`.
 *
 * Streaming methods return nothing useful; what matters is that a sender
 * cannot run arbitrarily far ahead of the receiver. Every message is sent
 * at once, because ordering depends on it, and its size counts as in
 * flight until its Return comes back. `send` resolves when the bytes in
 * flight are within the window, so a sender that awaits it paces itself to
 * the receiver without ever waiting a round trip it did not need to.
 *
 * Errors follow the C++ rule. Once any call fails, the controller keeps
 * that error and later sends reject with it. `waitAllAcked` still resolves
 * once every ack has settled: capnp-C++ returns `tasks.onEmpty()`, which
 * does not reject with the stream error.
 */
import type { RpcError } from "./capability.ts";

/** Whatever tells the controller a message came back: a `Settle` fits. */
export interface Ack {
  onSettled(fn: (s: { state: "pending" | "ok" | "err"; error: RpcError }) => void): void;
}

/** Bytes in flight before a sender is asked to wait, as capnp-C++'s two-party default. */
export const DEFAULT_STREAM_WINDOW = 65536;
export const MAX_ADAPTIVE_STREAM_WINDOW = 4 * 1024 * 1024;

/** Dynamic stream window provider, mirroring capnp-C++'s `RpcFlowController::WindowGetter`. */
export interface WindowGetter {
  getWindow(): number;
  onAck?(bytes: number, rttMs: number, saturated: boolean): void;
}

export interface AdaptiveWindowOptions {
  initialWindow?: number;
  minWindow?: number;
  maxWindow?: number;
  /** Minimum baseline RTT in ms so sub-millisecond scheduling jitter does not trigger backoff. */
  minRttFloorMs?: number;
  now?: () => number;
}

/**
 * Adaptive stream window that grows when the window saturates with low
 * queueing delay and backs off when RTT rises well above the baseline.
 */
export class AdaptiveStreamWindow implements WindowGetter {
  private windowSize: number;
  private readonly minWindow: number;
  private readonly maxWindow: number;
  private readonly minRttFloorMs: number;
  private minRttMs = Infinity;
  readonly now: () => number;

  constructor(options: AdaptiveWindowOptions = {}) {
    this.minWindow = options.minWindow ?? DEFAULT_STREAM_WINDOW;
    this.maxWindow = Math.max(this.minWindow, options.maxWindow ?? MAX_ADAPTIVE_STREAM_WINDOW);
    this.windowSize = Math.min(
      this.maxWindow,
      Math.max(this.minWindow, options.initialWindow ?? this.minWindow),
    );
    this.minRttFloorMs = options.minRttFloorMs ?? 2;
    this.now = options.now ?? (() => performance.now());
  }

  getWindow(): number {
    return this.windowSize;
  }

  onAck(bytes: number, rttMs: number, saturated: boolean): void {
    const sample = Math.max(0, rttMs);
    if (sample < this.minRttMs) this.minRttMs = sample;
    const baseline = Math.max(this.minRttFloorMs, this.minRttMs);
    if (sample > baseline * 2.5) {
      this.windowSize = Math.max(this.minWindow, Math.floor(this.windowSize * 0.75));
    } else if (saturated && sample <= baseline * 1.5) {
      const step = Math.max(bytes, Math.floor(this.windowSize / 8));
      this.windowSize = Math.min(this.maxWindow, this.windowSize + step);
    }
  }
}

interface Waiter {
  resolve(): void;
  reject(e: RpcError): void;
}

export class WindowFlowController {
  private inFlightBytes = 0;
  private maxMessageSize = 0;
  private failure: RpcError | undefined;
  private blocked: Waiter[] = [];
  private emptied: Waiter[] = [];
  private readonly getter: WindowGetter;
  private readonly now: () => number;
  /** Highest value `inFlight` has reached; for tests and tuning. */
  peakInFlight = 0;
  /** How many sends had to wait. */
  waits = 0;

  constructor(window: (() => number) | WindowGetter = () => DEFAULT_STREAM_WINDOW) {
    if (typeof window === "function") {
      this.getter = { getWindow: window };
      this.now = () => performance.now();
    } else {
      this.getter = window;
      this.now = window instanceof AdaptiveStreamWindow ? window.now : () => performance.now();
    }
  }

  get currentWindow(): number {
    return this.getter.getWindow();
  }

  get inFlight(): number {
    return this.inFlightBytes;
  }

  get failed(): boolean {
    return this.failure !== undefined;
  }

  get failureError(): RpcError | undefined {
    return this.failure;
  }

  /**
   * Account for a message that has just been sent. `ack` settles when its
   * Return arrives.
   */
  send(size: number, ack: Ack): Promise<void> {
    this.maxMessageSize = Math.max(this.maxMessageSize, size);
    this.inFlightBytes += size;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlightBytes);
    const sentAt = this.getter.onAck !== undefined ? this.now() : 0;

    let saturated = false;
    ack.onSettled((s) => {
      this.inFlightBytes -= size;
      if (s.state === "err") {
        this.failure ??= s.error;
        const waiting = this.blocked.splice(0);
        for (const w of waiting) w.reject(this.failure);
        // Outstanding waitAllAcked calls resolve when the in-flight bytes
        // drain. C++ does not reject them with the stream error.
        if (this.inFlightBytes === 0) for (const w of this.emptied.splice(0)) w.resolve();
        return;
      }
      this.getter.onAck?.(size, this.now() - sentAt, saturated || this.blocked.length > 0);
      if (this.failure === undefined && this.ready()) {
        for (const w of this.blocked.splice(0)) w.resolve();
      }
      if (this.inFlightBytes === 0) for (const w of this.emptied.splice(0)) w.resolve();
    });

    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ready()) return Promise.resolve();
    saturated = true;
    this.waits++;
    return new Promise<void>((resolve, reject) => this.blocked.push({ resolve, reject }));
  }

  /**
   * Resolves when everything sent has been acknowledged. A previous
   * failure does not reject this promise; later `send` calls do.
   */
  waitAllAcked(): Promise<void> {
    if (this.inFlightBytes === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => this.emptied.push({ resolve, reject }));
  }

  /**
   * The window is extended by the largest message seen. Otherwise one
   * message bigger than the window would stall every later send for a
   * round trip's worth of time. Skip querying `getWindow()` when inFlight
   * is within `maxMessageSize`, as capnp-C++ does.
   */
  private ready(): boolean {
    return (
      this.inFlightBytes <= this.maxMessageSize ||
      this.inFlightBytes < this.maxMessageSize + this.getter.getWindow()
    );
  }
}
