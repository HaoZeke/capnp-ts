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

const server = createServer((sock) => {
  sock.setNoDelay(true);
  const echo = new EchoImpl(() => conn.abort(new RpcError("server shutting down")));
  // capnp-C++ `EzRpcServer` answers named Bootstraps from its export map.
  const conn = attach(sock, echo, { restorer: new ExportMap().restore, flowLimit });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`listening ${port}`);
});
