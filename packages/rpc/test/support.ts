import { Message as CapnpMessage } from "@haozeke/capnp";

import { Message, Message_which } from "../src/rpc.capnp.ts";
import { MemoryTransportPair, type Transport } from "../src/transport.ts";
import { RpcConnection, type Vat } from "../src/vat.ts";
import type { Client, RpcServer } from "../src/index.ts";

export const IFACE = 0x1234n;

const NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(Message).map(([name, tag]) => [tag, name]),
);

/** A transport that remembers the kind of every frame sent through it. */
export interface Tapped extends Transport {
  readonly sent: string[];
  readonly frames: Uint8Array[];
}

export function tap(inner: Transport): Tapped {
  const sent: string[] = [];
  const frames: Uint8Array[] = [];
  return {
    sent,
    frames,
    send(frame, fds) {
      frames.push(frame.slice());
      sent.push(NAMES[Message_which(CapnpMessage.fromFlat(frame).root())] ?? "?");
      inner.send(frame, fds);
    },
    receive: () => inner.receive(),
    receivedFds: inner.receivedFds ? () => inner.receivedFds!() : undefined,
    ownsReceivedFds: inner.ownsReceivedFds ? () => inner.ownsReceivedFds!() : undefined,
    closeFd: inner.closeFd ? (fd: number) => inner.closeFd!(fd) : undefined,
    get pending() {
      return inner.pending;
    },
    close: () => inner.close(),
    get closed() {
      return inner.closed;
    },
  };
}

export interface Link {
  a: RpcConnection;
  b: RpcConnection;
  ta: Tapped;
  tb: Tapped;
  /** Pump both ends, letting promise callbacks run, until nothing moves. */
  settle(): Promise<void>;
}

/** Two connected vats; `a` has `serverA` as bootstrap and `b` has `serverB`. */
export function link(
  serverA?: RpcServer | Client,
  serverB?: RpcServer | Client,
  options?: { streamWindow?: number; vat?: Vat },
): Link {
  const pair = new MemoryTransportPair();
  const ta = tap(pair.a);
  const tb = tap(pair.b);
  const a = new RpcConnection(ta, serverA, undefined, { streamWindow: options?.streamWindow });
  // Level 3 and 4 need a vat; without one, B is two-party.
  const b = new RpcConnection(tb, serverB, options?.vat);
  const settle = async (): Promise<void> => {
    for (let quiet = 0; quiet < 3; ) {
      const moved = a.pump() + b.pump();
      await new Promise((r) => setImmediate(r));
      quiet = moved === 0 ? quiet + 1 : 0;
    }
  };
  return { a, b, ta, tb, settle };
}
