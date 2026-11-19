/**
 * TypeScript Echo server for the capnp-C++ client scenarios.
 *
 * Listens on 127.0.0.1:<argv[2]> and serves schema/interop.capnp's Echo
 * to every connection. Run it under interop/run_rpc_interop.sh, which
 * starts the C++ peer in client mode against it.
 */
import { createServer } from "node:net";

import { attach, EchoImpl } from "./rpc_common.ts";
import { RpcError } from "../packages/rpc/src/index.ts";

const port = Number(process.argv[2] ?? 43119);

const server = createServer((sock) => {
  sock.setNoDelay(true);
  const echo = new EchoImpl(() => conn.abort(new RpcError("server shutting down")));
  const conn = attach(sock, echo);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`listening ${port}`);
});
