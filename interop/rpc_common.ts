/**
 * Glue between a node socket and an RpcConnection, and the Echo server
 * both interop directions use.
 */
import type { Socket } from "node:net";
import type { Ptr, StructBuilder } from "@haozeke/capnp";

import {
  type CallContext,
  Client,
  newBrokenCap,
  RpcConnection,
  RpcError,
  type RpcServer,
  StreamTransport,
} from "../packages/rpc/src/index.ts";
import { COUNTER_INTERFACE_ID, Echo_methods, ECHO_INTERFACE_ID } from "./interop.capnp.ts";

export { COUNTER_INTERFACE_ID, Echo_methods, ECHO_INTERFACE_ID };

export function attach(sock: Socket, bootstrap?: RpcServer | Client): RpcConnection {
  const transport = new StreamTransport((bytes) => {
    if (!sock.destroyed) sock.write(bytes);
  });
  const conn = new RpcConnection(transport, bootstrap);
  const drain = (): void => {
    try {
      conn.pump();
    } catch (e) {
      conn.abort(new RpcError(e instanceof Error ? e.message : String(e)));
      sock.destroy();
    }
  };
  sock.on("data", (chunk: Buffer) => {
    transport.feed(new Uint8Array(chunk));
    drain();
  });
  const gone = (): void => conn.disconnect(new RpcError("connection closed", "disconnected"));
  sock.on("close", gone);
  sock.on("error", gone);
  return conn;
}

export class CounterImpl implements RpcServer {
  static released = 0;
  seen: number[] = [];
  constructor(private readonly onCall?: (n: number) => void) {}
  dispatch(_i: bigint, _m: number, params: Ptr, results: StructBuilder): void {
    const n = params.getU32(0);
    this.seen.push(n);
    this.onCall?.(n);
    results.setU32(0, n + 1);
  }
  dispose(): void {
    CounterImpl.released++;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Echo interface of schema/interop.capnp. */
export class EchoImpl implements RpcServer {
  cancelled = 0;
  uncancelableDone = 0;
  private gates: Array<() => void> = [];
  private fulfillCounter: ((c: Client) => void) | undefined;
  private fulfillHeld: ((c: Client) => void) | undefined;
  private held: Client | undefined;

  constructor(private readonly onDie: () => void = () => {}) {}

  private gate(): Promise<void> {
    return new Promise((resolve) => this.gates.push(resolve));
  }

  dispatch(
    interfaceId: bigint,
    methodId: number,
    params: Ptr,
    results: StructBuilder,
    ctx: CallContext,
  ): void | Promise<void> {
    if (interfaceId !== ECHO_INTERFACE_ID) throw new RpcError("wrong interface", "unimplemented");
    const m = Echo_methods;
    switch (methodId) {
      case m.ping.ordinal:
        results.setU32(0, params.getU32(0) + 1);
        return;
      case m.makeCounter.ordinal:
        // Answered late, so a pipelined call arrives while this is pending.
        return sleep(20).then(() => {
          ctx.setResultCap(ctx.initResults(0, 1), 0, Client.local(new CounterImpl()).hook);
        });
      case m.makePromise.ordinal: {
        const promise = Client.fromPromise(
          new Promise<Client>((resolve) => (this.fulfillCounter = resolve)),
        );
        ctx.setResultCap(ctx.initResults(0, 1), 0, promise.hook);
        return;
      }
      case m.resolveLater.ordinal:
        this.fulfillCounter?.(Client.local(new CounterImpl()));
        this.fulfillCounter = undefined;
        return;
      case m.slow.ordinal:
        ctx.allowCancellation();
        ctx.signal.addEventListener("abort", () => this.cancelled++);
        return this.gate().then(() => results.setU32(0, 99));
      case m.slowUncancelable.ordinal:
        return this.gate().then(() => {
          this.uncancelableDone++;
          results.setU32(0, 99);
        });
      case m.unblock.ordinal:
        for (const open of this.gates.splice(0)) open();
        return;
      case m.stats.ordinal: {
        const r = ctx.initResults(2, 0);
        r.setU32(0, this.cancelled);
        r.setU32(4, CounterImpl.released);
        r.setU32(8, this.uncancelableDone);
        return;
      }
      case m.callBack.ordinal: {
        const cap = new Client(ctx.getCap(params.getP(0)));
        const n = params.getU32(0);
        return cap.call(COUNTER_INTERFACE_ID, 0, (p) => p.setU32(0, n)).then((out) => {
          results.setU32(0, out.content.getU32(0));
          cap.release();
        });
      }
      case m.echoCap.ordinal:
        ctx.setResultCap(ctx.initResults(0, 1), 0, ctx.getCap(params.getP(0)));
        return;
      case m.fail.ordinal:
        throw new RpcError("busy on purpose", "overloaded");
      case m.brokenCap.ordinal:
        ctx.setResultCap(
          ctx.initResults(0, 1),
          0,
          newBrokenCap(new RpcError("broken on purpose")),
        );
        return;
      case m.hold.ordinal:
        this.held?.release();
        this.held = new Client(ctx.getCap(params.getP(0)));
        return;
      case m.callHeld.ordinal: {
        const n = params.getU32(0);
        return this.held!.call(COUNTER_INTERFACE_ID, 0, (p) => p.setU32(0, n)).then((out) => {
          results.setU32(0, out.content.getU32(0));
        });
      }
      case m.promiseOfHeld.ordinal: {
        const promise = Client.fromPromise(
          new Promise<Client>((resolve) => (this.fulfillHeld = resolve)),
        );
        ctx.setResultCap(ctx.initResults(0, 1), 0, promise.hook);
        return;
      }
      case m.resolveHeld.ordinal:
        this.fulfillHeld?.(this.held!.dup());
        this.fulfillHeld = undefined;
        return;
      case m.die.ordinal:
        setImmediate(this.onDie);
        return;
      default:
        throw new RpcError(`Echo: no method ${methodId}`, "unimplemented");
    }
  }
}
