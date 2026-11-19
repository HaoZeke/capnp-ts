/**
 * Level 2: the `Persistent` interface, and nothing more.
 *
 * Level 2 of the protocol is about capabilities that outlive a
 * connection: save one into a SturdyRef, restore it later. capnp-C++
 * implements only the interface half. `capnp/persistent.capnp` defines
 * `Persistent(SturdyRef, Owner)` with a single `save` method, and an
 * application implements it. Everything else is left to the application's
 * realm: what a SturdyRef looks like, where they are stored, and how one
 * is turned back into a capability. The restore messages the original
 * protocol drafted, `ObsoleteSave` and `ObsoleteDelete`, are answered
 * `Unimplemented` there, and here, and `Bootstrap` replaced restore.
 *
 * So this file gives what C++ gives: the interface id, a way to call
 * `save`, and a way to serve it. It does not invent a SturdyRef registry.
 */
import type { Ptr, StructBuilder } from "@haozeke/capnp";

import {
  type CallBuilder,
  type CallContext,
  type Client,
  type RpcPromise,
  type RpcServer,
} from "./capability.ts";

/** `capnp/persistent.capnp`: `interface Persistent@0xc8cb212fcd9f5691`. */
export const PERSISTENT_INTERFACE_ID = 0xc8cb212fcd9f5691n;
export const PERSISTENT_SAVE_METHOD = 0;

/**
 * Call `save` on any capability whose interface extends `Persistent`.
 * `fillSealFor` writes the `sealFor` owner into the params struct, whose
 * one pointer field it is; omit it for a Void owner. The SturdyRef is the
 * one pointer field of the results struct, `results.content.getP(0)`.
 */
export function savePersistent(
  cap: Client,
  fillSealFor?: (params: StructBuilder, caps: CallBuilder) => void,
): RpcPromise {
  return cap.call(PERSISTENT_INTERFACE_ID, PERSISTENT_SAVE_METHOD, fillSealFor, 0, 1);
}

/**
 * Serve `save` and delegate everything else. `save` receives the
 * `SaveParams` struct, whose one pointer field is `sealFor`, and the
 * `SaveResults` struct, whose one pointer field is the SturdyRef.
 */
export function servePersistent(
  inner: RpcServer,
  save: (params: Ptr, results: StructBuilder, ctx: CallContext) => void | Promise<void>,
): RpcServer {
  return {
    isStreaming: inner.isStreaming?.bind(inner),
    dispose: inner.dispose?.bind(inner),
    dispatch(interfaceId, methodId, params, results, ctx) {
      if (interfaceId === PERSISTENT_INTERFACE_ID && methodId === PERSISTENT_SAVE_METHOD) {
        return save(params, ctx.initResults(0, 1), ctx);
      }
      return inner.dispatch(interfaceId, methodId, params, results, ctx);
    },
  };
}
