/**
 * Client-side flow control for `-> stream` methods.
 *
 * A bounded window of unacknowledged stream calls. The wire carries
 * ordinary Call/Return pairs; the window is policy, as in capnp-C++. A
 * sender that never waited would queue without limit, so `send` blocks
 * only when the window is full, and then only long enough to retire the
 * oldest outstanding call.
 *
 * Once any stream call has failed, later sends fail immediately and the
 * failure surfaces at `finish`, which is the streaming error-propagation
 * rule: the caller is not made to check every individual call.
 */
import type { StructBuilder } from "@haozeke/capnp";

import type { RpcConnection } from "./vat.ts";

export class StreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamError";
  }
}

export class RpcStream {
  private readonly outstanding: number[] = [];
  private failed = false;
  private firstFailure: number | undefined;

  constructor(
    private readonly conn: RpcConnection,
    readonly window: number = 16,
  ) {
    if (window < 1) throw new StreamError("window must be at least 1");
  }

  /** Calls sent but not yet retired. */
  get pending(): number {
    return this.outstanding.length;
  }

  /** True once any call in this stream has failed. */
  get isFailed(): boolean {
    return this.failed;
  }

  /**
   * Send one stream call. `send` returns its questionId without waiting
   * for the answer, unless the window is full.
   */
  send(
    importedCapId: number,
    interfaceId: bigint,
    methodId: number,
    fillParams?: (params: StructBuilder) => void,
    paramsDwords = 1,
    paramsPwords = 1,
  ): number {
    if (this.failed) {
      throw new StreamError("stream already failed");
    }
    if (this.outstanding.length >= this.window) {
      this.retireOldest();
      // retireOldest may have marked the stream failed.
      if (this.failed) throw new StreamError("stream already failed");
    }
    const questionId = this.conn.sendCall(
      importedCapId,
      interfaceId,
      methodId,
      fillParams,
      paramsDwords,
      paramsPwords,
    );
    this.outstanding.push(questionId);
    return questionId;
  }

  /**
   * Wait for every outstanding call. A call-level failure marks the
   * stream failed but the window still drains fully; the first failure
   * is what finish reports.
   */
  finish(): void {
    while (this.outstanding.length > 0) this.retireOldest();
    if (this.firstFailure !== undefined) {
      throw new StreamError(`stream call ${this.firstFailure} failed`);
    }
  }

  private retireOldest(): void {
    const questionId = this.outstanding.shift();
    if (questionId === undefined) return;
    // The transport is synchronous, so one pump is enough to drain the
    // answer that is already waiting.
    this.conn.pump();
    if (!this.conn.isAnswered(questionId)) {
      this.failed = true;
      this.firstFailure ??= questionId;
      return;
    }
    if (this.conn.isFailed(questionId)) {
      this.failed = true;
      this.firstFailure ??= questionId;
    }
    this.conn.sendFinish(questionId);
  }
}
