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
 * that error: later sends still go out but their promises reject, and
 * `waitAllAcked` rejects with it, so a caller learns of the failure at its
 * next send or at the end without checking every individual call.
 */
import type { RpcError } from "./capability.ts";

/** Whatever tells the controller a message came back: a `Settle` fits. */
export interface Ack {
  onSettled(fn: (s: { state: "pending" | "ok" | "err"; error: RpcError }) => void): void;
}

/** Bytes in flight before a sender is asked to wait, as capnp-C++'s two-party default. */
export const DEFAULT_STREAM_WINDOW = 65536;

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
  /** Highest value `inFlight` has reached; for tests and tuning. */
  peakInFlight = 0;
  /** How many sends had to wait. */
  waits = 0;

  constructor(private readonly window: () => number = () => DEFAULT_STREAM_WINDOW) {}

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

    ack.onSettled((s) => {
      this.inFlightBytes -= size;
      if (s.state === "err") {
        this.failure ??= s.error;
        const waiting = this.blocked.splice(0);
        for (const w of waiting) w.reject(this.failure);
        for (const w of this.emptied.splice(0)) w.reject(this.failure);
        return;
      }
      if (this.failure === undefined && this.ready()) {
        for (const w of this.blocked.splice(0)) w.resolve();
      }
      if (this.inFlightBytes === 0) for (const w of this.emptied.splice(0)) w.resolve();
    });

    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ready()) return Promise.resolve();
    this.waits++;
    return new Promise<void>((resolve, reject) => this.blocked.push({ resolve, reject }));
  }

  /** Resolves when everything sent has been acknowledged. */
  waitAllAcked(): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.inFlightBytes === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => this.emptied.push({ resolve, reject }));
  }

  /**
   * The window is extended by the largest message seen. Otherwise one
   * message bigger than the window would stall every later send for a
   * round trip's worth of time.
   */
  private ready(): boolean {
    return this.inFlightBytes <= this.maxMessageSize + this.window();
  }
}
