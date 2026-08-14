/**
 * Live-peer RPC interop: this vat against capnp-C++.
 *
 * Bootstraps the Adder served by interop/rpc_peer_server.c++ over
 * rpc-twoparty on 127.0.0.1:<argv[2]> and calls add(), which proves
 * protocol-level compatibility with the reference implementation rather
 * than only wire-format byte equality against our own encoders.
 */
import { connect, type Socket } from "node:net";

import { RpcConnection } from "../packages/rpc/src/vat.ts";
import { StreamTransport } from "../packages/rpc/src/socket.ts";

/** Mirrors the id in schema/adder.capnp. */
const ADDER_IFACE = 0xea01e10cbc414411n;

const port = Number(process.argv[2] ?? 43117);

function dialWithRetry(attempts: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const attempt = (left: number) => {
      const sock = connect({ host: "127.0.0.1", port });
      sock.once("connect", () => resolve(sock));
      sock.once("error", (e) => {
        sock.destroy();
        // The peer may still be binding when this starts.
        if (left <= 0) reject(e);
        else setTimeout(() => attempt(left - 1), 50);
      });
    };
    attempt(attempts);
  });
}

/** Pump until `done` holds, or give up after `ms`. */
function until(done: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      if (done()) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const sock = await dialWithRetry(100);
const transport = new StreamTransport((bytes) => {
  sock.write(bytes);
});
const conn = new RpcConnection(transport);

sock.on("data", (chunk: Buffer) => {
  transport.feed(new Uint8Array(chunk));
  conn.pump();
});

const qBoot = conn.sendBootstrap();
await until(() => conn.isAnswered(qBoot));
if (conn.isFailed(qBoot)) {
  console.error("capnp-C++ did not answer the bootstrap");
  process.exit(1);
}

// The bootstrap capability lands in the peer's export table; a two-party
// server hands out id 0 for it.
const qCall = conn.sendCall(
  0,
  ADDER_IFACE,
  0,
  (params) => {
    params.setU64(0, 20n);
    params.setU64(8, 22n);
  },
  // Two Int64 arguments: two data words, no pointers.
  2,
  0,
);
await until(() => conn.isAnswered(qCall));
if (conn.isFailed(qCall)) {
  console.error("capnp-C++ returned an exception for add()");
  process.exit(1);
}

const EXPECTED = 42n;
const sum = conn.answerContent(qCall)?.getU64(0);
sock.destroy();
if (sum !== EXPECTED) {
  console.error(`add(20, 22) returned ${sum}, expected ${EXPECTED}`);
  process.exit(1);
}
console.log("All rpc interop assertions passed.");
process.exit(0);
