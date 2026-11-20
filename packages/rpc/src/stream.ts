/**
 * A sender for `-> stream` methods on one capability.
 *
 * A thin face on `Client.callStreaming` and `Client.flush`: the flow
 * control and error propagation live in `WindowFlowController`, which the
 * capability owns, so every handle on the same capability shares one
 * window.
 */
import type { StructBuilder } from "@haozeke/capnp";

import type { CallBuilder, Client } from "./capability.ts";

export class RpcStream {
  constructor(private readonly client: Client) {}

  /**
   * Send one call. Resolves when another may be sent without running too
   * far ahead of the receiver; rejects with the failure of an earlier call.
   */
  send(
    interfaceId: bigint,
    methodId: number,
    fill?: (params: StructBuilder, caps: CallBuilder) => void,
    paramsDwords = 1,
    paramsPwords = 1,
  ): Promise<void> {
    return this.client.callStreaming(interfaceId, methodId, fill, paramsDwords, paramsPwords);
  }

  /** Resolves when everything sent has been acknowledged, even after a stream failure. */
  finish(): Promise<void> {
    return this.client.flush();
  }
}
