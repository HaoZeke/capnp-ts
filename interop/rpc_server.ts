/**
 * TypeScript Echo server for the capnp-C++ client scenarios.
 *
 * Listens on 127.0.0.1:<argv[2]> and serves schema/interop.capnp's Echo
 * to every connection. Run it under interop/run_rpc_interop.sh, which
 * starts the C++ peer in client mode against it.
 */
import { createServer } from "node:net";

import { attach, EchoImpl } from "./rpc_common.ts";
import { ExportMap, RpcError } from "../packages/rpc/src/index.ts";

const port = Number(process.argv[2] ?? 43119);
// An optional incoming flow limit in words, as capnp-C++ `RpcSystem::setFlowLimit`.
const flowLimit = process.argv[3] === undefined ? undefined : Number(process.argv[3]);

// One main capability for every connection, as `EzRpcServer` keeps the
// interface it was constructed with. `die` shuts the process's connections.
const live = new Set<ReturnType<typeof attach>>();
const echo = new EchoImpl(() => {
  for (const conn of live) conn.abort(new RpcError("server shutting down"));
});
const restorer = new ExportMap().restore;

export function listenEcho(port: number, limit = flowLimit): ReturnType<typeof createServer> {
  const server = createServer((sock) => {
    sock.setNoDelay(true);
    const conn = attach(sock, echo, { restorer, flowLimit: limit });
    live.add(conn);
    sock.on("close", () => live.delete(conn));
  });
  server.listen(port, "127.0.0.1", () => {
    const bound = server.address();
    const n = typeof bound === "object" && bound !== null ? bound.port : port;
    console.log(`listening ${n}`);
  });
  return server;
}

if (import.meta.main) listenEcho(port);
